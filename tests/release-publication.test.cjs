const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { publishRelease } = require('../.github/actions/publish-release/publish.cjs')

function fixture(t, names = ['DevCatz-Setup-1.1.0.exe', 'latest.yml']) {
  const dir = mkdtempSync(join(tmpdir(), 'devcatz-publication-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const paths = names.map(name => join(dir, name))
  paths.forEach((path, i) => writeFileSync(path, `asset ${i}`))
  const assets = new Map()
  const requests = []
  const fetch = async (url, options = {}) => {
    requests.push([url, options.method || 'GET'])
    if (url.includes('/tags/')) return Response.json({ id: 7 })
    if (url.startsWith('https://api.github.com/') && url.includes('/assets?')) return Response.json([...assets.keys()].map(name => ({ name })))
    if (url.startsWith('https://uploads.github.com/') && options.method === 'POST') {
      const name = new URL(url).searchParams.get('name')
      if (assets.has(name)) return Response.json({}, { status: 422 })
      assets.set(name, Buffer.from(options.body).toString())
      return Response.json({ name, state: 'uploaded' }, { status: 201 })
    }
    throw new Error(`Unexpected request: ${url}`)
  }
  return { input: { repository: 'catzoidhub/DevCatz', tag: 'v1.1.0', files: paths.join('\n'), githubToken: 'test-token' },
    paths, assets, requests, fetch }
}

test('publishes exact retained files to an existing release without changing other assets', async t => {
  const f = fixture(t)
  f.assets.set('linux.AppImage', 'existing bytes')
  assert.deepEqual(await publishRelease(f.input, { fetch: f.fetch }), ['DevCatz-Setup-1.1.0.exe', 'latest.yml'])
  assert.deepEqual([...f.assets.entries()], [
    ['linux.AppImage', 'existing bytes'], ['DevCatz-Setup-1.1.0.exe', 'asset 0'], ['latest.yml', 'asset 1']
  ])
  assert(f.requests.every(([, method]) => ['GET', 'POST'].includes(method)))
})

test('preflights every asset page before uploading any Windows or Linux file', async t => {
  const f = fixture(t, ['DevCatz-1.1.0-x64.AppImage', 'devcatz_1.1.0_amd64.deb', 'latest-linux.yml'])
  f.assets.set('latest-linux.yml', 'original metadata')
  const fetch = async (url, options) => {
    if (url.includes('/assets?')) {
      f.requests.push([url, 'GET'])
      return Response.json(new URL(url).searchParams.get('page') === '1'
        ? Array.from({ length: 100 }, (_, i) => ({ name: `other-${i}` })) : [{ name: 'latest-linux.yml' }])
    }
    return f.fetch(url, options)
  }
  await assert.rejects(publishRelease(f.input, { fetch }), /already exists.*latest-linux.yml/)
  assert(f.requests.some(([url]) => url.includes('page=2')))
  assert(f.requests.every(([, method]) => method === 'GET'))
  assert.deepEqual([...f.assets.entries()], [['latest-linux.yml', 'original metadata']])
})

test('missing release or failed asset lookup fails closed without uploads', async t => {
  for (const endpoint of ['/tags/', '/assets?']) {
    const f = fixture(t)
    const fetch = (url, options) => url.includes(endpoint)
      ? Promise.resolve(Response.json({ message: 'private API details' }, { status: 404 })) : f.fetch(url, options)
    await assert.rejects(publishRelease(f.input, { fetch }), /preflight.*HTTP 404/)
    assert.equal(f.assets.size, 0)
  }
})

test('empty, missing, duplicate and ambiguous local files fail before any upload', async t => {
  const f = fixture(t)
  const empty = join(f.paths[0], '..', 'empty')
  writeFileSync(empty, '')
  for (const files of ['', `${f.paths[0]}\n${empty}`, `${f.paths[0]}\n${empty}-missing`,
    `${f.paths[0]}\n${f.paths[0]}`, `${f.paths[0]}\n\n${f.paths[1]}`, `${f.paths[0]}\n${empty}/..`]) {
    await assert.rejects(publishRelease({ ...f.input, files }, { fetch: f.fetch }))
    assert.equal(f.assets.size, 0)
  }
})

test('a concurrent 422 or later failure reports partial publication and preserves existing bytes', async t => {
  for (const status of [422, 502, 'network']) {
    const f = fixture(t)
    const fetch = async (url, options) => {
      if (url.startsWith('https://uploads.github.com/') && url.includes('name=latest.yml')) {
        if (status === 'network') throw new Error('connection reset')
        if (status === 422) f.assets.set('latest.yml', 'concurrent bytes')
        return Response.json({}, { status })
      }
      return f.fetch(url, options)
    }
    await assert.rejects(publishRelease(f.input, { fetch }), /Partial publication.*DevCatz-Setup-1.1.0.exe.*latest.yml.*No assets were deleted or replaced/)
    assert.equal(f.assets.get('DevCatz-Setup-1.1.0.exe'), 'asset 0')
    if (status === 422) assert.equal(f.assets.get('latest.yml'), 'concurrent bytes')
    assert(f.requests.every(([, method]) => ['GET', 'POST'].includes(method)))
  }
})

test('rejects duplicate basenames from different directories and malformed API responses', async t => {
  const f = fixture(t)
  const other = join(f.paths[0], '..', 'other')
  mkdirSync(other)
  const duplicate = join(other, 'latest.yml')
  writeFileSync(duplicate, 'different bytes')
  await assert.rejects(publishRelease({ ...f.input, files: `${f.paths[1]}\n${duplicate}` }, { fetch: f.fetch }), /Duplicate/)
  for (const [endpoint, body] of [['/tags/', {}], ['/assets?', {}], ['/assets?', [{}]]]) {
    await assert.rejects(publishRelease(f.input, { fetch: (url, options) => url.includes(endpoint)
      ? Promise.resolve(Response.json(body)) : f.fetch(url, options) }), /Invalid.*preflight response/)
  }
  assert.equal(f.assets.size, 0)
})

test('publishes the same exact-file contract for Linux package names', async t => {
  const f = fixture(t, ['DevCatz-1.1.0-x64.AppImage', 'devcatz_1.1.0_amd64.deb', 'latest-linux.yml'])
  assert.deepEqual(await publishRelease(f.input, { fetch: f.fetch }), ['DevCatz-1.1.0-x64.AppImage', 'devcatz_1.1.0_amd64.deb', 'latest-linux.yml'])
  assert.equal(f.assets.size, 3)
})
