# 06 — CFC (deferred phase)

CFC enforcement is **out of scope for v1** but the API is shaped so it slots in
without rework. Once added, it covers **both confidentiality and integrity**,
**per column** and **per row**.

## Background: the existing label model

CFC labels are open-ended sets of **atoms** (immutable JSON values), not a fixed
classification lattice
([`packages/runner/src/cfc.ts`](../../../packages/runner/src/cfc.ts);
`packages/api/cfc-atoms.ts`). A schema attaches labels through its `ifc` field
([`packages/api/index.ts`](../../../packages/api/index.ts)):

- `confidentiality` — who may read (set of atoms; principals are common atoms,
  e.g. `did:mailto:…`, `did:key:…`).
- `integrity` / `addIntegrity` / `requiredIntegrity` — provenance/authenticity
  guarantees.
- `maxConfidentiality` — a ceiling the output may not exceed.
- `ownerPrincipal`, `writeAuthorizedBy` — access/authorization control;
  `{ __ctCurrentPrincipal: true }` resolves to the acting principal at
  prepare-time.

Labels join by **union with structural dedup** (`deepEqual`), and confidentiality
is checked by "every atom in the label fits under the destination's
`maxConfidentiality` ceiling." Async effects already declare a **write policy**
before committing side effects via the sink-request mechanism
([`packages/runner/src/cfc/sink-request.ts`](../../../packages/runner/src/cfc/sink-request.ts)),
which is the seam SQLite writes will use.

## Per-column labels

A column's label is declared on the table/row schema's `ifc`, reusing the exact
mechanism schemas already support. `cfLink<T>()` and `table(...)` (Section
[01](./01-api.md)) pass `ifc` through per field:

```tsx
const EmailRowSchema = table({
  id: "integer",
  subject: { type: "text" },
  // body is confidential to a fixed support principal
  body: { type: "text", ifc: { confidentiality: [supportPrincipalAtom] } },
  from_email: { type: "text" },
});
```

On **read**, columns labeled confidential contribute their atoms to the result
cell's label, so a `derive` consuming them inherits the confidentiality (label
propagation, exactly as for cell reads today). On **write**, a value bound to a
labeled column must satisfy that column's `requiredIntegrity` / ceiling.

This is a clean fit because the row schema is *already* a JSON Schema and `ifc`
is *already* understood by `ContextualFlowControl`.

## Per-row labels derived from a field

The motivating case: an email row's confidentiality should be to the user, the
sender, and all recipients — constructed from row data, e.g.
`"did:mailto:" + from_email`. This is **data-dependent**, so it cannot be a
static schema label; it must be computed from the row's values at write time and
re-derived at read time.

Proposed surface: a **row-label rule** on the table schema that maps row fields
to label atoms. It is a declarative projection (so it can run on the server
during the commit and during reads) rather than arbitrary pattern code:

```tsx
const EmailRowSchema = table(
  {
    id: "integer",
    from_email: "text",
    to_emails: "text", // JSON array of addresses
    body: "text",
  },
  {
    // Per-row confidentiality derived from row fields.
    rowConfidentiality: (row) => [
      principal(row.from_email),          // "did:mailto:" + from_email
      ...jsonArray(row.to_emails).map(principal),
      currentUserPrincipal(),             // resolves to the viewing/owning user
    ],
  },
);
```

Semantics:

- **On write**, the rule is evaluated against the inserted/updated row to
  produce the row's confidentiality atom set, recorded as the write's CFC
  policy input via the sink-request path before commit. The write is rejected if
  it would exceed the destination ceiling or fail required integrity.
- **On read**, the same rule re-derives each row's label from its column values,
  and the row's cell label is the **join** of the per-column labels and the
  per-row label. Rows the reader is not cleared for are filtered (or the query
  fails closed), per the standard confidentiality check.
- The rule must be a **pure projection over the row's own fields** (plus
  runtime-resolved principals like `currentUserPrincipal()`), so it is
  evaluable both server-side at commit and client-side at read without running
  pattern code. Helpers like `principal(field)` compile to
  `"did:mailto:" + field` (or `did:key:` etc. by helper variant).

## Why this stays declarative

Keeping row labels as a declarative projection (rather than a callback into
pattern code) lets the **server** evaluate them at commit time — necessary
because the atomic write happens inside `applyCommitTransaction` server-side
(Section [04](./04-server-execution-and-transactions.md)), where pattern code
does not run. It also makes labels auditable: a row's confidentiality is a pure
function of its stored columns, recomputable at any time.

## Phasing

1. **v1 (this spec):** no enforcement; `_cf_link` round-tripping only. Schemas
   *may* carry `ifc` but it is ignored.
2. **Phase 2 — per-column:** honor static `ifc` on columns for read-label
   propagation and write-time checks, reusing `ContextualFlowControl` and the
   sink-request write policy.
3. **Phase 3 — per-row:** add the row-label projection, evaluated at commit and
   read; integrate with row-level filtering/fail-closed reads.
