const { readFileSync, writeFileSync, appendFileSync, statSync, createReadStream, mkdtempSync, rmSync, readdirSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { createRequire } = require('node:module')
const { tmpdir } = require('node:os')
const { createHash } = require('node:crypto')
const { gunzipSync } = require('node:zlib')
const { isDeepStrictEqual } = require('node:util')

async function windowsRelease({ directory, version, refresh = false }) {
  const fromProject = createRequire(resolve('package.json'))
  const yaml = fromProject('js-yaml')
  const { buildBlockMap } = fromProject('app-builder-lib/out/targets/blockmap/blockmap')
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Invalid release version')
  const metadataPath = resolve(directory, 'latest.yml')
  const metadata = yaml.load(readFileSync(metadataPath, 'utf8'))
  if (metadata.version !== version) throw new Error('Release version mismatch')
  const installer = resolve(directory, `DevCatz-Setup-${version}.exe`)
  const name = `DevCatz-Setup-${version}.exe`
  if (metadata.path !== name || metadata.files?.length !== 1 || metadata.files[0].url !== name) throw new Error('Unexpected installer metadata paths')
  if (readdirSync(directory).filter(file => /-Setup-.*\.exe$/i.test(file)).join() !== name) throw new Error('Expected exactly one installer')
  const files = [installer, `${installer}.blockmap`, metadataPath]
  for (const file of [installer, metadataPath]) if (!statSync(file).isFile() || !statSync(file).size) throw new Error('Missing release file')
  for (const [file, machines] of [[installer, [0x14c, 0x8664]], [join(directory, 'win-unpacked', 'DevCatz.exe'), [0x8664]]]) {
    const bytes = readFileSync(file)
    const offset = bytes.length >= 64 ? bytes.readUInt32LE(0x3c) : -1
    if (bytes.toString('ascii', 0, 2) !== 'MZ' || offset < 64 || offset + 6 > bytes.length ||
        bytes.toString('ascii', offset, offset + 4) !== 'PE\0\0' || !machines.includes(bytes.readUInt16LE(offset + 4))) {
      throw new Error('Expected Windows PE installer and x64 application payload')
    }
  }
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(installer)) hash.update(chunk)
  const sha512 = hash.digest('base64')
  const size = statSync(installer).size
  if (refresh) {
    await buildBlockMap(installer, 'gzip', `${installer}.blockmap`)
    metadata.sha512 = sha512
    Object.assign(metadata.files[0], { sha512, size })
    if (metadata.size !== undefined) metadata.size = size
    writeFileSync(metadataPath, yaml.dump(metadata, { lineWidth: -1 }))
  }
  if (metadata.sha512 !== sha512 || metadata.files[0].sha512 !== sha512 || metadata.files[0].size !== size ||
      (metadata.size !== undefined && metadata.size !== size)) throw new Error('Installer hash/size does not match latest.yml')
  const temp = mkdtempSync(join(tmpdir(), 'devcatz-blockmap-'))
  try {
    const generated = join(temp, 'installer.blockmap')
    await buildBlockMap(installer, 'gzip', generated)
    const parse = file => JSON.parse(gunzipSync(readFileSync(file)))
    if (!isDeepStrictEqual(parse(`${installer}.blockmap`), parse(generated))) throw new Error('Blockmap does not match final installer')
  } finally { rmSync(temp, { recursive: true, force: true }) }
  return files
}

module.exports = { windowsRelease }

if (require.main === module) {
  const [mode, directory, version] = process.argv.slice(2)
  if (!['verify', 'refresh'].includes(mode) || !directory || !version) {
    console.error('Usage: node windows-release.cjs verify|refresh <dist directory> <validated version>')
    process.exitCode = 1
  } else windowsRelease({ directory, version, refresh: mode === 'refresh' }).then(files => {
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `files<<WINDOWS_RELEASE_FILES\n${files.join('\n')}\nWINDOWS_RELEASE_FILES\n`)
    console.log(`Validated Windows x64 release files:\n${files.join('\n')}`)
  }).catch(error => { console.error(error.message); process.exitCode = 1 })
}
