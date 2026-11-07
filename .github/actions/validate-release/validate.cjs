async function validateRelease(input, { membershipToken, githubToken, fetch = globalThis.fetch }) {
  const isSha = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value) && value.length === 40
  if (input.eventName !== 'workflow_dispatch' || input.ref !== 'refs/heads/main' || input.repository !== 'catzoidhub/DevCatz') {
    throw new Error('Manual main dispatch in catzoidhub/DevCatz required')
  }
  if (input.policyReady !== 'true') throw new Error('Runner policy must be verified and enabled first')
  if (!['github-hosted', 'self-hosted'].includes(input.runnerEnvironment)) throw new Error('Unknown runner environment')
  if (input.runnerEnvironment === 'self-hosted' && !isSha(input.expectedSha)) throw new Error('An earlier validated SHA is required on persistent hosts')
  if (typeof input.tag !== 'string' || input.tag !== input.tag.trim() || !/^v[0-9][0-9A-Za-z.+-]*$/.test(input.tag)) {
    throw new Error('An existing v-prefixed version tag is required')
  }

  async function get(path, token) {
    let response
    try {
      response = await fetch(`https://api.github.com${path}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
        redirect: 'error', signal: AbortSignal.timeout(15000)
      })
      if (!response.ok) throw new Error()
      return await response.json()
    } catch {
      throw new Error('GitHub lookup failed; release denied')
    }
  }

  if (!membershipToken || !githubToken || membershipToken === githubToken) {
    throw new Error('Dedicated membership and separate repository credentials required')
  }
  for (const actor of new Set([input.actor, input.triggeringActor])) {
    if (typeof actor !== 'string' || !/^[a-zA-Z0-9-]+$/.test(actor)) throw new Error('Missing or invalid release actor')
    const member = await get(`/orgs/catzoidhub/memberships/${actor}`, membershipToken)
    if (member.state !== 'active' || member.role !== 'admin') throw new Error('Both actors must be a current catzoidhub owner')
  }

  const repo = '/repos/catzoidhub/DevCatz'
  let { object } = await get(`${repo}/git/ref/tags/${encodeURIComponent(input.tag)}`, githubToken)
  const seen = new Set()
  while (object?.type === 'tag') {
    if (!isSha(object.sha)) throw new Error('Invalid Git object')
    if (seen.has(object.sha)) throw new Error('Cyclic annotated tag')
    seen.add(object.sha)
    const tag = await get(`${repo}/git/tags/${object.sha}`, githubToken)
    object = tag.object
  }
  if (object?.type !== 'commit' || !isSha(object.sha)) throw new Error('Invalid Git object')
  const sha = object.sha
  if (input.expectedSha && sha !== input.expectedSha) throw new Error('Tag moved since the earlier validated SHA')
  const main = await get(`${repo}/git/ref/heads/main`, githubToken)
  if (main.object?.type !== 'commit' || !isSha(main.object.sha)) throw new Error('Invalid Git object for main')
  const comparison = await get(`${repo}/compare/${sha}...${main.object.sha}`, githubToken)
  if (!['ahead', 'identical'].includes(comparison.status)) throw new Error('Tag commit must be in main history')
  const manifest = await get(`${repo}/contents/package.json?ref=${sha}`, githubToken)
  if (manifest.type !== 'file' || manifest.encoding !== 'base64' || typeof manifest.content !== 'string') {
    throw new Error('A regular base64 manifest is required')
  }
  const { version } = JSON.parse(Buffer.from(manifest.content, 'base64').toString('utf8'))
  if (typeof version !== 'string' || input.tag !== `v${version}`) throw new Error('Tag must exactly match the manifest version')
  return { sha, tag: input.tag, version }
}

module.exports = { validateRelease }
