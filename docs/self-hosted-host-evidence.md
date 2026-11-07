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

The mailbox runner service remained active before and after provisioning. No
mailbox account/service/registration was changed. Its runner configuration file
is readable by other local users; its private authentication key and home are
inaccessible to `devcatz`. Full filesystem/network isolation has not been audited.

## Windows

Administrative SSH access and Windows Server 2022 Datacenter x64 were verified.
The existing mailbox runner service was running as its separate `gha-mailbox`
account. Approximately 445 GiB was free. No DevCatz account or directory existed
at this baseline; Windows provisioning and account readiness remain pending.

## Remaining evidence

No DevCatz runner is registered or enabled. Organization runner-group permissions
are blocked by the current GitHub credential's missing administration scope;
environment policy, a dedicated membership-read credential, and runner-group
enforcement still require configuration and live verification. Neither native
build, optional signing, workflow rejection/rerun/offline checks, nor controlled
release publication has been exercised. No release assets were changed.
