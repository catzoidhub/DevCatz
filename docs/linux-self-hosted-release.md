# Linux self-hosted releases

Implementation for [#5](https://github.com/catzoidhub/DevCatz/issues/5).
Use the provisioning, current-owner credential, main-only environment and immutable
selected-workflow runner-group requirements in [the shared runbook](self-hosted-releases.md).
Do not register/start runners before those restrictions are verified.

## Integration status and pins

The shared publication action is pinned to
`a24559385763f25f8cbd0114197f47bcbf1457fb`; the dispatcher calls the completed
reusable workflow at `ef0864fd821eb5e66c40e8e666760e02d57a9c1a`. Allowlist that
exact `catzoidhub/DevCatz/.github/workflows/build-linux-release.yml@ef0864fd821eb5e66c40e8e666760e02d57a9c1a` in the
restricted `devcatz-release` group. Never allowlist the dispatcher or a branch.
Preserve all referenced commits when integrating; do not squash away the pins.

The Linux configuration/output checker is pinned independently to
`a24559385763f25f8cbd0114197f47bcbf1457fb`. The owner/source gate uses
`3f634e3bff1bd67ab81ec4044a2effe4e193c3e5`; the account/tool check remains at
`a056b5ddcbe378bca0fb678023b22cc05ca0ae67`.

The real Linux account/tool readiness check passed over administrative SSH; see
[host evidence](self-hosted-host-evidence.md). Runner registration, membership
credentials, policy enforcement, workflow dispatch, native build, installation,
application launch, updater behavior and publication remain unverified.

## Source and packaging contract

The hosted authorization job validates the manual main dispatch, both actors'
current ownership, tag ancestry and manifest version. The persistent job repeats
that validation as its **first step**, including on individual/failed-job reruns,
then checks the dedicated identity/tools. Checkout uses that local validation's
SHA with `persist-credentials: false`. No selected-source helper, dependency
installation or build runs before validation. No executable cache is restored.

An accepted tag may predate Linux configuration (for example, existing `v1.1.0`).
The build therefore explicitly passes the **separately pinned** tools checkout's
`electron-builder.yml` to electron-builder, rather than trusting a config from the
tag or mutable main. Application source, resources and locked dependencies come
from the validated tag commit. The Linux invocation also sets packaged homepage
metadata to the repository URL. It does not rewrite the selected manifest or use
the macOS-only `bun run package` script. The Debian maintainer uses the existing
public packaging author's GitHub noreply identity; support remains GitHub Issues.

This is a tag-source build with an approved packaging override, not a claim that
the tag's original packaging config was used. The job summary records both pins.
Audit a new tools commit if an older tag's scripts, output layout, dependencies or
resources are incompatible with this config; fail the build rather than execute
an unreviewed config, move the tag, or silently substitute current application code.
The configuration leaves macOS/Windows values unchanged and adds only Linux targets.

## Host prerequisites

Use the dedicated non-root, non-sudo `devcatz` account, restricted group and labels
`self-hosted`, `Linux`, `X64`, `devcatz`, `devcatz-linux-x64`. Keep mailbox's accounts,
services, paths and registrations unchanged. Separate accounts are not VM isolation.

Provision Git, Node **22.12+**, Bun compatible with `bun.lock`, zip/unzip,
`dpkg-deb`, fakeroot, build-essential/Python and libopenjp2-tools as described in
the shared runbook. Check the actual service account's PATH, tool versions, disk
space and write access. The pinned readiness baseline checks Node 22+, so the
administrator must additionally verify 22.12+ for this Vite dependency tree.
Allow downloads of locked packages, Electron and electron-builder's AppImage/FPM
helpers. No tools are installed with sudo during the job. Electron GTK/NSS/X11,
audio libraries, FUSE support (for the default AppImage runtime), display access
and sandbox behavior require separate host/runtime verification. Do not add
`--no-sandbox` or broaden host privileges to get an unverified app to launch.
[Linux packaging options](https://www.electron.build/linux/),
[AppImage runtime and embedded differential updates](https://www.electron.build/appimage/).

Run the readiness workflow first and record its evidence. An offline Linux runner
queues this build on the same group/labels; it never falls back to a hosted build.
GitHub's queue expiration still applies. The hosted jobs here only authorize and,
when requested, publish already-built files.

## Manual operation and artifact inspection

After integration/pin/policy setup, a current organization owner dispatches from main:

```sh
gh workflow run release-linux.yml --ref main -f tag=v1.1.0 -f upload=false
```

Substitute an existing accepted release tag. The boolean defaults to false in
both dispatcher and reusable workflow. The persistent job has only contents-read
permission and packages with `--publish never`, without a publication token.
The contents-write publication job is skipped entirely when upload is false.
An explicit upload uses a fresh hosted gate, downloads by the immutable artifact
ID from the successful Linux job (also on a publication-only rerun), then calls
the shared create-only publication action with exact newline-separated paths.
It passes `expected-sha` from the Linux build's validated commit output, preserved
through download, and rechecks the peeled tag and original release ID/tag name
before and after each upload. Apply the shared runbook's
[required tag/release mutation freeze and residual-race guidance](self-hosted-releases.md#publication-source-binding-and-required-mutation-freeze);
these API checks cannot make source binding atomic.
Its token is supplied only to that action step; membership secrets are supplied
only to validation steps.

Every successful build retains `linux-x64-<run-id>-<attempt>` for **14 days**,
independent of upload choice and publication success. Download it from the run's
Artifacts section before expiry. For a manifest version of `1.1.0`, it contains:

- `DevCatz-1.1.0-x64.AppImage`
- `DevCatz-1.1.0-amd64.deb`
- `latest-linux.yml`

The pinned check streams SHA-512 over each package, compares exact filenames,
version, sizes and both modern/legacy metadata references, rejects symlink files,
checks the AppImage's ELF64 little-endian x86-64/type-2 header and embedded
compressed blockmap, and asks `dpkg-deb` for `devcatz`/version/`amd64` and presence
of Debian updater files. Prerelease Debian versions use the builder's `-` to `~`
mapping. AppImage differential updates use the **embedded** blockmap; there is no
separate `.AppImage.blockmap` asset to publish. Debian updates use the `.deb`
entry in the same metadata and the packaged `resources/package-type` identity.
These checks do not execute package contents or install scripts.

Blockmap validation regenerates the authoritative map from exactly the AppImage
payload preceding the compressed map and four-byte footer, then compares the
complete parsed maps. This verifies chunk names/offsets, sizes, complete coverage
and checksums, rejecting both malformed-but-decompressible maps and well-formed
maps for stale payload bytes even when outer SHA-512 metadata has been updated.
The locked `app-builder-lib@26.15.3` dependency provides `buildBlockMap` (Rabin
chunks, base64-encoded 18-byte BLAKE2b checksums); this version does not install
`app-builder-bin`. The checker reuses that generator just like the Windows tool,
without adding a dependency or implementing chunking/hashing. It streams the
payload to a private temporary directory, requiring disk space for one payload
copy, and cleans it on success or failure without modifying retained packages.

The supported output here is `latest-linux.yml`. The app also has an optional
beta feed; beta-channel feed delivery and metadata routing are not verified by
this ticket. Do not infer prerelease channel operation from a successful package
check. The external Catzoid feed must expose Linux metadata and package URLs;
its routing is outside this repository and remains a runtime verification blocker.

Inspect a downloaded artifact on a disposable Linux test machine: `file` for
AppImage, `dpkg-deb --info`/`--contents` for Debian, and extract without installation
to inspect `app-update.yml`, Debian `package-type` (`deb`), desktop integration and
packaged executable architecture. Verify SHA-512 against `latest-linux.yml`.
Then separately test AppImage startup, Debian installation/removal and startup,
and updater download/install on supported distributions. Record exact OS/library
versions and results; this implementation does not claim any of those passed.

## Publication, recovery and evidence still required

Only after inspecting artifacts, dispatch with `-f upload=true` for an existing
controlled test release. This performs a new build; it does not publish an earlier
upload-disabled run. The shared action must preflight every intended asset name
across all pages, reject collisions, create only, and report partial failures.
Linux implements no separate upload or overwrite logic.

For a partial upload, retain the downloadable artifact, inspect the reported
successful/failed asset names and verify bytes. A rerun must reject already-created
names; it must not delete or replace them. Choose a new reviewed version/release,
or have an owner resolve only disposable test assets manually. Never use production
assets for collision or recovery experiments. If download artifacts expired,
rebuild with fresh authorization rather than bypassing the retention step.

Before claiming #5 verified, record run URLs, both actors, validated SHA, tools pin,
runner name/account/architecture, tool versions, artifact ID, names/hashes/metadata
and the following actual results:

- Upload-disabled real host build: snapshot all paginated release asset IDs/names
  and downloaded byte hashes before/after; require no changes.
- Both Linux formats/architecture/metadata pass on the dedicated host; independently
  inspect downloaded artifacts. Record installation/runtime/feed blockers separately.
- On a disposable release, successful explicit publication; existing-name collision
  rejection (including a name beyond page one); concurrent upload rejection without
  replacement; existing asset bytes unchanged; partial-failure reporting/recovery.
- Owner/non-owner dispatch and rerun, lookup failure, moved/missing/off-main or
  mismatched tags, alternate workflow refs and offline queue checks from the shared
  runbook. Rejection must precede selected-source execution on persistent hosts.

Local evidence only: dependency installation with lifecycle scripts disabled;
`node --test tests/linux-release.test.cjs tests/release-source.test.cjs tests/runner-readiness.test.cjs`;
builder configuration schema validation and parsed preservation of existing platform
settings; actionlint on the workflows. Linux tests use synthetic package bytes and
fixture responses at the `dpkg-deb` command boundary, with real blockmaps generated
by the installed builder, not native Electron packages. Publication tests use
simulated GitHub responses; actual native/update/publication verification still
requires the main rollout.
