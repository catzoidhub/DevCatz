const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { createReadStream, createWriteStream, readFileSync, lstatSync, appendFileSync, openSync, readSync, closeSync, mkdtempSync, rmSync } = require('node:fs')
const { resolve, join } = require('node:path')
const { tmpdir } = require('node:os')
const { pipeline } = require('node:stream/promises')
const { inflateRawSync } = require('node:zlib')
const yaml = require('js-yaml')
const { buildBlockMap } = require('app-builder-lib/out/targets/blockmap/blockmap')

async function validateLinuxOutputs(directory, version, { execFileSync = require('node:child_process').execFileSync } = {}) {
  assert.match(version, /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/, 'Invalid release version')
  const dir = resolve(directory)
  const names = [`DevCatz-${version}-x64.AppImage`, `DevCatz-${version}-amd64.deb`]
  const paths = [...names, 'latest-linux.yml'].map(name => join(dir, name))
  for (const path of paths) assert.ok(lstatSync(path).isFile(), `Expected regular artifact: ${path}`)
  const metadata = yaml.load(readFileSync(paths[2], 'utf8'))
  assert.equal(metadata.version, version, 'Updater version mismatch')
  assert.deepEqual(metadata.files?.map(file => file.url).sort(), [...names].sort(), 'Updater must reference exactly both Linux packages')
  for (let i = 0; i < names.length; i++) {
    const info = metadata.files.find(file => file.url === names[i])
    const hash = createHash('sha512')
    for await (const chunk of createReadStream(paths[i])) hash.update(chunk)
    assert.equal(info.sha512, hash.digest('base64'), `SHA-512 mismatch: ${names[i]}`)
    assert.equal(info.size, lstatSync(paths[i]).size, `Size mismatch: ${names[i]}`)
  }
  const primary = metadata.files.find(file => file.url === metadata.path)
  assert.ok(primary, 'Legacy updater path must reference a package')
  assert.equal(metadata.sha512, primary.sha512, 'Legacy updater hash mismatch')
  let blockmap, payloadSize
  const fd = openSync(paths[0], 'r')
  try {
    const header = Buffer.alloc(20)
    assert.equal(readSync(fd, header, 0, header.length, 0), header.length, 'Truncated AppImage')
    assert.ok(header.subarray(0, 4).equals(Buffer.from('\x7fELF', 'binary')) && header[4] === 2 && header[5] === 1 &&
      header.subarray(8, 11).equals(Buffer.from('AI\x02', 'binary')) && header.readUInt16LE(18) === 62, 'Expected an ELF64 x64 AppImage (type 2)')
    const size = lstatSync(paths[0]).size
    const footer = Buffer.alloc(4)
    readSync(fd, footer, 0, 4, size - 4)
    const blockMapSize = metadata.files.find(file => file.url === names[0]).blockMapSize
    assert.ok(Number.isSafeInteger(blockMapSize) && blockMapSize > 0 && blockMapSize < size - 24 && blockMapSize <= 16 * 1024 * 1024, 'Invalid embedded blockmap size')
    assert.equal(footer.readUInt32BE(0), blockMapSize, 'Embedded blockmap size mismatch')
    const compressed = Buffer.alloc(blockMapSize)
    readSync(fd, compressed, 0, blockMapSize, size - 4 - blockMapSize)
    blockmap = JSON.parse(inflateRawSync(compressed, { maxOutputLength: 16 * 1024 * 1024 }))
    payloadSize = size - 4 - blockMapSize
  } finally { closeSync(fd) }
  const temp = mkdtempSync(join(tmpdir(), 'devcatz-linux-blockmap-'))
  try {
    const payload = join(temp, 'payload.AppImage')
    await pipeline(createReadStream(paths[0], { start: 0, end: payloadSize - 1 }), createWriteStream(payload))
    const generated = join(temp, 'payload.blockmap')
    await buildBlockMap(payload, 'deflate', generated)
    assert.deepEqual(blockmap, JSON.parse(inflateRawSync(readFileSync(generated), { maxOutputLength: 16 * 1024 * 1024 })),
      'Embedded blockmap does not match AppImage payload')
  } finally { rmSync(temp, { recursive: true, force: true }) }
  const fields = execFileSync('dpkg-deb', ['--show', '--showformat=${Package}\n${Version}\n${Architecture}', paths[1]], { encoding: 'utf8' }).trim().split('\n')
  assert.deepEqual(fields, ['devcatz', version.replace(/-/g, '~'), 'amd64'], 'Debian package name, version or architecture mismatch')
  const contents = execFileSync('dpkg-deb', ['--contents', paths[1]], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  assert.ok(/\.\/opt\/DevCatz\/resources\/package-type$/m.test(contents) &&
    /\.\/opt\/DevCatz\/resources\/app-update.yml$/m.test(contents), 'Missing Debian updater files')
  return paths
}

module.exports = { validateLinuxOutputs }

if (require.main === module) {
  validateLinuxOutputs(process.argv[2], process.argv[3]).then(files => {
    console.log(`Validated Linux release files:\n${files.join('\n')}`)
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `files<<LINUX_RELEASE_FILES\n${files.join('\n')}\nLINUX_RELEASE_FILES\n`)
  }).catch(error => { console.error(error.message); process.exitCode = 1 })
}
