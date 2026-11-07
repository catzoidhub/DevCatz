const os = require('node:os')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

function checkRunner({ expectedUser, temp }, {
  platform = process.platform, arch = process.arch,
  userInfo = os.userInfo, execFileSync = childProcess.execFileSync
} = {}) {
  const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', timeout: 15000 }).trim()
  const user = userInfo()
  if (!['linux', 'win32'].includes(platform) || arch !== 'x64') throw new Error('Expected Windows or Linux x64 runner')
  const identity = platform === 'win32' ? run('whoami', []) : user.username
  const matchesUser = expectedUser && (platform === 'win32'
    ? identity.toLowerCase() === expectedUser.toLowerCase() : identity === expectedUser)
  if (!matchesUser || user.uid === 0) {
    throw new Error('Expected dedicated non-privileged account')
  }
  const groups = platform === 'win32' ? run('whoami', ['/groups', '/fo', 'csv', '/nh']) : run('id', ['-Gn'])
  if (platform === 'win32' ? /S-1-5-(?:32-(?:544|547|551)|18)(?![0-9])/.test(groups)
    : groups.split(/\s+/).some(group => ['root', 'sudo', 'wheel', 'docker', 'lxd', 'disk'].includes(group))) {
    throw new Error('Privileged account group is forbidden')
  }
  const result = { identity, groups }
  for (const [command, args] of [
    ['node', ['--version']], ['git', ['--version']], ['bun', ['--version']],
    ...(platform === 'win32' ? [['pwsh', ['--version']]] : [
      ['zip', ['-v']], ['unzip', ['-v']], ['dpkg-deb', ['--version']], ['fakeroot', ['--version']]
    ])
  ]) result[command] = run(command, args).split(/\r?\n/)[0]
  const nodeMajor = Number(/^v(\d+)\./.exec(result.node)?.[1])
  if (!(nodeMajor >= 22)) throw new Error('Node 22 or newer is required')
  if (!temp || !path.isAbsolute(temp)) throw new Error('Absolute RUNNER_TEMP is required')
  const directory = fs.mkdtempSync(path.join(temp, 'devcatz-smoke-'))
  try {
    const file = path.join(directory, 'probe')
    fs.writeFileSync(file, 'devcatz readiness')
    if (fs.readFileSync(file, 'utf8') !== 'devcatz readiness') throw new Error('Temporary read/write failed')
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
  return result
}

module.exports = { checkRunner }
