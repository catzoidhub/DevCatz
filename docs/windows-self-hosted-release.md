# Windows x64 self-hosted releases

Implements the workflow and local validation for [#4](https://github.com/catzoidhub/DevCatz/issues/4)
under [#2](https://github.com/catzoidhub/DevCatz/issues/2). Real Actions readiness and
an unsigned, upload-disabled native build passed on the dedicated service; see
[host evidence](self-hosted-host-evidence.md) for artifacts and publication results.
SignPath remains unverified because signing credentials are not configured.

## Enable only after runner-policy verification

Follow [the shared runner runbook](self-hosted-releases.md) first: dedicated
non-administrator Windows x64 account/work directory, the `devcatz-release`
organization runner group, public-repository opt-in, only this repository, and
**immutable selected reusable workflows**. The group must allow the full
`catzoidhub/DevCatz/.github/workflows/build-windows-release.yml@1c15830e964380fbf92647315475f6cac1e3ca97`
used by the dispatcher. Do not allow `release-windows.yml`, mutable refs, or
label-only access. Preserve the pinned commits when integrating; the dispatcher
pin is committed after the reusable workflow so it names an existing commit.

The manual dispatcher must be on main. Environment `devcatz-release` must permit
only main, with dedicated `DEVCATZ_MEMBERS_READ_TOKEN`; set the runner policy and
expected Windows identity variables only after administrator verification. The
hosted gate and **first step** in the persistent job both use the immutable
validator `3f634e3bff1bd67ab81ec4044a2effe4e193c3e5`. Both current actors must be
owners. The persistent check compares the tag against the gate's SHA, then
checkout uses its own newly validated SHA with persisted credentials disabled.
No selected source, lifecycle hooks, caches or tools run before this check.

The build has read-only repository permission. Only the separate, optional hosted
publication job has `contents: write`; its token is supplied to the publication
action step. That job revalidates current owners/source before downloading the
build's final artifact by exact ID. Hosted authorization/publication jobs do not
build packages. An offline Windows host queues; there is no hosted build fallback
(GitHub currently expires queued self-hosted jobs after 24 hours).

## Required tools and signing

Install Git, Node 22+, Bun and PowerShell 7 in the dedicated service account's PATH.
Allow access to dependency, Electron, electron-builder/NSIS tool and optional
SignPath downloads. The smoke action verifies identity, privilege exclusion,
architecture, temporary writes and these tools before installation. A native
build is still required to prove the complete toolchain. The selected source must
have its frozen Bun lockfile and electron-builder's installed JavaScript
`app-builder-lib/out/targets/blockmap/blockmap` API (tested here with 26.15.3).
No dependency is added for release tooling.

The workflow reuses this verified toolchain. It does not run setup-bun, whose
Windows bunx symlink creation requires privileges the build account must not have.

The workflow keeps the existing `electron-builder.yml` settings: x64 NSIS,
interactive per-user installation, directory choice, artwork and shortcut pages.
It invokes `--win nsis --x64 --publish never`; packaging itself cannot publish.
Build outputs are cleaned before packaging so stale installers cannot be reused.

Signing is optional. Put `SIGNPATH_API_TOKEN` in the main-only environment and
configure `SIGNPATH_ORGANIZATION_ID`, `SIGNPATH_PROJECT_SLUG` and
`SIGNPATH_SIGNING_POLICY_SLUG` after provider approval. The dispatcher passes only
the named membership/signing secrets; environment values take precedence. The
signing token appears only in the signing-configuration step and SignPath step,
never installation/build commands. A configured token with missing variables
fails; a signing failure never silently publishes unsigned files. With no token,
the final artifact is explicitly unsigned. SignPath can wait up to two hours for
manual approval, within the three-hour build-job timeout.

Before signing, the workflow validates and retains `windows-unsigned-<run>-<attempt>`.
It submits that artifact to the pinned SignPath action. Exactly one returned EXE
with the expected name and a valid Authenticode signature is required before
adoption. The trusted metadata tool regenerates the external blockmap from the
signed bytes and updates both SHA-512 entries and the installer size in
`latest.yml`. It preserves unrelated metadata such as the release date.

## Dispatch and inspect

After setup and integration to main, a current owner can run:

```sh
gh workflow run release-windows.yml --repo catzoidhub/DevCatz --ref main -f tag=v1.1.0 -f upload=false
```

Use an existing accepted tag whose version matches its manifest. Upload defaults
to **false** in both dispatcher and reusable workflow. An upload-disabled run
skips the entire publication job, creates no Release and changes no release
assets. Both upload choices retain the validated final artifact
`windows-x64-<run>-<attempt>` for 30 days (subject to repository retention policy),
before any publication attempt. The final artifact contains exactly:

- `DevCatz-Setup-<version>.exe`
- `DevCatz-Setup-<version>.exe.blockmap`
- `latest.yml`

Inspect the final artifact, rather than the unsigned signing input when signing
was enabled. The validator checks exact installer/metadata names and version,
both metadata SHA-512 entries and size, and a freshly generated blockmap against
the retained map. It checks the unpacked application PE is AMD64; NSIS's installer
stub can be 32-bit even for an x64 application. These checks precede final artifact
retention. They do not prove the installer runs: test installation, shortcuts,
uninstall and an update in a disposable Windows VM too.

For local verification of the complete build directory, with dependencies already
installed in the selected source directory:

```sh
node /path/to/audited/scripts/windows-release.cjs verify dist 1.1.0
```

This needs `dist/win-unpacked/DevCatz.exe` as well as the three published files.
The tool is checked out independently at
`315c741184808aaeae1e4a167e8d06c5ef7cc57a`; it never comes from the selected tag.
The `refresh` command is for the workflow's already signature-verified installer;
it regenerates metadata/blockmap, then performs the same validation.

## Publication shared with Linux

The reusable cross-platform action is
`catzoidhub/DevCatz/.github/actions/publish-release@256531de305d974dae311bd108c65ec5194dbf85`.
Linux may pin this same action without using Windows tooling. Its inputs are
`tag`, `expected-sha`, `files` and `github-token`. `expected-sha` is the Windows
build job's validated commit output, preserved across artifact download. `files`
is newline-separated **exact paths**, no
globs, with unique nonempty readable regular files and unique basenames. Basenames
use ASCII letters, digits, underscores, dots and hyphens to avoid GitHub filename
normalization. Directories, missing/empty files, duplicate paths/names and invalid
responses fail before uploads.

The action requires an existing release at the selected tag. Published releases
resolve by tag; drafts are found by exact tag across release pages when that
endpoint returns 404. It retrieves **all asset pages** and preflights every proposed name before sending any bytes. It
uses only GET and create-upload POST requests, with no release creation, clobber,
replacement or deletion. If another publisher claims a name after preflight,
GitHub's create API rejects it; the action stops without retrying as a
replacement. Error reporting lists confirmed uploads and the failed/uncertain
asset. Network failures can leave an asset on the server even without a confirmed
response; inspect the release before retrying. GitHub uploads are not transactional.
See the [official asset API](https://docs.github.com/en/rest/releases/assets).

The publisher rechecks the peeled tag commit and original release ID/tag name
before and after each upload. Observable drift stops later uploads and reports
the partial outcome, including drift during the final upload. These separate API
calls cannot guarantee atomic source binding. Apply the shared runbook's
[required tag/release mutation freeze and residual-race guidance](self-hosted-releases.md#publication-source-binding-and-required-mutation-freeze)
through both platforms' publications; no immutable-release or draft-only lifecycle
is introduced.

To publish, dispatch from main with `-f upload=true`. This builds again; it does
not promote a prior run. Use retained bytes and the action's exact file list for
inspection. A later signed build of an already published unsigned version is
intentionally rejected: use a new reviewed release version, not replacement.

On collision, use another release/version or investigate the existing release.
On partial upload, preserve all existing bytes, record confirmed/uncertain names,
compare downloads to retained artifact hashes, and have the owner decide recovery.
Re-running the whole file list will reject names that already succeeded; it does
not delete them or attempt rollback. A separately reviewed invocation of the same
action can upload only the confirmed missing exact files. Do not remove production
assets just to make a workflow retry succeed.

## Verification evidence and remaining work

Local tests use temporary PE fixtures, the installed electron-builder blockmap
generator, real filesystem reads/writes and simulated GitHub API responses:

```sh
bun install --frozen-lockfile --ignore-scripts
node --test tests/release-source.test.cjs tests/runner-readiness.test.cjs tests/windows-release.test.cjs tests/release-publication.test.cjs
```

They cover unsigned validation, simulated signed-byte metadata refresh, stale or
incorrect metadata/blockmaps/architecture, exact Windows/Linux file publication,
paginated collisions, missing releases/files, malformed responses, concurrent
422s and partial/network failures with existing bytes preserved. Simulated signed
bytes are **not Authenticode signing evidence**.

Before marking the ticket verified, record real run/job URLs, source SHA, runner
identity, tool versions, installer architecture and downloaded artifact hashes for
an upload-disabled native build. Snapshot the selected release's complete asset
list/IDs/digests/bytes before and after and prove no changes. Verify unsigned
production without credentials, and optional signing when credentials exist.
Record all shared-runbook owner/rerun/ref/source rejection and offline-routing
checks. Recheck group selected-workflow and environment restrictions on GitHub.

Use a **controlled disposable test release**, with accepted source/tag, to verify
successful upload and a second collision attempt. Compare every existing asset's
downloaded bytes before/after rejection. Exercise partial/concurrent publication
there if possible; never use production assets for destructive experiments.
Actual runner, native-build and publication evidence is linked above. Signing,
installer execution and end-user update behavior remain unverified.
