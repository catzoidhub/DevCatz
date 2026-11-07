# Domain Docs

This repository uses a single-context domain documentation layout:

- `GLOSSARY.md` at the repo root defines domain vocabulary.
- `docs/adr/` holds architecture decision records.

## Before exploring, read these

Read the root glossary and ADRs relevant to the area being explored.

If a root `GLOSSARY-MAP.md` exists, follow its pointers to the relevant
context glossaries and also check `src/<context>/docs/adr/`.

If these files or directories do not exist, proceed silently. Do not flag
their absence or suggest creating them upfront. The domain-modeling skill
creates them lazily as terms and decisions get resolved.

## Use the glossary's vocabulary

Use the glossary's terms in issue titles, proposals, hypotheses, and test
names. Avoid synonyms the glossary explicitly rejects.

If a needed concept is absent, reconsider whether it belongs to the
project's vocabulary or note the gap for domain-modeling.

## Flag ADR conflicts

Explicitly identify any proposal that contradicts an existing ADR,
including the ADR reference and why the decision deserves reconsideration.
