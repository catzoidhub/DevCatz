const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, readFileSync, writeFileSync, rmSync, renameSync, symlinkSync, readdirSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { createHash } = require('node:crypto')
const { deflateRawSync, inflateRawSync } = require('node:zlib')
const { spawnSync } = require('node:child_process')
const yaml = require('js-yaml')
const { buildBlockMap } = require('app-builder-lib/out/targets/blockmap/blockmap')
const { validateLinuxOutputs } = require('../.github/linux-release/validate.cjs')

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'devcatz-linux-release-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const header = Buffer.alloc(96 * 1024)
  header.write('\x7fELF', 0, 'binary')
  header[4] = 2 // ELF64
  header[5] = 1 // little endian
  header.write('AI\x02', 8, 'binary')
  header.writeUInt16LE(62, 18) // EM_X86_64
  const deb = Buffer.from('!<arch>\nfixture deb: inspected by dpkg-deb at the command boundary')
  const names = ['DevCatz-1.1.0-x64.AppImage', 'DevCatz-1.1.0-amd64.deb', 'latest-linux.yml']
  writeFileSync(join(dir, names[0]), header)
  const { blockMapSize } = await buildBlockMap(join(dir, names[0]), 'deflate')
  const appImage = readFileSync(join(dir, names[0]))
  writeFileSync(join(dir, names[1]), deb)
  const files = [appImage, deb].map((bytes, i) => ({
    url: names[i], sha512: createHash('sha512').update(bytes).digest('base64'), size: bytes.length,
    ...(i === 0 ? { blockMapSize } : {})
  }))
  const metadata = { version: '1.1.0', files, path: names[0], sha512: files[0].sha512 }
  const save = () => writeFileSync(join(dir, names[2]), yaml.dump(metadata))
  save()
  const execFileSync = (command, args) => {
    assert.equal(command, 'dpkg-deb')
    assert.equal(args.at(-1), join(dir, names[1]))
    if (args[0] === '--show') return 'devcatz\n1.1.0\namd64'
    assert.equal(args[0], '--contents')
    return './opt/DevCatz/resources/package-type\n./opt/DevCatz/resources/app-update.yml\n'
  }
  const saveAppImage = bytes => {
    writeFileSync(join(dir, names[0]), bytes)
    metadata.files[0].sha512 = createHash('sha512').update(bytes).digest('base64')
    metadata.files[0].size = bytes.length
    metadata.sha512 = metadata.files[0].sha512
    metadata.files[0].blockMapSize = bytes.readUInt32BE(bytes.length - 4)
    save()
  }
  const replaceBlockmap = map => {
    const compressed = deflateRawSync(Buffer.from(JSON.stringify(map)))
    const footer = Buffer.alloc(4)
    footer.writeUInt32BE(compressed.length)
    saveAppImage(Buffer.concat([header, compressed, footer]))
  }
  return { dir, names, appImage, metadata, save, saveAppImage, replaceBlockmap, execFileSync }
}

test('an x64 AppImage, amd64 Debian package and matching updater metadata yield only exact publication paths', async t => {
  const f = await fixture(t)
  assert.deepEqual(await validateLinuxOutputs(f.dir, '1.1.0', { execFileSync: f.execFileSync }),
    f.names.map(name => join(f.dir, name)))
})

test('renaming an ARM AppImage to x64 cannot pass even with consistent hashes', async t => {
  const f = await fixture(t)
  f.appImage.writeUInt16LE(183, 18) // EM_AARCH64
  writeFileSync(join(f.dir, f.names[0]), f.appImage)
  f.metadata.files[0].sha512 = createHash('sha512').update(f.appImage).digest('base64')
  f.metadata.sha512 = f.metadata.files[0].sha512
  f.save()
  await assert.rejects(validateLinuxOutputs(f.dir, '1.1.0', { execFileSync: f.execFileSync }), /x64 AppImage/)
})

test('an AppImage without its declared embedded updater blockmap is rejected', async t => {
  const f = await fixture(t)
  f.metadata.files[0].blockMapSize++
  f.save()
  await assert.rejects(validateLinuxOutputs(f.dir, '1.1.0', { execFileSync: f.execFileSync }), /blockmap/)
})

test('a decompressible blockmap with no usable chunks fails even with matching package hashes', async t => {
  const f = await fixture(t)
  f.replaceBlockmap({ version: '2', files: [{}] })
  await assert.rejects(validateLinuxOutputs(f.dir, '1.1.0', { execFileSync: f.execFileSync }), /blockmap.*payload/i)
})

