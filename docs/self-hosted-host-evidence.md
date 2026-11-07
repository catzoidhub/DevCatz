# Host verification evidence

Recorded 2026-11-07 for issues #2–#5. Host addresses and administrative credentials
are intentionally omitted from this public repository.

## Linux

Administrative SSH access was verified to the existing mailbox host, Ubuntu
24.04.5 x86_64 with kernel 6.8.0-85-generic and approximately 62 GiB free.

Created the separate `devcatz` account (UID/GID 1001), home `/var/lib/devcatz`, and
`/srv/devcatz/{actions-runner,work,tools}`. Home/project directories have mode
0700. Its only group is `devcatz`; administrator `sudo -l -U devcatz` reports no
sudo permission. Node 22.23.4 and Bun 1.4.4 were installed in its own tool directory
after checking their SHA-256 values against the official distribution metadata.
Installed zip, fakeroot, libopenjp2-tools and libfuse2t64 without upgrading or
removing existing packages.

The readiness helper at `a056b5ddcbe378bca0fb678023b22cc05ca0ae67` was streamed over
SSH and executed as `devcatz`, without executing selected release source. It passed
identity, x64, privileged-group exclusion, temporary read/write/cleanup, and tool
checks: Node 22.23.4, Bun 1.4.4, Git 2.43.0, dpkg-deb 1.22.6, fakeroot 1.33,
zip and unzip. This is an SSH-administered readiness check, not an Actions run.

Runner 2.338.2 was checksum-verified and registered as `devcatz-linux-x64` in group
3. Its separate systemd service runs as UID 1001 (`devcatz`), with the dedicated
tool directory on PATH. Service startup and online/idle status were verified.

The mailbox runner service remained active before and after provisioning. No
mailbox account/service/registration was changed. Its runner configuration file
is readable by other local users; its private authentication key and home are
inaccessible to `devcatz`. Full filesystem/network isolation has not been audited.

## Windows

Administrative SSH access and Windows Server 2022 Datacenter x64 were verified.
The existing mailbox runner service was running as its separate `gha-mailbox`
account. Approximately 445 GiB was free. Created the separate standard `devcatz`
account with only the local Users group and isolated `C:\DevCatz` directories.
Installed checksum-verified Node 22.23.4, Bun 1.4.4, MinGit 2.56.0.4 and
PowerShell 7.6.9 in its own tools directory.

The pinned readiness helper passed over temporary account-local SSH as `devcatz`:
medium integrity, privileged groups excluded, all four tools executed and the
temporary write/read/cleanup probe passed. Temporary SSH access and test artifacts
were removed; revocation was checked. The mailbox runner remained running under
its original account/process. No mailbox, SQL, network or global SSH configuration
was changed. The SSH smoke is separate from service startup and Actions job checks.

The attempted scheduled task was blocked by batch-logon policy (Security event
4625, status 0xc000015b); its task was removed. Batch-logon rights were not broadened.

Runner 2.338.2 was checksum-verified and registered as `devcatz-windows-x64` in
group 3. Its separate service runs as `.\devcatz`; GitHub's configuration granted
the account service-logon rights. Startup, service identity and online/idle status
were verified. A service-specific PATH supplies the dedicated toolchain without
changing the mailbox or machine-wide PATH. Tool execution inside an Actions job
remains to be verified.

## Remaining evidence

Both dedicated runner services are registered, running and online. GitHub API inspection confirmed group
`devcatz-release` (ID 3) uses selected-repository access to only DevCatz, deliberate
public-repository opt-in, and immutable selected-workflow restrictions. Environment
`devcatz-release` permits only branch `main`. A separate Members-read token passed
an actual owner-membership lookup and is stored only in that environment as
`DEVCATZ_MEMBERS_READ_TOKEN`. Expected account variables and the policy-ready
attestation are configured. The current runner-group allowlist contains only the
three reusable workflows at `c461c844f8fe04c09a47ad06abd168fbe9e5d581`.

An [unapproved alternate-ref workflow probe](https://github.com/catzoidhub/DevCatz/actions/runs/42374526721)
requested both platform runners directly. Both jobs remained queued and unassigned
for about 90 seconds while both dedicated runners were online/idle. It was
cancelled with no steps executed, and its temporary branch was deleted. This
observation supports the configured restrictions; it is not a complete historical
rerun or queue-expiration test.

A [real non-main Windows dispatch](https://github.com/catzoidhub/DevCatz/actions/runs/42374704165)
was skipped before any build job. A separate local validator smoke used live
GitHub API responses with event/ref context fixtures: owner selection of `v1.1.0`
resolved `facfa9a52337db69e78cde0c67fe1198d93a26ea`; non-owner, non-main and absent-tag
fixtures were rejected. These fixture contexts do not prove real rerun handling.

Positive dispatch from main awaits rollout of the integration PR; current main
still contains the prior hosted Windows workflow. Main branch protection is not
configured. Neither native
build, optional signing, workflow rejection/rerun/offline checks, nor controlled
release publication has been exercised. No release assets were changed.
