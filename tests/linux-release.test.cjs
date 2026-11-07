const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, writeFileSync, rmSync, renameSync, symlinkSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { createHash } = require('node:crypto')
const { deflateRawSync } = require('node:zlib')
const yaml = require('js-yaml')
const { validateLinuxOutputs } = require('../.github/linux-release/validate.cjs')

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'devcatz-linux-release-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const header = Buffer.alloc(64)
  header.write('\x7fELF', 0, 'binary')
  header[4] = 2 // ELF64
  header[5] = 1 // little endian
  header.write('AI\x02', 8, 'binary')
  header.writeUInt16LE(62, 18) // EM_X86_64
  const blockmap = deflateRawSync(Buffer.from(JSON.stringify({ version: '2', files: [
    { name: 'file', offset: 0, checksums: ['fixture'], sizes: [64] }
  ] })))
  const footer = Buffer.alloc(4)
  footer.writeUInt32BE(blockmap.length)
  const appImage = Buffer.concat([header, blockmap, footer])
  const deb = Buffer.from('!<arch>\nfixture deb: inspected by dpkg-deb at the command boundary')
  const names = ['DevCatz-1.1.0-x64.AppImage', 'DevCatz-1.1.0-amd64.deb', 'latest-linux.yml']
  writeFileSync(join(dir, names[0]), appImage)
  writeFileSync(join(dir, names[1]), deb)
  const files = [appImage, deb].map((bytes, i) => ({
    url: names[i], sha512: createHash('sha512').update(bytes).digest('base64'), size: bytes.length,
    ...(i === 0 ? { blockMapSize: blockmap.length } : {})
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
  return { dir, names, appImage, metadata, save, execFileSync }
}

test('an x64 AppImage, amd64 Debian package and matching updater metadata yield only exact publication paths', async t => {
  const f = fixture(t)
  assert.deepEqual(await validateLinuxOutputs(f.dir, '1.1.0', { execFileSync: f.execFileSync }),
    f.names.map(name => join(f.dir, name)))
})

test('renaming an ARM AppImage to x64 cannot pass even with consistent hashes', async t => {
  const f = fixture(t)
  f.appImage.writeUInt16LE(183, 18) // EM_AARCH64
  writeFileSync(join(f.dir, f.names[0]), f.appImage)
  f.metadata.files[0].sha512 = createHash('sha512').update(f.appImage).digest('base64')
  f.metadata.sha512 = f.metadata.files[0].sha512
  f.save()
  await assert.rejects(validateLinuxOutputs(f.dir, '1.1.0', { execFileSync: f.execFileSync }), /x64 AppImage/)
})

test('an AppImage without its declared embedded updater blockmap is rejected', async t => {
  const f = fixture(t)
  f.metadata.files[0].blockMapSize++
  f.save()
  await assert.rejects(validateLinuxOutputs(f.dir, '1.1.0', { execFileSync: f.execFileSync }), /blockmap/)
})

test('a Debian package missing updater installation identity is rejected', async t => {
  const f = fixture(t)
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
    const f = fixture(t)
    change(f)
    await assert.rejects(validateLinuxOutputs(f.dir, '1.1.0', { execFileSync: f.execFileSync }), error)
  })
})

test('wrong Debian architecture and unavailable package inspection fail closed', async t => {
  const f = fixture(t)
  await assert.rejects(validateLinuxOutputs(f.dir, '1.1.0', { execFileSync: () => 'devcatz\n1.1.0\narm64' }), /architecture mismatch/)
  await assert.rejects(validateLinuxOutputs(f.dir, '1.1.0', { execFileSync: () => { throw new Error('dpkg-deb failed') } }), /dpkg-deb failed/)
})

test('a corrupt embedded blockmap fails even when the package hash matches', async t => {
  const f = fixture(t)
  f.appImage.fill(0, 64, f.appImage.length - 4)
  writeFileSync(join(f.dir, f.names[0]), f.appImage)
  f.metadata.files[0].sha512 = createHash('sha512').update(f.appImage).digest('base64')
  f.metadata.sha512 = f.metadata.files[0].sha512
  f.save()
  await assert.rejects(validateLinuxOutputs(f.dir, '1.1.0', { execFileSync: f.execFileSync }))
})
