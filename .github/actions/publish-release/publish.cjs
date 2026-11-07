const { readFileSync, statSync, realpathSync, accessSync, constants } = require('node:fs')
const { basename } = require('node:path')

async function publishRelease({ repository, tag, expectedSha, files, githubToken }, { fetch = globalThis.fetch } = {}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository || '') || !tag || !githubToken) throw new Error('Repository, tag and github-token are required')
  const isSha = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value) && value.length === 40
  if (!isSha(expectedSha)) throw new Error('An immutable expected-sha from the validated build is required')
  if (typeof files !== 'string' || !files.trim()) throw new Error('Exact file paths are required')
  const paths = files.trimEnd().split(/\r?\n/)
  const names = new Set()
  const resolved = new Set()
  for (const path of paths) {
    const name = basename(path)
    if (!path || !/^[\w.-]+$/.test(name)) throw new Error('Empty or unsafe asset file name')
    const real = realpathSync(path)
    const stat = statSync(real)
    if (!stat.isFile() || !stat.size) throw new Error(`Not a nonempty file: ${name}`)
    accessSync(real, constants.R_OK)
    if (names.has(name) || resolved.has(real)) throw new Error(`Duplicate file or asset name: ${name}`)
    names.add(name)
    resolved.add(real)
  }
  const headers = { authorization: `Bearer ${githubToken}`, accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28' }
  const repo = `https://api.github.com/repos/${repository}`
  const base = `${repo}/releases`
  async function get(url) {
    const response = await fetch(url, { headers, redirect: 'error' })
    if (response.status !== 200) throw new Error(`Release preflight failed: HTTP ${response.status}`)
    return response.json()
  }
  const release = await get(`${base}/tags/${encodeURIComponent(tag)}`)
  if (!Number.isSafeInteger(release.id) || release.id <= 0 || release.tag_name !== tag) throw new Error('Invalid release preflight response')
  async function checkBinding() {
    let { object } = await get(`${repo}/git/ref/tags/${encodeURIComponent(tag)}`)
    const seen = new Set()
    while (object?.type === 'tag') {
      if (!isSha(object.sha) || seen.has(object.sha)) throw new Error('Invalid or cyclic annotated tag')
      seen.add(object.sha)
      object = (await get(`${repo}/git/tags/${object.sha}`)).object
    }
    if (object?.type !== 'commit' || !isSha(object.sha) || object.sha !== expectedSha) throw new Error('Tag no longer matches the validated build SHA')
    const current = await get(`${base}/${release.id}`)
    if (current.id !== release.id || current.tag_name !== tag) throw new Error('Release ID/tag_name changed')
  }
  const existing = new Set()
  for (let page = 1; ; page++) {
    const assets = await get(`${base}/${release.id}/assets?per_page=100&page=${page}`)
    if (!Array.isArray(assets) || assets.some(asset => typeof asset.name !== 'string')) throw new Error('Invalid asset preflight response')
    for (const asset of assets) existing.add(asset.name)
    if (assets.length < 100) break
  }
  const collisions = paths.map(path => basename(path)).filter(name => existing.has(name))
  if (collisions.length) throw new Error(`Release asset already exists: ${collisions.join(', ')}`)
  const uploaded = []
  for (const path of paths) {
    const name = basename(path)
    let outcome = 'local read/network failure; server outcome unknown'
    try {
      const body = readFileSync(path)
      outcome = 'source/release binding changed or unavailable before upload; no upload request sent'
      await checkBinding()
      outcome = 'network failure; server outcome unknown'
      const response = await fetch(`https://uploads.github.com/repos/${repository}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, {
        method: 'POST', headers: { ...headers, 'content-type': 'application/octet-stream' },
        body, redirect: 'error'
      })
      outcome = `HTTP ${response.status}${response.status === 422 ? ' (possible concurrent name collision)' : ''}`
      if (response.status !== 201) throw new Error()
      const asset = await response.json()
      if (asset.name !== name || asset.state !== 'uploaded') throw new Error()
      uploaded.push(name)
      // GitHub has no atomic expected-SHA upload guard; recheck after the last upload too.
      outcome = 'source/release binding changed or unavailable after upload; uploaded bytes require inspection'
      await checkBinding()
    } catch {
      throw new Error(`Partial publication: confirmed uploads [${uploaded.join(', ')}]; failed or uncertain ${name}: ${outcome}. Inspect the release before retrying. No assets were deleted or replaced.`)
    }
  }
  return uploaded
}

module.exports = { publishRelease }
