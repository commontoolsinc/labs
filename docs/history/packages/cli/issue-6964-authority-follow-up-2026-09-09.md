---
status: historical
created: 2026-09-09
archived: 2026-09-09
reason: "Follow-up investigation establishing authority-bearing effects of refused source preflight in #6964."
---

# Issue #6964: a refused check can publish module update authority

The initial [investigation](issue-6964-investigation-2026-09-09.md) used
different authored filenames for its current and candidate programs. That proved
the artifact-write mechanism, but did not exercise module update delegation. Its
documentation-only recommendation was too narrow.

A follow-up used `/main.tsx` for both programs and a candidate with a newly
required input. The CLI library returned `compatible: false`, yet the candidate
source document persisted `delegatedModuleIdentities` containing the current
module identity. A fresh transaction in that runtime also contained the same
successor-to-predecessor authority mapping. The source pointer and retained
argument stayed unchanged, and the runner never started the candidate.

The disposable Memory v2 server recorded one commit, six revisions, and six
added entity heads for that refused check. An open/read/close control recorded
zero writes. A broader repeated-check probe also observed changes to existing
cache heads, so the initial fixture's idempotence result cannot establish that
all authority-bearing cache metadata remains unchanged on repeated checks.

The mechanism was `checkPattern` passing `previousEntryIdentity` into ordinary
compilation. The compiler matched canonical authored filenames, derived the
successor's delegation, persisted it with the cache documents, and registered it
in the runtime before compatibility review. That also placed delegation
publication before setup validation on the apply path.

This demonstrates a durable authority-bearing side effect, not an unauthorized
user write or a demonstrated privilege escalation. No deployed space or real
Topics rehearsal clone was used.

The resulting implementation direction separated code preparation from authority
publication: preview compilation and current-source loading suppress cache
writes; ordinary compilation can persist artifacts; source setup derives an
operation-specific authority proposal and commits its metadata with the source
pointer and revision. The proposal belongs to the setup transaction until its
durable verdict. Synchronous verification of staged source metadata must not
register it globally.

Regression coverage was added for accepted and refused checks against warm,
stale, and source-only caches, fabric imports supplied as a pinned runtime
program, preview followed by normal cache recovery, rejected setup, and
concurrent updates sharing one successor. The store-level tests compare all
entity heads, revision counts, and commit counts after pending cache work and
client teardown.
