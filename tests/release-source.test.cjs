const { test } = require('node:test')
const assert = require('node:assert/strict')
const { validateRelease } = require('../.github/actions/validate-release/validate.cjs')

const sourceSha = '1111111111111111111111111111111111111111'
const mainSha = '2222222222222222222222222222222222222222'
const dispatch = {
  eventName: 'workflow_dispatch', ref: 'refs/heads/main', repository: 'catzoidhub/DevCatz',
  actor: 'initial-owner', triggeringActor: 'rerun-owner', tag: 'v1.1.0',
  runnerEnvironment: 'github-hosted', policyReady: 'true'
}

function apiFixture(overrides = {}) {
  const routes = {
    '/orgs/catzoidhub/memberships/initial-owner': { state: 'active', role: 'admin' },
    '/orgs/catzoidhub/memberships/rerun-owner': { state: 'active', role: 'admin' },
    '/repos/catzoidhub/DevCatz/git/ref/tags/v1.1.0': { object: { type: 'commit', sha: sourceSha } },
    '/repos/catzoidhub/DevCatz/git/ref/heads/main': { object: { type: 'commit', sha: mainSha } },
    [`/repos/catzoidhub/DevCatz/compare/${sourceSha}...${mainSha}`]: { status: 'ahead' },
    [`/repos/catzoidhub/DevCatz/contents/package.json?ref=${sourceSha}`]: {
      type: 'file', encoding: 'base64', content: Buffer.from('{"version":"1.1.0"}').toString('base64')
    },
    ...overrides
  }
  return {
    membershipToken: 'membership-only', githubToken: 'repository-only',
    fetch: async (url, options) => {
      const path = url.replace('https://api.github.com', '')
      assert.equal(options.headers.Authorization, path.startsWith('/orgs/')
        ? 'Bearer membership-only' : 'Bearer repository-only')
      assert.ok(Object.hasOwn(routes, path), `Unexpected API request: ${path}`)
      const data = routes[path]
      if (data instanceof Error) throw data
      return { ok: typeof data !== 'number', status: typeof data === 'number' ? data : 200, json: async () => data }
    }
  }
}

test('a repository admin who is not a current organization owner cannot rerun a release', async () => {
  await assert.rejects(validateRelease(dispatch, apiFixture({
    '/orgs/catzoidhub/memberships/rerun-owner': { state: 'active', role: 'member' }
  })), /current catzoidhub owner/)
})

test('owners selecting an existing main-history tag receive the immutable manifest-matching commit', async () => {
  assert.deepEqual(await validateRelease(dispatch, apiFixture()), { sha: sourceSha, tag: 'v1.1.0', version: '1.1.0' })
})

test('only main manual dispatch in this repository is accepted, with explicitly enabled platform restrictions', async () => {
  for (const input of [
    { eventName: 'push' }, { ref: 'refs/tags/main' }, { ref: 'refs/heads/other' },
    { repository: 'fork/DevCatz' }, { policyReady: '' }, { policyReady: 'false' },
    { tag: '1.1.0' }, { tag: 'v1.1.0\n' }, { tag: 'v1.1.0/other' }
  ]) {
    await assert.rejects(validateRelease({ ...dispatch, ...input }, apiFixture()), /Manual main dispatch|Runner policy|v-prefixed/)
  }
})

test('annotated release tags are peeled to their commit before ancestry and manifest checks', async () => {
  const tagSha = '3333333333333333333333333333333333333333'
  assert.equal((await validateRelease(dispatch, apiFixture({
    '/repos/catzoidhub/DevCatz/git/ref/tags/v1.1.0': { object: { type: 'tag', sha: tagSha } },
    [`/repos/catzoidhub/DevCatz/git/tags/${tagSha}`]: { object: { type: 'commit', sha: sourceSha } }
  }))).sha, sourceSha)
})

