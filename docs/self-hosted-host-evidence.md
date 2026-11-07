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
changing the mailbox or machine-wide PATH. Tool execution passed inside the actual
service-hosted Actions readiness and native build jobs.

## Policies and immutable pins

API inspection confirmed runner group `devcatz-release` (ID 3): selected repository
only DevCatz, deliberate public-repository opt-in, and immutable selected-workflow
restrictions. Environment `devcatz-release` permits only branch `main`. A separate
Members-read credential passed the live owner lookup and is stored as environment
secret `DEVCATZ_MEMBERS_READ_TOKEN`. Expected identities and policy attestation are
configured. Group changes are followed by explicit repository-selection checks:
a PATCH that includes visibility can clear that selection.

The readiness workflow is pinned to `ef0864fd821eb5e66c40e8e666760e02d57a9c1a`.
Both release dispatchers use `1c15830e964380fbf92647315475f6cac1e3ca97`; the shared
publisher is `256531de305d974dae311bd108c65ec5194dbf85`. Linux packaging/checks
remain `5bd4ac94aa0f738aec730503e52c319d022b375f`; the validator remains
`3f634e3bff1bd67ab81ec4044a2effe4e193c3e5`.

## Actual authorization and scheduling evidence

- [Main readiness](https://github.com/catzoidhub/DevCatz/actions/runs/42376790427)
  passed hosted authorization and first-step validation/account/tool/temp checks
  on both actual service accounts.
- [Non-main dispatch](https://github.com/catzoidhub/DevCatz/actions/runs/42374704165)
  was skipped before building. Main dispatches rejected
  [wrong prefix](https://github.com/catzoidhub/DevCatz/actions/runs/42378394087),
  [absent tag](https://github.com/catzoidhub/DevCatz/actions/runs/42378396821),
  [version mismatch](https://github.com/catzoidhub/DevCatz/actions/runs/42378400321), and
  [off-main commit](https://github.com/catzoidhub/DevCatz/actions/runs/42378403595).
  Each error was checked in logs and persistent jobs were skipped; disposable
  negative-test refs were deleted.
- [Membership lookup failure](https://github.com/catzoidhub/DevCatz/actions/runs/42378862379)
  failed closed with persistent jobs skipped. The credential was restored before
  subsequent positive runs; no token value appears in evidence.
- Both DevCatz services were stopped, then valid owner release dispatches passed
  hosted authorization while both native jobs remained queued and unassigned:
  [Windows attempt 1](https://github.com/catzoidhub/DevCatz/actions/runs/42379287282/attempts/1),
  [Linux attempt 1](https://github.com/catzoidhub/DevCatz/actions/runs/42379289863/attempts/1).
  Moving only the disposable fixture tag while queued, then restoring the services,
  produced `Tag moved since the earlier validated SHA` in both first native steps.
  Checkout, dependency installation and build were skipped. The fixture tag was
  restored; both mailbox services stayed running. No hosted build fallback occurred.
- Real `github-actions[bot]` initial dispatches were denied on
  [Windows](https://github.com/catzoidhub/DevCatz/actions/runs/42379739397) and
  [Linux](https://github.com/catzoidhub/DevCatz/actions/runs/42379741790), before native
  assignment. The bot then reran failed jobs of the successful-owner-authorization
  runs: [Windows attempt 2](https://github.com/catzoidhub/DevCatz/actions/runs/42379287282/attempts/2),
  [Linux attempt 2](https://github.com/catzoidhub/DevCatz/actions/runs/42379289863/attempts/2).
  A [Linux individual-job rerun, attempt 3](https://github.com/catzoidhub/DevCatz/actions/runs/42379289863/attempts/3)
  also failed the first check. Initial actor remained `sizoune`, triggering actor
  became the bot, and cached successful authorization did not permit checkout.
  The temporary hosted controller was removed after testing. Human repository-admin
  non-owner and removed/pending-owner cases have fixture coverage, not live human
  role-change evidence.
- The definitive [unapproved alternate-workflow probe](https://github.com/catzoidhub/DevCatz/actions/runs/42379901990)
  requested both platform runners directly from a temporary branch. With repository
  access verified and both runners online/idle before and after, both jobs remained
  queued, unassigned and without steps for 90 seconds. The run was cancelled and
  branch deleted. The earlier probe `42374526721` was inconclusive due to an empty
  repository selection and is not used as passing evidence.

## Native upload-disabled outputs

[Linux](https://github.com/catzoidhub/DevCatz/actions/runs/42377884274) and
[Windows](https://github.com/catzoidhub/DevCatz/actions/runs/42377884346) both succeeded
on their dedicated x64 services, building production tag `v1.1.0` at
`facfa9a52337db69e78cde0c67fe1198d93a26ea`. All publication jobs were skipped.
The full production release snapshot before/after matched: all ten existing asset
IDs, names, sizes, digests and update timestamps were unchanged.

| Platform | Final retained artifact ID | ZIP SHA-256 |
| --- | --- | --- |
| Linux | `13576492380` | `d36f2bb37984ab8f30732fb16cc3b6726ba3f315e5a0ec639704cb81e8cc77bc` |
| Windows | `13576577196` | `197d1281fc6590ef16e9650fcd3fea9f891bdfd1796e8628077ad24e0c825551` |

Both artifacts were downloaded. Exact file sets, manifest versions, package sizes
and SHA-512 values matched their update metadata. Native workflow checks verified
AppImage ELF64 x86-64/type 2 and regenerated embedded blockmap; Debian `amd64`,
package/version/updater identity; Windows unpacked application AMD64 and regenerated
external installer blockmap. The NSIS installer stub itself need not be 64-bit.
Windows produced an explicitly unsigned installer because SignPath is unconfigured.

Real runs exposed and fixed composite-action `vars` context usage, setup-bun's
privileged Windows symlink creation, and AppImage's x86_64 filename normalization.
The workflows now pass policy readiness as an input, reuse verified Windows tools,
and use explicit Linux x64 filenames. Existing macOS and NSIS settings are preserved.

## Controlled draft publication

The disposable draft prerelease used `v1.1.0-ci.20261107.132814`, resolving to
`f78345bf054247e075e2e0f9cb05f3c7cb99038b`. The fixture version commit and its
immediate revert were accepted through PR #8; the final application version stayed
`1.1.0`. The tag/release association was held fixed during publication.

[Linux attempt 1](https://github.com/catzoidhub/DevCatz/actions/runs/42380282789/attempts/1)
built and published both packages plus metadata successfully. Retained artifact
`13576979928` was downloaded and every published asset digest/size matched its
bytes; metadata SHA-512 values also matched. The
[publication-only rerun, attempt 2](https://github.com/catzoidhub/DevCatz/actions/runs/42380282789/attempts/2)
used the original artifact and rejected all existing names before uploading.
All five then-existing asset IDs, sizes, digests and timestamps were unchanged;
downloaded metadata/probe bytes were identical.

[Windows attempt 2](https://github.com/catzoidhub/DevCatz/actions/runs/42380280385/attempts/2)
built and published the unsigned NSIS installer, external blockmap and metadata.
Final artifact `13577262402` retained the same validated bytes as the unsigned
input. Read-only SHA-256/SHA-512 checks on the actual Windows build files matched
all published asset digests, sizes and update metadata; downloaded metadata also
matched. Attempt 1 had failed closed on a GitHub lookup before checkout and was
rerun by the owner without changing the guard. The
[publication-only collision rerun, attempt 3](https://github.com/catzoidhub/DevCatz/actions/runs/42380280385/attempts/3)
reused the original artifact and rejected existing names before upload. All eight
existing asset IDs, digests, sizes and timestamps remained unchanged; downloaded
metadata, blockmap and probe bytes were identical.

Two simultaneous calls to the same shared publisher used a barrier immediately
before their first POST, proving both had passed absence preflight. One created
the disposable probe; GitHub rejected the other with HTTP 404 on this draft.
The rejected call reported the uncertain/partial outcome without retrying as a
replacement. The winner's downloaded bytes and SHA-256 matched exactly. This live
response is recorded as 404, not relabelled as a 422; fixture tests separately
exercise 422, later upload failures, network uncertainty and names beyond page one.

The real draft revealed that GitHub's by-tag endpoint only resolves published
releases. The publisher now falls back on 404 to paginated exact-tag release
lookup, with malformed successful responses still failing closed. All **50**
release/readiness/publication tests and actionlint passed after this fix.

## Linux production publication

At the user's explicit request, the [main Linux upload run](https://github.com/catzoidhub/DevCatz/actions/runs/42380069056)
completed successfully against the existing production `v1.1.0` release (ID
`434229036`). It added only `DevCatz-1.1.0-x64.AppImage`,
`DevCatz-1.1.0-amd64.deb` and `latest-linux.yml`. All ten pre-existing Windows/macOS
asset IDs, names, sizes, digests and update timestamps remained unchanged.
The retained artifact `13577771081` was downloaded; every package's SHA-256 matched
its published GitHub asset digest, and sizes/SHA-512 matched the update metadata.
The release notes now include Linux links; the application version remains `1.1.0`.

| Linux production asset | SHA-256 |
| --- | --- |
| `DevCatz-1.1.0-x64.AppImage` | `a3ad98d315c80868cb856f62438c4847b418a9ff74b9685044f8ecc024fc44fe` |
| `DevCatz-1.1.0-amd64.deb` | `f7634a96c22f303217445f156690eefb656b50705894bfdb921caf88835264b0` |
| `latest-linux.yml` | `489ad797199dacd1ad4eb4b40cb2458c75db0926a3680d70c242c91cd4ade0c3` |

## Cleanup and final state

After both platforms' collision checks, the owned draft release and its CI tag
were deleted after checking release ID, draft/prerelease flags, exact eight-file
set and source SHA. Negative refs, alternate-workflow branch and temporary
controller were removed. The accepted fixture/revert history remains; the final
application version is `1.1.0`. Production release identity/tag and all thirteen
asset digests were rechecked unchanged after cleanup.

Both dedicated services and both existing mailbox services remained running. The
redundant Windows encrypted provisioning-password copy was removed without
reading it; the service retains its configured credential in Windows SCM.

## Remaining scope limits

Main branch protection is not configured. Source-binding checks surround each
upload but are not atomic with GitHub tag/release edits; keep their association
frozen as required by the shared runbook. Separate accounts do not provide VM
isolation. SignPath/Authenticode signing, package installation, GUI startup and
end-user updater/feed behavior have not been exercised. These are not claimed by
the successful packaging checks.
