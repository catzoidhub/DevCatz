# Issue tracker: GitHub

Issues and specs live in GitHub Issues for `catzoidhub/DevCatz`.
Use the `gh` CLI from this repo; it infers the repository from the remote.

## Conventions

- Create: `gh issue create --title "..." --body-file <file>`
- Read: `gh issue view <number> --comments`; also fetch labels.
- List: `gh issue list --state open --json number,title,body,labels,comments`
  with appropriate label and state filters.
- Comment: `gh issue comment <number> --body-file <file>`
- Apply labels: `gh issue edit <number> --add-label "..."`
- Remove labels: `gh issue edit <number> --remove-label "..."`
- Close: `gh issue close <number> --comment "..."`

Use a file containing actual newlines for multiline bodies and comments.
Use `docs/agents/triage-labels.md` for triage label names.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.
