# Plan — CFC Phase 2: per-column `ifc` for SQLite

> Phase 2 of [06-cfc.md](../06-cfc.md): honor **static per-column `ifc`** on a
> SQLite table schema. Status: **design** (pre-implementation). Grounded in a
> ground-truth recon of the runtime CFC machinery (see "What the recon found").

## Scope (honest, given the recon)

Phase 2 is exactly two things, both reusing the **existing** cell CFC machinery:

1. **Read-label propagation.** A `db.query<Row>` whose result includes a
   confidential column makes the **result cell carry that column's
   confidentiality atoms**, so any downstream `derive`/`lift`/sink that consumes
   the result inherits the label — and is then ceiling-checked by the *existing*
   sink machinery (e.g. the LLM redaction path). This is taint **propagation**,
   exactly as for cell reads today.
2. **Write-time ceiling check.** A value bound to a labeled column on `db.exec`
   must fit that column's `maxConfidentiality` and satisfy its
   `requiredIntegrity`, checked **runner-side before the op is recorded**. A
   write that would exceed the ceiling throws (aborting the commit).

### Explicitly NOT in Phase 2 (and why)

**Row filtering / "reader can't see rows they aren't cleared for" is NOT
possible in Phase 2** — the runtime has **no reader-clearance concept** today.
CFC is purely (a) output-label propagation and (b) write/sink-ceiling
enforcement; there is no read-side gate anywhere (`traverse.ts`,
`link-resolution.ts`, `cell.ts`). The only fail-closed read behavior is
LLM-sink-specific opaque-link redaction (`llm-dialog.ts`). 06-cfc.md's "rows the
reader is not cleared for are filtered (or the query fails closed)" describes a
**reader-clearance subsystem that does not exist** and would be a cross-cutting
runtime capability (affecting cells generally), not SQLite plumbing. It is
deferred as its own effort. Phase 2 ships the propagation + write-ceiling value
that the current model *does* support.

## What the recon found (the seams we reuse)

- **Label model** — `IFCLabel = { confidentiality?: atom[]; integrity?: atom[] }`
  (`runner/src/cfc/label-view-core.ts`). Atoms are immutable JSON; join = union
  with structural dedup (`cfc/observation.ts` `uniqueCfcAtoms` /
  `joinCfcObservedConfidentiality`).
- **Ceiling check** — `cfcObservationFitsCeiling(confidentiality, max)`
  (`cfc/observation.ts`): every atom must fit under `maxConfidentiality`.
  `requiredIntegrity` pattern lives in `cfc/prepare.ts`.
- **Schema `ifc` → label** — `walkIfcSchema()` (`cfc/prepare.ts`) walks a JSON
  Schema's `properties`/`$ref`/… emitting `{ path, label, schema }` per node
  with an `ifc`. `ContextualFlowControl.joinSchema` (`cfc.ts`) is the
  confidentiality-only reader.
- **Carrying a label onto a cell** — `createCell(runtime, link, tx, synced,
  kind, cfcLabelView)` already accepts a `CfcLabelView`; readers re-surface it
  via `cfcLabelViewForCell()` (`cfc/label-view.ts`). This is the propagation
  primitive for the read hook.
- **`ifc` already reaches the write path** — `table({ col: { type, ifc } })`
  carries `ifc` on the column schema (`memory/v2/sqlite/schema.ts`
  `normalizeColumn` spreads `{...spec}`), and `db.exec` forwards `handle.tables`
  into the recorded op (`cell.ts`). So the authoritative column `ifc` is present
  at the write hook with **no new plumbing**.

## Design

### Source of truth for column labels: `db.tables` (not the injected `<Row>`)

The authoritative per-column `ifc` is the one declared via `table(...)` and
carried in `db.tables`. The transformer-injected `<Row>` `rowSchema` only carries
`ifc` if the query's TS type uses CFC marker aliases (`Confidential<>` etc.), which
is not required and not the source of truth. **Both hooks read column `ifc` from
`db.tables`.** (`db.tables[<table>].properties[<col>].ifc`.)

### Read hook — propagate (sqlite-builtins.ts, result-cell construction)

Mirror the existing `asCellColumnsFromRowSchema` helper:

1. From the result rows' column set (the selected columns = the row keys / the
   `rowSchema` properties), resolve each column's `ifc.confidentiality` from
   `db.tables` (search declared tables by column name; on ambiguity, **union** —
   over-tainting is safe).
2. Join those atoms into a single confidentiality set (coarse, result-cell level
   — finer per-field labels are a later refinement; a coarse union is safe and
   matches "a derive consuming them inherits the confidentiality").
