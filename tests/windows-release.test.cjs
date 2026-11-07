const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { createHash } = require('node:crypto')
const { gzipSync, gunzipSync } = require('node:zlib')
const yaml = require('js-yaml')
const { buildBlockMap } = require('app-builder-lib/out/targets/blockmap/blockmap')
const { windowsRelease } = require('../scripts/windows-release.cjs')

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'devcatz-windows-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const name = 'DevCatz-Setup-1.1.0.exe'
  const installer = join(directory, name)
  // NSIS uses a 32-bit PE stub even when its application payload is x64.
  function pe(machine) {
    const bytes = Buffer.alloc(512)
    bytes.write('MZ')
    bytes.writeUInt32LE(128, 0x3c)
    bytes.write('PE\0\0', 128)
    bytes.writeUInt16LE(machine, 132)
    return bytes
  }
  writeFileSync(installer, pe(0x14c))
  mkdirSync(join(directory, 'win-unpacked'))
  writeFileSync(join(directory, 'win-unpacked', 'DevCatz.exe'), pe(0x8664))
  const info = await buildBlockMap(installer, 'gzip', `${installer}.blockmap`)
  const metadata = { version: '1.1.0', files: [{ url: name, ...info }], path: name, sha512: info.sha512, releaseDate: '2026-11-07T00:00:00.000Z' }
  writeFileSync(join(directory, 'latest.yml'), yaml.dump(metadata))
  return { directory, installer, metadata, info }
}

test('validates unsigned x64 NSIS outputs and returns only the exact publication files', async t => {
  const f = await fixture(t)
  assert.deepEqual(await windowsRelease({ directory: f.directory, version: '1.1.0' }), [
    f.installer, `${f.installer}.blockmap`, join(f.directory, 'latest.yml')
  ])
  assert.equal(readFileSync(join(f.directory, 'latest.yml'), 'utf8'), yaml.dump(f.metadata))
})

test('rejects wrong versions, names, metadata hashes/sizes, stale blockmaps and non-x64 application payloads', async t => {
  for (const mutation of [
    f => { f.metadata.version = '1.0.0' },
    f => { f.metadata.path = 'other.exe' },
    f => { f.metadata.files[0].url = '../other.exe' },
    f => { f.metadata.sha512 = 'wrong' },
    f => { f.metadata.files[0].sha512 = 'wrong' },
    f => { f.metadata.files[0].size++ },
    f => { f.metadata.files.push(f.metadata.files[0]) },
    f => { writeFileSync(f.installer, Buffer.concat([readFileSync(f.installer), Buffer.from('signature')])) },
    f => {
      const blockmap = JSON.parse(gunzipSync(readFileSync(`${f.installer}.blockmap`)))
      blockmap.files[0].checksums[0] = 'stale'
      writeFileSync(`${f.installer}.blockmap`, gzipSync(JSON.stringify(blockmap)))
    },
    f => {
      const path = join(f.directory, 'win-unpacked', 'DevCatz.exe')
      const bytes = readFileSync(path)
      bytes.writeUInt16LE(0x14c, 132)
      writeFileSync(path, bytes)
    }
  ]) {
    const f = await fixture(t)
    mutation(f)
    writeFileSync(join(f.directory, 'latest.yml'), yaml.dump(f.metadata))
    await assert.rejects(windowsRelease({ directory: f.directory, version: '1.1.0' }))
  }
})

test('after signing, refreshes metadata and blockmap from the final installer bytes', async t => {
  const f = await fixture(t)
  const unsignedMap = readFileSync(`${f.installer}.blockmap`)
  const signedBytes = Buffer.concat([readFileSync(f.installer), Buffer.from('signed fixture bytes')])
  writeFileSync(f.installer, signedBytes)
  await windowsRelease({ directory: f.directory, version: '1.1.0', refresh: true })
  const metadata = yaml.load(readFileSync(join(f.directory, 'latest.yml'), 'utf8'))
  assert.equal(metadata.files[0].size, signedBytes.length)
  assert.equal(metadata.sha512, createHash('sha512').update(signedBytes).digest('base64'))
  assert.equal(metadata.files[0].sha512, metadata.sha512)
  assert.equal(metadata.releaseDate, f.metadata.releaseDate)
  const map = JSON.parse(gunzipSync(readFileSync(`${f.installer}.blockmap`)))
  assert.equal(map.files[0].sizes.reduce((a, b) => a + b, 0), signedBytes.length)
  assert.notDeepEqual(readFileSync(`${f.installer}.blockmap`), unsignedMap)
  await windowsRelease({ directory: f.directory, version: '1.1.0' })
})
