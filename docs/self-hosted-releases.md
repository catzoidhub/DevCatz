# Dedicated DevCatz release runners

Implementation for [#3](https://github.com/catzoidhub/DevCatz/issues/3), under
[#2](https://github.com/catzoidhub/DevCatz/issues/2). Both platform release workflows
reuse this gate; their runbooks cover packaging and publication for #4/#5.

## Current evidence and blockers

Local fixture tests, typecheck and dedicated-account readiness on both real hosts
have passed. The restricted runner group and main-only environment are configured;
see [current host and policy evidence](self-hosted-host-evidence.md) for remaining
registration, credential, service, workflow and native-build verification.
Do not enable runners until the platform restrictions below are confirmed. Missing
`DEVCATZ_RUNNER_POLICY_READY=true` or either credential fails validation.

Run the dependency-free tests with:

```sh
node --test tests/release-source.test.cjs tests/runner-readiness.test.cjs
```

These exercise the public validation/check boundaries, with GitHub API and host
command fixtures. They do not prove GitHub scheduling or real host readiness.

## Security boundary: configure before registration

Labels and YAML conditions do not prevent a modified workflow from targeting a
persistent runner. Use an **organization-level runner group**, `devcatz-release`,
with all of these settings:

- Repository access: selected repositories, **only `catzoidhub/DevCatz`**.
- Allow public repositories: enabled deliberately, because DevCatz is public.
- Workflow access: **selected workflows**, `restricted_to_workflows: true`.
- Select only audited **reusable workflows at full immutable commit SHAs** that
  directly define persistent jobs. The readiness entry is the full `uses:` value
  in `check-runners.yml`, including `@<40-character SHA>`. Do not allow the manual
  dispatcher, a wildcard, a mutable branch/tag, the existing Windows workflow, or
  another workflow that calls a nested reusable build workflow.
- For #4/#5, add only each completed reusable build workflow's immutable SHA,
  after reviewing its in-job validation and all referenced actions. Keep the
  wrapper manual workflow on main and pin its reusable call to that same SHA.

GitHub documents that only jobs **directly defined** in selected workflows can
use the group, and supports SHA pins for reusable workflows. This prevents an
alternate dispatch ref from replacing the protected job, even if it copies the
labels. A branch-only allowlist also risks admitting historical runs from before
the guard existed. [Runner-group restrictions](https://docs.github.com/en/enterprise-cloud@latest/actions/how-tos/manage-runners/self-hosted-runners/manage-access).

An organization owner must verify the actual plan exposes and enforces this
feature. Inspect the group via `GET /orgs/catzoidhub/actions/runner-groups/{id}`:
require `visibility=selected`, `allows_public_repositories=true`,
`restricted_to_workflows=true`, and exactly the approved `selected_workflows`.
Also inspect its `/repositories` and `/runners` subresources. The repository list
must contain only DevCatz; every DevCatz registration must belong to this group.
Do not use repository-level runners or the unrestricted default group. Never
temporarily relax the workflow restriction to debug routing. If the feature is
unavailable, leave runners unregistered/stopped: YAML-only checks are insufficient.
[Runner-group REST API](https://docs.github.com/en/rest/actions/self-hosted-runner-groups).

Create the `devcatz-release` GitHub environment, with deployment branches set to
**selected branches: `main` only**, and no tag pattern. Store the dedicated
membership secret there, not as a generally available repository secret. Protect
main, workflow/helper changes, and environment/group settings against non-owner
changes and bypasses. The helper SHA is pinned independently of the caller's
`github.workflow_sha`; do not load the validator from selected release source.
SHA-pinned helper/workflow commits must be pushed and preserved in history during
integration; after squashing/reimplementing them, update and re-audit every pin.

## Credentials and opt-in settings

Provision a **new dedicated** Members-read credential for `catzoidhub`. An
organization-installed GitHub App installation token with organization
**Members: read** is suitable; a dedicated fine-grained PAT with that permission
and appropriate organization approval is another option. Arrange expiration and
rotation; an expired token must block releases. This implementation consumes the
resulting token, and does not mint App tokens or store App private keys.

Store it as environment secret `DEVCATZ_MEMBERS_READ_TOKEN`. Do not copy the
operator's existing `gh` login token into a durable secret. The parent must agree
the credential owner/rotation plan first. Use the ordinary `github.token` with
`contents: read` separately for source lookups; it is never used for membership.
The helper also rejects using the same value for both credentials.

Before enabling, use the dedicated credential in a private administrator session
to request `GET /orgs/catzoidhub/memberships/{login}` for an owner and a non-owner.
Do not print tokens, shell environments, full contexts or API error bodies. The
owner response must have `state: active`, `role: admin`. Repository admin/maintain
permissions and public membership visibility are not ownership. Network, HTTP,
permission, rate-limit and malformed-response failures deny execution.
[Membership endpoint and required permission](https://docs.github.com/en/rest/orgs/members#get-organization-membership-for-a-user).

Set repository variables only after the platform policy is verified:

| Variable | Required value |
| --- | --- |
| `DEVCATZ_RUNNER_POLICY_READY` | Literal `true`; administrator attestation, not automatic policy discovery |
| `DEVCATZ_LINUX_RUNNER_USER` | Exact dedicated login, e.g. `devcatz` |
| `DEVCATZ_WINDOWS_RUNNER_USER` | Full `whoami` identity, e.g. `BUILDHOST\devcatz` |

## Consumer contract for #4/#5

Reuse `catzoidhub/DevCatz/.github/actions/validate-release@3f634e3bff1bd67ab81ec4044a2effe4e193c3e5`.
There is no checkout or dependency installation in this action. It only calls the
fixed GitHub API origin and reads manifest bytes through the contents API.

1. A manual dispatcher on main calls an audited, SHA-pinned reusable workflow.
   Declare and explicitly forward `DEVCATZ_MEMBERS_READ_TOKEN` in that call, even
   when its value only exists in the called job's environment.
2. Its hosted `authorize` job uses environment `devcatz-release` and invokes the
   action with `tag`, `policy-ready: ${{ vars.DEVCATZ_RUNNER_POLICY_READY }}`,
   `membership-token` and `github-token`. The composite action cannot read the
   `vars` context directly. Expose `sha` as a job
   output. Hosting the API-only gate does not provide a hosted build fallback.
3. Every persistent job uses environment `devcatz-release` and the restricted
   group plus all platform/project labels. **Its first step** invokes the same
   pinned action with `expected-sha: ${{ needs.authorize.outputs.sha }}` as well as
   the other inputs. Do not use `continue-on-error`, `always()` or a conditional
   that skips this step; never install dependencies, restore executable caches,
   run selected source, or checkout source before it succeeds.
4. Checkout **that step's `outputs.sha`**, never the input tag, branch, main tip,
   caller-supplied SHA or a cached upstream output. Use `persist-credentials: false`.
   Scope signing/publication secrets to the steps that need them.

Outputs are `sha` (40-character commit), `tag`, `version`. The action derives
event/ref/repository/initial actor/triggering actor/runner environment from GitHub
contexts, not caller inputs. It accepts only `workflow_dispatch`,
`refs/heads/main`, `catzoidhub/DevCatz`, and both actors' current owner memberships.
It resolves the exact existing `refs/tags/v...` ref, peels annotated tags, checks
the commit is an ancestor of a snapshot of main, and reads `package.json` **at
that commit**. The tag must equal `v` plus its exact version string.

An in-job check is essential: GitHub can rerun a failed/specific job without
rerunning a previously successful authorization dependency. It rechecks both
`github.actor` and `github.triggering_actor` and rejects a moved tag against the
earlier SHA. Source execution must use the local validated SHA, so tag/main
movement after validation cannot redirect checkout. Authorization is a check at
job start, not continuous revocation during a running build.
[Reruns](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs),
[actor contexts](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts).

`runner-readiness.yml` demonstrates this pattern without building or executing
the selected release source. Its two persistent jobs only run the pinned guard
and smoke-check action; both must pass before recording readiness evidence.

## Publication source binding and required mutation freeze

Both publication jobs pass the build job's validated commit as the shared
publisher's required `expected-sha`. Keep that immutable output through artifact
download; resolving the mutable tag again is not a substitute. The publisher
captures the existing release ID and checks its `tag_name`, then immediately
before **each** create-upload request peels the current Git tag to a commit and
requires the expected SHA and the original release ID/tag name. It repeats those
checks after every confirmed upload, including the last. A changed, missing or
unverifiable binding stops publication and reports confirmed and uncertain files.
It never deletes, replaces, creates or retargets a release.

Operators must keep accepted release tags and their release association frozen
from initial source validation through completion of **both platforms'** uploads
and inspection. Administrators should enforce active tag rulesets matching the
accepted `v*` tags with **Restrict updates** and **Restrict deletions**, and audit
all bypass actors/apps. Those rules control tag mutations, not release edits.
During that window, owners, other writers and automation must also refrain from
changing `release.tag_name`, deleting/recreating the release, or changing the tag
through bypass permissions. Coordinate that freeze across publishers and keep
the protected tag/release association stable afterward for consumers. The parent
owns verifying these settings and the operational freeze; the helper does not
discover or enforce them. [Tag rules and bypasses](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets),
[release edit permissions and fields](https://docs.github.com/en/rest/releases/releases#update-a-release).

**Residual race:** GitHub's documented asset-upload API addresses a release ID
and asset name; it provides no documented atomic expected-commit-SHA condition.
The separate GET checks and POST upload are not a transaction. A mutation between
checks and upload can still attach bytes to a changed target; a transient change
and restoration between checks may escape detection, and later mutations remain
possible. Post-upload checks detect observable drift but cannot undo it safely.
Do not claim atomic source binding from these checks or from an operator flag.
[Upload API parameters](https://docs.github.com/en/rest/releases/assets#upload-a-release-asset).

This flow continues to append assets to an existing mutable release, whether
draft or published. Do not enable immutable releases as a workaround: once
published, they cannot accept additional assets, which would prevent the other
platform from appending its files. A draft-only lifecycle would be a separate
design change. [GitHub's immutable-release behavior](https://github.blog/changelog/2025-10-28-immutable-releases-are-now-generally-available/).
If drift is reported, preserve retained artifacts and all existing release bytes,
inspect release ID/tag/SHA and downloaded hashes, and have an owner resolve the
partial outcome before any retry. No automated rollback or replacement occurs.

## Provision the two hosts (administrator runbook; not executed)

The parent must first verify administrative access, OS version/architecture,
available disk, network reachability and mailbox's existing account/service/path
layout. Record that baseline privately. Do not change mailbox accounts, services,
registrations, labels, workspaces or credentials.

Use a new local `devcatz` account on each host with no administrator/root, sudo,
Docker/LXD, disk, or other privileged group membership and no access to mailbox
files. On Linux, inspect `id devcatz` and, as an administrator,
`sudo -l -U devcatz` for direct sudoers grants too. On Windows, inspect local and
domain group memberships and user rights; deny unneeded interactive/network
logon. The automated group check supplements this audit, not replaces it.

Example Linux setup after confirming those names/paths are unused:

```sh
sudo useradd --create-home --home-dir /var/lib/devcatz --shell /bin/bash devcatz
sudo install -d -o devcatz -g devcatz -m 0700 /srv/devcatz/actions-runner /srv/devcatz/work
```

On Windows, create a standard local account through an administrator session,
prompting securely for its password. Create `C:\DevCatz\actions-runner` and
`C:\DevCatz\work` with ACLs granting that account access and denying mailbox's
account access. Install the runner service under the dedicated account, **not
LocalSystem**; grant only required service-logon rights. Do not put account
passwords or registration tokens in committed scripts or command history.

Install Git, Node 22+, Bun and (Windows) PowerShell 7 in the service account's
PATH. Linux needs zip/unzip, dpkg-deb and fakeroot for the smoke baseline; install
build-essential/Python for native rebuilds and electron-builder's distribution
prerequisites (including libopenjp2-tools). Verify downloads of Electron,
electron-builder helper tools, NSIS/AppImage tools and dependencies are reachable
from both hosts. Do not copy mailbox's Rust/Cargo/Tauri/WebKit requirements.
The package build in #4/#5 remains the definitive toolchain test.
[electron-builder v26 platform guidance](https://www.electron.build/v26/docs/features/multi-platform-build/).

Download the current x64 GitHub runner using the organization's installation
instructions and verify its published checksum. Configure it interactively as
the dedicated account (enter the short-lived registration token at the prompt):

```sh
# Linux, inside /srv/devcatz/actions-runner:
./config.sh --url https://github.com/catzoidhub --runnergroup devcatz-release \
  --name devcatz-linux-x64 --labels devcatz,devcatz-linux-x64 --work /srv/devcatz/work
```

```powershell
# Windows, inside C:\DevCatz\actions-runner:
.\config.cmd --url https://github.com/catzoidhub --runnergroup devcatz-release `
  --name devcatz-windows-x64 --labels devcatz,devcatz-windows-x64 --work C:\DevCatz\work
```

Keep GitHub's default `self-hosted`, OS and `X64` labels. On Linux an administrator
can install/start the separate service with `sudo ./svc.sh install devcatz` and
`sudo ./svc.sh start`. On Windows use the documented service configuration prompts
with the dedicated account. Recheck actual service identity after restart, its
PATH, group placement, permissions, and work directory. Do not reuse a mailbox
runner binary directory or registration.

The pinned smoke helper checks expected identity, x64 architecture, root/admin
group exclusion (including Windows deny-only Administrators SID), installed tool
versions, and unique temporary-directory write/read/cleanup. It does not install
anything, run package-manager lifecycle hooks, or claim an Electron build passed.

Separate accounts on shared machines do **not** provide VM isolation. Authorized
release code/dependencies can persist as the runner user, tamper with later jobs,
or reach host services/network accessible to that account. Audit filesystem and
network isolation and keep mailbox secrets inaccessible; use clean dedicated VMs
if that residual risk is unacceptable. Treat a compromised runner as requiring
rebuild and credential rotation, not just workspace deletion.
[GitHub self-hosted security limits](https://docs.github.com/en/actions/reference/security/secure-use).

## Dispatch, rejection evidence and recovery

After integration onto main, policy/credential setup and provisioning, an owner
can run `gh workflow run check-runners.yml --ref main -f tag=v1.1.0` (substitute an
existing accepted tag). The workflow performs no build or publication. Record
run/job URLs, initial and triggering actors, resolved SHA, runner name, identity,
architecture, tool versions, temp probe result, and administrator policy evidence
without credentials. Native outputs/publication evidence belongs to #4/#5.

Before marking #3 verified, record controlled real runs for:

- Owner acceptance on both hosts; non-owner initial dispatch and non-owner rerun
  denied, even with repository write/admin permission; removed/pending owners denied.
- Missing/expired/under-scoped membership credential and API lookup failure denied.
- Missing tag, wrong prefix, off-main commit, mismatched manifest, and moved tag
  denied. Use disposable non-production refs for negative source tests.
- Alternate-ref dispatch of a modified wrapper/direct self-hosted job blocked by
  the group. Calling the approved reusable workflow from another ref must fail
  its gate before smoke/source execution. Also test a direct label-only request.
- After a successful hosted authorization, deliberately fail a persistent job,
  then have a non-owner rerun **failed jobs** and the **individual job**. The fresh
  first-step check must deny execution; also retest after initial owner's removal.
- Stop only the dedicated DevCatz services and dispatch a valid owner run. Jobs
  must queue for the same group/labels, never migrate to hosted build runners.
  Cancel that experiment and restore those services without touching mailbox.

GitHub currently cancels self-hosted jobs after **24 hours queued**; workflow
lifetime is also bounded. There is no infinite offline wait guarantee or automatic
hosted fallback. Redispatch from main after restoration and let validation run
again. [Actions limits](https://docs.github.com/en/actions/reference/limits).

For setup/credential failures, leave `DEVCATZ_RUNNER_POLICY_READY` unset/false and
stop DevCatz services while repairing. Never bypass membership or switch runner
groups. If a tag moved, investigate and dispatch a reviewed tag afresh. To change
the protected workflow/helper, review/test a new immutable commit, update the
allowlist and wrapper pins together, then remove obsolete workflow SHAs after
cancelling their queued/rerunnable runs. Old allowed SHAs remain executable until
removed. No production assets need be created or deleted by readiness checks.