3. Build a `CfcLabelView` from that set and attach it to the **result cell**
   (`createCell(..., cfcLabelView)`), so consumers inherit it.

A query that selects no labeled column attaches no label (no over-taint).

### Write hook — ceiling check (cell.ts `exec`, before `recordSqliteWrite`)

1. Reuse `encodeSqliteParams`'s existing param→column mapping (which already
   knows each bound param's column for `_cf_link` handling).
2. For each **bound Cell** param (`asBoundCell`), read its current confidentiality
   via `cfcLabelViewForCell()`.
3. Look up the target column's `ifc` in `handle.tables`. If the value's
   confidentiality does not `cfcObservationFitsCeiling` the column's
   `maxConfidentiality`, or fails `requiredIntegrity`, **throw** (aborts the
   commit) with an actionable message.

**The label rides the data flow, not just `Cell` params (D3, resolved).** A bound
value's confidentiality is whatever the data flowing into it carries — a bound
`Cell` (`cfcLabelViewForCell`) OR a plain value derived from reading confidential
cells (the handler's observed confidentiality). So the write check consults the
**flow/observed label** of each bound value, not an `asBoundCell`-only check, and
does NOT special-case bare literals (a literal simply carries no label). This
aligns the write check with how the existing LLM sink computes confidentiality
(`cfcConfidentialityForObservationNode` + ceiling).

### Sink-request seam: NOT wired in Phase 2

`recordSqliteWrite` records no CFC state today. The sink-request seam
(`cfc/sink-request.ts`) is a post-commit *release gate on outbound effects*, not
a per-field ceiling check. Phase 2's write check is a **direct runner-side check**
before recording the op — simpler and sufficient. Wiring SQLite writes into the
CFC write-policy inputs (for audit/attempted-target capture) is deferred.

## Open decisions (for sign-off before build)

- **D1 — column-label source = `db.tables`** (authoritative), not the injected
  `<Row>`. *Recommended; low controversy.*
- **D2 — coarse result-cell label** (union of all selected labeled columns) vs.
  per-field labels on the result structure. *Recommend coarse for Phase 2*
  (safe over-taint; per-field is a refinement).
- **D3 — [resolved] label rides the data flow, not just cells.** The write check
  uses each bound value's flow/observed confidentiality (cells AND values derived
  from confidential reads); no cell restriction and no special literal handling (a
  literal carries no label).
- **D4 — multi-table / computed columns.** A `SELECT` with a join or an
  expression column whose name isn't in any `db.tables` table → no label found.
  *Recommend: unknown columns contribute no label in Phase 2* (documented gap;
  expression/joined confidential data is a Phase 3 concern).

## Phasing within Phase 2 (shippable steps)

1. **Read propagation** (the safe, observable half): result cell carries column
   confidentiality; an integration test shows a `derive` consuming a confidential
   column inherits the label, and a sink (or a `maxConfidentiality` output)
   rejects/redacts it. No behavior change for unlabeled schemas.
2. **Write ceiling check**: reject a bound cell whose confidentiality exceeds a
   column's `maxConfidentiality`; unlabeled columns unaffected.

Each is its own commit/PR-able unit with red→green tests.

## Phase 3 preview — per-row label projection (NOT this PR)

The compelling next step: derive a row's label from its own column values, e.g.
an email row's integrity = `AuthoredBy: did:mailto:<from_email>` and
confidentiality = sender ∪ recipients ∪ user. Recon conclusion on "does this need
query parsing?": **no, for the common path** — the projection is a pure function
of row *values* (write: the inserted row's params; read: each result row), so it
evaluates without parsing SQL. The constraints are *value availability*, not
parsing:
- A `SELECT` must include the label-source columns (`from_email`, …) or the row
  can't be labeled → fail closed / require them.
- A partial `UPDATE` (`SET body=? WHERE …`) whose label depends on a column it
  doesn't set needs the **pre-image row** — the only case that edges toward query
  semantics. Escape: require the label-source columns to be supplied (reject
  otherwise), avoiding a parser entirely.

Phase 3 design comes after Phase 2 lands.

## Test plan

- Unit: label-from-`db.tables` resolver (selected-columns → confidentiality
  union); write-ceiling predicate (fits / exceeds / requiredIntegrity).
- Runner integration: (a) `db.query` of a confidential column → result cell label
  carries the atom → a downstream consumer inherits it; an unlabeled query carries
  nothing. (b) `db.exec` binding an over-confidential cell to a labeled column
  throws; a within-ceiling write succeeds; unlabeled column unaffected.
- Regression: existing sqlite + cf-link suites stay green (no behavior change when
  no `ifc` is declared).
