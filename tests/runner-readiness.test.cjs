const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, readdirSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { checkRunner } = require('../.github/actions/runner-readiness/check.cjs')

test('readiness proves the expected unprivileged Linux x64 identity, tools and temporary read/write', () => {
  const temp = mkdtempSync(join(tmpdir(), 'devcatz-readiness-test-'))
  try {
    const versions = checkRunner({ expectedUser: 'devcatz', temp }, {
      platform: 'linux', arch: 'x64', userInfo: () => ({ username: 'devcatz', uid: 1002 }),
      execFileSync: (command) => ({ id: 'devcatz', node: 'v22.21.0', git: 'git version 2.43', bun: '1.3.0',
        zip: 'Zip 3.0', unzip: 'UnZip 6.0', 'dpkg-deb': 'Debian dpkg-deb', fakeroot: 'fakeroot 1.33' })[command]
    })
    assert.match(versions.identity, /devcatz/)
    assert.match(versions.node, /22/)
    assert.deepEqual(readdirSync(temp), [])
  } finally { rmSync(temp, { recursive: true, force: true }) }
})

test('Windows checks the full account name and rejects even a filtered Administrators token', () => {
  const temp = mkdtempSync(join(tmpdir(), 'devcatz-readiness-test-'))
  const host = {
    platform: 'win32', arch: 'x64', userInfo: () => ({ username: 'devcatz', uid: -1 }),
    execFileSync: (command, args) => command === 'whoami'
      ? (args.length ? 'Users S-1-5-32-545' : 'BUILDHOST\\devcatz')
      : ({ node: 'v22.21.0', git: 'git version 2.43', bun: '1.3.0', pwsh: 'PowerShell 7.4' })[command]
  }
  try {
    assert.match(checkRunner({ expectedUser: 'buildhost\\devcatz', temp }, host).identity, /devcatz/i)
    assert.throws(() => checkRunner({ expectedUser: 'buildhost\\devcatz', temp }, {
      ...host, execFileSync: (command, args) => args.length ? 'S-1-5-32-544 Deny only' : 'BUILDHOST\\devcatz'
    }), /Privileged/)
  } finally { rmSync(temp, { recursive: true, force: true }) }
})

test('missing configuration, privileged accounts, wrong architecture and old Node fail readiness', () => {
  const config = { expectedUser: 'devcatz', temp: tmpdir() }
  const host = { platform: 'linux', arch: 'x64', userInfo: () => ({ username: 'devcatz', uid: 1002 }),
    execFileSync: command => command === 'id' ? 'devcatz' : 'v22.21.0' }
  for (const [input, system, error] of [
    [{ expectedUser: '' }, {}, /account/], [{ expectedUser: 'mailbox' }, {}, /account/],
    [{ temp: '' }, {}, /RUNNER_TEMP/], [{ temp: 'relative' }, {}, /RUNNER_TEMP/],
    [{}, { arch: 'arm64' }, /x64/], [{}, { userInfo: () => ({ username: 'devcatz', uid: 0 }) }, /account/],
    [{}, { execFileSync: () => 'sudo' }, /Privileged/],
    [{}, { execFileSync: command => command === 'id' ? 'devcatz' : 'v20.19.0' }, /Node 22/]
  ]) assert.throws(() => checkRunner({ ...config, ...input }, { ...host, ...system }), error)
  assert.throws(() => checkRunner(config, { ...host, execFileSync: () => { throw new Error('tool missing') } }), /tool missing/)
})
