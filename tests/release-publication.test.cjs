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
    if (url.includes('/git/ref/tags/')) return Response.json({ object: { type: 'commit', sha: 'a'.repeat(40) } })
    if (url.includes('/releases/tags/') || url.endsWith('/releases/7')) return Response.json({ id: 7, tag_name: 'v1.1.0' })
    if (url.startsWith('https://api.github.com/') && url.includes('/assets?')) return Response.json([...assets.keys()].map(name => ({ name })))
    if (url.startsWith('https://uploads.github.com/') && options.method === 'POST') {
      const name = new URL(url).searchParams.get('name')
      if (assets.has(name)) return Response.json({}, { status: 422 })
      assets.set(name, Buffer.from(options.body).toString())
      return Response.json({ name, state: 'uploaded' }, { status: 201 })
    }
    throw new Error(`Unexpected request: ${url}`)
  }
  return { input: { repository: 'catzoidhub/DevCatz', tag: 'v1.1.0', expectedSha: 'a'.repeat(40), files: paths.join('\n'), githubToken: 'test-token' },
    paths, assets, requests, fetch }
}

test('a tag moved after build validation cannot receive any retained files', async t => {
  const f = fixture(t)
  const fetch = (url, options) => url.includes('/git/ref/tags/')
    ? Promise.resolve(Response.json({ object: { type: 'commit', sha: 'b'.repeat(40) } })) : f.fetch(url, options)
  await assert.rejects(publishRelease(f.input, { fetch }), /binding.*before upload/i)
  assert.equal(f.assets.size, 0)
})

test('a retargeted, replaced or deleted release after asset preflight receives no files', async t => {
  for (const release of [{ id: 7, tag_name: 'v2.0.0' }, { id: 8, tag_name: 'v1.1.0' }, null]) {
    const f = fixture(t)
    const fetch = (url, options) => url.endsWith('/releases/7')
      ? Promise.resolve(Response.json(release, { status: release ? 200 : 404 })) : f.fetch(url, options)
    await assert.rejects(publishRelease(f.input, { fetch }), /binding.*before upload/i)
    assert.equal(f.assets.size, 0)
  }
})

test('publication requires the validated immutable SHA before any API request', async t => {
  const f = fixture(t)
  for (const expectedSha of [undefined, '', 'main', 'a'.repeat(39), `${'a'.repeat(40)}\n`]) {
    await assert.rejects(publishRelease({ ...f.input, expectedSha }, { fetch: f.fetch }), /immutable expected-sha/)
  }
  assert.equal(f.requests.length, 0)
})

test('publication peels annotated tags and rejects malformed or cyclic Git objects', async t => {
  const f = fixture(t)
  const fetch = (url, options) => url.includes('/git/ref/tags/')
    ? Promise.resolve(Response.json({ object: { type: 'tag', sha: 'c'.repeat(40) } }))
    : url.includes('/git/tags/') ? Promise.resolve(Response.json({ object: { type: 'commit', sha: f.input.expectedSha } }))
      : f.fetch(url, options)
  assert.equal((await publishRelease(f.input, { fetch })).length, 2)
  for (const object of [{ type: 'tag', sha: 'c'.repeat(40) }, { type: 'tree', sha: f.input.expectedSha },
    { type: 'commit', sha: 'invalid' }, {}]) {
    const bad = fixture(t)
    await assert.rejects(publishRelease(bad.input, { fetch: (url, options) => url.includes('/git/')
      ? Promise.resolve(Response.json({ object })) : bad.fetch(url, options) }), /binding.*before upload/i)
    assert.equal(bad.assets.size, 0)
  }
})

test('source or release drift during any upload reports confirmed assets, including the final upload', async t => {
  for (const drift of ['tag', 'release']) for (const upload of [1, 2, 3]) {
    const f = fixture(t, ['package.AppImage', 'package.deb', 'latest-linux.yml'])
    let changed = false
    const fetch = async (url, options) => {
      if (changed && drift === 'tag' && url.includes('/git/ref/tags/')) {
        return Response.json({ object: { type: 'commit', sha: 'b'.repeat(40) } })
      }
      if (changed && drift === 'release' && url.endsWith('/releases/7')) return Response.json({ id: 7, tag_name: 'v2.0.0' })
      const response = await f.fetch(url, options)
      if (options?.method === 'POST' && f.assets.size === upload) changed = true
      return response
    }
    await assert.rejects(publishRelease(f.input, { fetch }), error => {
      assert.match(error.message, /Partial publication.*binding.*after upload/)
      for (const name of [...f.assets.keys()]) assert(error.message.includes(name))
      return true
    })
    assert.equal(f.assets.size, upload)
    assert.deepEqual([...f.assets.values()], ['asset 0', 'asset 1', 'asset 2'].slice(0, upload))
    assert(f.requests.every(([, method]) => ['GET', 'POST'].includes(method)))
  }
})

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
  for (const endpoint of ['/releases?', '/assets?']) {
    const f = fixture(t)
    const fetch = (url, options) => url.includes(endpoint) || (endpoint === '/releases?' && url.includes('/tags/'))
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


test('finds an existing draft by exact tag across release pages when the published-tag endpoint returns 404', async t => {
  const f = fixture(t)
  const pages = []
  const fetch = (url, options) => {
    if (url.includes('/releases/tags/')) return Promise.resolve(Response.json({}, { status: 404 }))
    if (url.includes('/releases?')) {
      const page = Number(new URL(url).searchParams.get('page'))
      pages.push(page)
      return Promise.resolve(Response.json(page === 1
        ? Array.from({ length: 100 }, (_, i) => ({ id: i + 100, tag_name: `vother-${i}` }))
        : [{ id: 7, tag_name: 'v1.1.0', draft: true }]))
    }
    return f.fetch(url, options)
  }
  assert.deepEqual(await publishRelease(f.input, { fetch }), ['DevCatz-Setup-1.1.0.exe', 'latest.yml'])
  assert.deepEqual(pages, [1, 2])
})

test('missing or inaccessible drafts and malformed release lists fail before uploading', async t => {
  for (const body of [[], {}, [null, { tag_name: 'other' }]]) {
    const f = fixture(t)
    const fetch = (url, options) => url.includes('/releases/tags/')
      ? Promise.resolve(Response.json({}, { status: 404 }))
      : url.includes('/releases?') ? Promise.resolve(Response.json(body)) : f.fetch(url, options)
    await assert.rejects(publishRelease(f.input, { fetch }), /preflight/i)
    assert.equal(f.assets.size, 0)
  }
})


test('malformed successful by-tag responses never fall back to a draft or upload', async t => {
  for (const body of [null, false, 0, '']) {
    const f = fixture(t)
    let listed = false
    const fetch = (url, options) => {
      if (url.includes('/releases/tags/')) return Promise.resolve(Response.json(body))
      if (url.includes('/releases?')) {
        listed = true
        return Promise.resolve(Response.json([{ id: 7, tag_name: 'v1.1.0', draft: true }]))
      }
      return f.fetch(url, options)
    }
    await assert.rejects(publishRelease(f.input, { fetch }), /Invalid release preflight response/)
    assert.equal(listed, false)
    assert.equal(f.assets.size, 0)
  }
})
