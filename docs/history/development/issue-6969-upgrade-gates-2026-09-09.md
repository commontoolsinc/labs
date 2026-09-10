---
status: historical
created: 2026-09-09
archived: 2026-09-09
reason: "Investigation of Topics upgrade refusals on the August 31 snapshot and validation of two schema-comparison fixes."
---

# Issue #6969: Topics upgrade gates

The August 31 snapshot exposed two false compatibility refusals and two real
migration requirements. The checker fixes make the snapshot's retrieved board
source checkable and allow a new optional `unknown` member demand. The current
Topics upgrade still requires an accepted contract break for the compact mention
index and the typed `shortName` demand.

## Snapshot and comparison

The local snapshot was
`topics-board-pre-mentionable-migration-2026-08-31.sqlite`, 6,105,923,584 bytes,
with its latest commit at August 31, 2026, 22:12:59 UTC. Its SHA-256, expressed
in base64url, was `ixlMZ7RJaJ-mxWPnMrdnFkc1CkoRJYTWmimrlQhcaag`.

The space was `did:key:z6MkjcdxtxTiUWkPkPffhs8ENkCcJjuRCQPpJFb2xyzwHqEk`, and
the board was `of:fid1:jtdD-DSmuGrLGSt_6sJ3DS_7jmerrkKTEnW3fZV9e34`, holding 135
topics. Its stored pattern was
`QfIxgXj389Cld21RTDiCohBXb2_Exq31rRSUH_IPS-U#default`.

The candidate fix was developed on `f0822382ef9f2d0aa9a34061240dd88e63a33263`.
Replay used Deno 2.9.4 on macOS 26.6.2 arm64, a 2,048 MiB client V8 old-space
limit, server execution disabled, CFC `enforce-explicit`, and flow labels off.
The local server bound to loopback on port 9969. Before the checks, the stopped
rehearsal store was reset with the repository's `resetClone` routine and its
bytes matched the snapshot hash.

## False refusals

### Descriptions on a defaulted union

The first topic's producer-owned `$NAME` schema and the board's retained demand
both declared `type: ["string", "undefined"]` and `default: ""`. Their
descriptions differed. The checker rejected these otherwise identical contracts
with
`a schema alternative accepted previously is not accepted by the candidate`.

The exact-equality shortcut compared the descriptions, then union expansion
copied the whole-union default onto each synthetic single-type branch. The
`undefined` branch's copied string default failed the default-safety check. Thus
a prose difference exposed a failure that equal descriptions avoided.

The fix makes schema-subtree comparison ignore the checker's validation-neutral
prose and listing annotations. Defaults, reference definitions and boundaries,
capabilities, CFC metadata, unknown constraints, and literal value contents
remain compared. This establishes equality before splitting the equivalent
union. It does not make the conservative subset prover complete for arbitrary
unions.

### Equivalent unconstrained schemas

The boolean-source branch rejected `true` against `{}` and against
`{ type: "unknown" }`. The additional-properties branch also rejected an open
source against an explicitly unconstrained additional-property schema. This made
adding an optional `unknown` demand look like a restriction.

The fix proves these cases through the existing object-schema subset machinery,
using a shared empty schema and disabling the whole-contract evolution allowance
for this strict proof. A type or value constraint beside `type: "unknown"` still
restricts values and still refuses the update.

## Real migration requirements

- `result.mentionable[].body` is removed by the compact mention index. This was
  an intentional result-contract break, documented in the
  [mention-index decision](../topics-mentionable-index-break.md). Restoring full
  topic rows to silence the checker would restore the read expansion the index
  was introduced to prevent.
- `topics.0.shortName` demands a string at a property the old producer contract
  leaves open. Optionality tolerates absence, but does not tolerate a present
  non-string value. A successful read of today's values cannot establish a
  guarantee about future producer values. This needs a producer guarantee or an
  explicitly accepted migration break.

The
[collection-naming rehearsal](../plans/collection-naming-s6-backfill-rehearsal-rerun-2026-09-06.md)
records the earlier forced rehearsal. No incompatible source update was applied
in this investigation.

## Replay results

| Candidate over the same 135-topic snapshot                                         | Patched check                                                  |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Retrieved stored board source, with its four test entries                          | Accepted, exit 0                                               |
| That source plus only `probeField?: unknown` on `TopicDemand`, with the same tests | Accepted, exit 0                                               |
| Current Topics source, with all six test entries                                   | Refused, exit 1: `mentionable[].body` and `topics.0.shortName` |

The previous replay rejected the retrieved source at `topics.0.$NAME`. Focused
regression tests reproduced both checker defects before the fixes. Source-update
tests then checked and applied a description-only update over retained member
links, admitted an optional unknown demand, and refused a typed one while
preserving the installed source and input links. Separate controls kept default
changes, changed reference targets, literal content, and capability changes from
becoming annotation-only comparisons.

## Preservation

The original snapshot and pristine copy retained their SHA-256. The board hash,
pattern pointer, argument hash, and 135-topic input matched the original after
the checks. All 108,544 original entity heads remained present without a new
tombstone.

The working store gained 169 heads and nine original heads gained revisions:
five source-module documents changed only their `imports`, and four records
belonging to the stored source module's import list changed their import link
and specifier. One of those records also changed CFC metadata. The four records
were linked from that module's import list both before and after the checks.
These compiler-cache writes mean `--check` was not a store-pure read. They did
not apply a new board source or change authored board or topic inputs.

This was a preflight investigation, not a completed migration rehearsal or a
full post-migration semantic acceptance run. The local servers and launchers
were stopped afterwards. Production was not contacted.