test('chunk offsets, coverage, sizes and checksums must match the authoritative payload blockmap', async t => {
  for (const mutate of [
    map => { map.files[0].offset++ },
    map => { map.files[0].sizes.pop(); map.files[0].checksums.pop() },
    map => { map.files[0].sizes[0]++ },
    map => { map.files[0].sizes[0] = -1 },
    map => { map.files[0].checksums.pop() },
    map => { map.files[0].checksums[0] = 'not-a-chunk-checksum' }
  ]) {
    const f = await fixture(t)
    const size = f.metadata.files[0].blockMapSize
    const map = JSON.parse(inflateRawSync(f.appImage.subarray(-4 - size, -4)))
    assert(map.files[0].sizes.length > 1)
    mutate(map)
    f.replaceBlockmap(map)
    await assert.rejects(validateLinuxOutputs(f.dir, '1.1.0', { execFileSync: f.execFileSync }), /blockmap.*payload/i)
  }
})

test('a well-formed blockmap from stale payload bytes fails even after updating all outer hashes', async t => {
  const f = await fixture(t)
  f.appImage[4096] ^= 0xff
  f.saveAppImage(f.appImage)
  await assert.rejects(validateLinuxOutputs(f.dir, '1.1.0', { execFileSync: f.execFileSync }), /blockmap.*payload/i)
})

test('the CLI cleans temporary payloads after blockmap validation succeeds or fails', async t => {
  const f = await fixture(t)
  for (const malformed of [false, true]) {
    if (malformed) f.replaceBlockmap({ version: '2', files: [{}] })
    const result = spawnSync(process.execPath, [join(__dirname, '../.github/linux-release/validate.cjs'), f.dir, '1.1.0'], {
      env: { ...process.env, TMPDIR: f.dir, TEMP: f.dir, TMP: f.dir, GITHUB_OUTPUT: '' }, encoding: 'utf8'
    })
    // Native Debian inspection is unavailable for this synthetic package; blockmap validation runs first.
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, malformed ? /blockmap.*payload/i : /dpkg-deb/)
    assert.deepEqual(readdirSync(f.dir).sort(), [...f.names].sort())
  }
})

test('a Debian package missing updater installation identity is rejected', async t => {
  const f = await fixture(t)
  await assert.rejects(validateLinuxOutputs(f.dir, '1.1.0', {
    execFileSync: (command, args) => args[0] === '--contents' ? './opt/DevCatz/devcatz\n' : f.execFileSync(command, args)
  }), /Debian updater files/)
})

test('missing files, substituted paths, version, hash and size mismatches fail before publication', async t => {
  for (const [name, change, error] of [
    ['missing package', f => rmSync(join(f.dir, f.names[1])), /ENOENT/],
    ['wrong version', f => { f.metadata.version = '1.0.0'; f.save() }, /version mismatch/],
    ['unsafe URL', f => { f.metadata.files[0].url = '../elsewhere.AppImage'; f.save() }, /exactly both/],
    ['omitted Debian update', f => { f.metadata.files.pop(); f.save() }, /exactly both/],
    ['corrupt hash', f => { f.metadata.files[0].sha512 = 'wrong'; f.save() }, /SHA-512/],
    ['wrong size', f => { f.metadata.files[1].size++; f.save() }, /Size mismatch/],
    ['legacy mismatch', f => { f.metadata.sha512 = 'wrong'; f.save() }, /Legacy updater hash/],
    ['symlink', f => {
      renameSync(join(f.dir, f.names[0]), join(f.dir, 'elsewhere'))
      symlinkSync(join(f.dir, 'elsewhere'), join(f.dir, f.names[0]))
    }, /regular artifact/]
  ]) await t.test(name, async t => {
    const f = await fixture(t)
    change(f)
    await assert.rejects(validateLinuxOutputs(f.dir, '1.1.0', { execFileSync: f.execFileSync }), error)
  })
})

test('wrong Debian architecture and unavailable package inspection fail closed', async t => {
  const f = await fixture(t)
  await assert.rejects(validateLinuxOutputs(f.dir, '1.1.0', { execFileSync: () => 'devcatz\n1.1.0\narm64' }), /architecture mismatch/)
  await assert.rejects(validateLinuxOutputs(f.dir, '1.1.0', { execFileSync: () => { throw new Error('dpkg-deb failed') } }), /dpkg-deb failed/)
})

test('a corrupt embedded blockmap fails even when the package hash matches', async t => {
  const f = await fixture(t)
  f.appImage.fill(0, 64, f.appImage.length - 4)
  writeFileSync(join(f.dir, f.names[0]), f.appImage)
  f.metadata.files[0].sha512 = createHash('sha512').update(f.appImage).digest('base64')
  f.metadata.sha512 = f.metadata.files[0].sha512
  f.save()
  await assert.rejects(validateLinuxOutputs(f.dir, '1.1.0', { execFileSync: f.execFileSync }))
})
