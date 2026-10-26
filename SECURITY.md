# Security

DevCatz runs on your Mac with access to things that matter — it runs your local PHP, Node, Python and Go sites, keeps a local certificate authority that your browser trusts, and can install system helpers (LaunchDaemons for clean URLs, a resolver for a custom domain) with your administrator password. A security problem in it is taken seriously.

## Reporting a vulnerability

**Please do not open a public issue.** Report it privately instead:

1. Open the repository's **Security** tab → **Report a vulnerability**
   ([direct link](https://github.com/catzoidhub/DevCatz/security/advisories/new)). Only the maintainer sees it.
2. Say what is affected, how to reproduce it, and what an attacker could do with it. A proof of concept helps.

Security reports are read before anything else, as soon as the maintainer can — there is no fixed response time yet.
Together we agree on a fix and when to publish it; you are credited in the advisory and the release notes unless you
would rather not be.

## What is in scope

- The DevCatz app and its updater (the update feed and the downloaded update are checked before they install).
- Anything that would let a web page, another app or a crafted file make DevCatz do something you did not ask for —
  deep links (`devcatz://`), imported files, the local services it runs.
- Secrets leaving your Mac: the local CA's private key, the AI key in the "Catzoid AI" Keychain item, git host and tunnel tokens, database passwords.
- The system changes DevCatz makes with your password (see [What DevCatz changes on your Mac](https://catzoid.com/docs/security)) — anything that lets them do more than they say, or lets someone else trigger them.

Out of scope: problems that need someone who already controls your Mac or your user account, and vulnerabilities in
third-party software DevCatz installs or talks to (report those upstream — we are happy to help).

## Supported versions

Only the **latest release** gets security fixes; the app updates itself, so please stay on it.