test('persistent jobs must revalidate the earlier immutable SHA, including failed-job reruns', async () => {
  for (const expectedSha of ['', mainSha, 'main']) {
    await assert.rejects(validateRelease({ ...dispatch, runnerEnvironment: 'self-hosted', expectedSha }, apiFixture()), /validated SHA/)
  }
  const input = { ...dispatch, runnerEnvironment: 'self-hosted', expectedSha: sourceSha }
  assert.equal((await validateRelease(input, apiFixture())).sha, sourceSha)
  await assert.rejects(validateRelease(input, apiFixture({
    '/orgs/catzoidhub/memberships/rerun-owner': { state: 'active', role: 'member' }
  })), /current catzoidhub owner/)
})

test('invalid Git objects and non-file manifests never become build sources', async () => {
  for (const object of [
    { type: 'tree', sha: sourceSha }, { type: 'commit', sha: 'main' },
    { type: 'commit', sha: sourceSha + '\n' }, { type: 'tag', sha: '../heads/main' }
  ]) {
    await assert.rejects(validateRelease(dispatch, apiFixture({
      '/repos/catzoidhub/DevCatz/git/ref/tags/v1.1.0': { object }
    })), /Invalid Git object/)
  }
  await assert.rejects(validateRelease(dispatch, apiFixture({
    [`/repos/catzoidhub/DevCatz/contents/package.json?ref=${sourceSha}`]: {
      type: 'symlink', encoding: 'base64', content: Buffer.from('{"version":"1.1.0"}').toString('base64')
    }
  })), /regular base64 manifest/)
})

test('initial owners must still be active owners at execution time', async () => {
  for (const member of [{ state: 'pending', role: 'admin' }, { state: 'active', role: 'member' }, {}]) {
    await assert.rejects(validateRelease(dispatch, apiFixture({
      '/orgs/catzoidhub/memberships/initial-owner': member
    })), /current catzoidhub owner/)
  }
})

test('membership failures, unavailable credentials and missing actors fail closed without leaking API errors', async () => {
  for (const failure of [401, 403, 404, 429, 500, new Error('private-token-must-not-appear')]) {
    await assert.rejects(validateRelease(dispatch, apiFixture({
      '/orgs/catzoidhub/memberships/rerun-owner': failure
    })), { message: 'GitHub lookup failed; release denied' })
  }
  for (const credentials of [{ membershipToken: '' }, { githubToken: '' }]) {
    await assert.rejects(validateRelease(dispatch, { ...apiFixture(), ...credentials }), /credentials required/)
  }
  await assert.rejects(validateRelease(dispatch, { ...apiFixture(), membershipToken: 'repository-only' }), /Dedicated membership/)
  for (const actors of [{ actor: '' }, { triggeringActor: undefined }]) {
    await assert.rejects(validateRelease({ ...dispatch, ...actors }, apiFixture()), /release actor/)
  }
})

test('absent tags, off-main commits and version mismatch are rejected', async () => {
  await assert.rejects(validateRelease(dispatch, apiFixture({
    '/repos/catzoidhub/DevCatz/git/ref/tags/v1.1.0': 404
  })), /lookup failed/)
  for (const status of ['behind', 'diverged', undefined]) {
    await assert.rejects(validateRelease(dispatch, apiFixture({
      [`/repos/catzoidhub/DevCatz/compare/${sourceSha}...${mainSha}`]: { status }
    })), /main history/)
  }
  await assert.rejects(validateRelease(dispatch, apiFixture({
    [`/repos/catzoidhub/DevCatz/contents/package.json?ref=${sourceSha}`]: {
      type: 'file', encoding: 'base64', content: Buffer.from('{"version":"1.2.0"}').toString('base64')
    }
  })), /manifest version/)
  assert.equal((await validateRelease(dispatch, apiFixture({
    [`/repos/catzoidhub/DevCatz/compare/${sourceSha}...${mainSha}`]: { status: 'identical' }
  }))).sha, sourceSha)
})
