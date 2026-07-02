# Reactive Interpreter v2 — implementation tracking

Source of truth for implementation state. The design docs (../*.md) describe
the end-state; **this directory records what is actually built, in what
order, and every divergence** (v1 discipline, kept).

- [`DECISIONS.md`](./DECISIONS.md) — decision log. Append-only, dated, with
  evidence.
- [`PROGRESS.md`](./PROGRESS.md) — live status per work order + measured
  numbers.

## Branch strategy (decided 2026-07-02)

Build on `claude/priceless-rubin-89ad5e` — it is `origin/main` (0cf48b278) +
the v2 spec. The #4298 branch (`claude/nervous-kilby-83b75b`, checked out
read-only in the session scratchpad) is the **harvest source**: files are
ported selectively and adapted to current main, never merged wholesale.

## Work orders (refined sequencing — see DECISIONS D-V2-SEQ)

The 06-migration-plan V0–V6 ordering is refined here into the lower-risk
**builder-first** path: the ROG is born at *pattern-construction time* in the
builder (which compiled patterns execute too), so the entire IR pipeline
works before any transformer change, and extraction never exists.

| WO | Contents | Gate |
| --- | --- | --- |
| **W0** | This plan + decision seed | — |
| **W1** | IR v2 core types (`packages/runner/src/reactive-interpreter/rog.ts`, ported from #4298 + 02-ir deltas: tagged control, effect contracts, leaf caps, fn/call, result-refs) + unit tests | Types compile; helpers unit-tested |
| **W2** | **Builder-born ROG**: builder factories record ops during `pattern()` construction; result tree walked to ValueRefs at finalization; `rog` attached to the Pattern and serialized as a versioned optional field (identity-neutral — MUST NOT change pattern hashing); construction census | Flag-off byte-identical (ROG inert); census shows ops recorded for the corpus; root `deno task test` green |
| **W3** | **Flag-on dispatch**: port `partition.ts` + `interpret.ts` (evalRog); dispatch at `instantiatePattern` behind `experimentalInterpreter` using the builder-born ROG; segment emission behind a narrow runner seam; **measurement harness ported FIRST** (doc#/node#/wall census + doc-explosion baseline) | Differential oracle flag-on == flag-off; measured node/doc deltas recorded in PROGRESS; root `deno task test` + `deno task integration` green both flags |
| **W4** | Collections Option A: per-element docs/effects on builder-born inline element ROGs; consolidated raw VNode writes; element-cell GC; pointwise CFC oracle + broken-mirror | Pointwise oracle green; rendered-map docs ≤ legacy; grow/shrink/reorder oracle |
| **W5** | Transformer native ops: emit dedicated builder calls for operators/str (no branded-lift dual encoding); shared allow-list registry | v1 §08 parity (str/operator leaves → 0) without SES; goldens; ts-transformers suite green |
| **W6** | Function lowering: const-SSA bodies, early-return chains, pure-method stdlib `call` registry, same-bundle `fn`/`call` | Per-entry oracle rows; compile-time opaque census asserted; loaded-pattern SES-leaf count strictly decreasing |
| **W7** | Continuous: root suites green both flags; multi-user chat simulation at milestones; measurements tracked | See cadence below |

Later (unchanged from 06-migration-plan): R-SEAM-2 delta, R-SEAM-3 + O(1)
containers decision point, checkpoint tier, legacy-node retirement
(ROG→nodes expander becomes relevant only at that final stage).

## Test + measurement cadence (user directive, 2026-07-02)

- `deno task test` (repo root) and `deno task integration` (repo root):
  **regularly** — at minimum per work-order landing, both flag states once
  W3 exists.
- Multi-user chat simulation at milestones:
  `deno task integration pattern-tests cfc-group-chat-demo/multi-user`
  flag-off AND flag-on (the v1 ~226× pathology repro — watch it from the
  moment W3 lands, not at the end).
- Instrument doc#/node#/wall-time from W3 day one; every PROGRESS entry
  carries numbers, OFF vs ON, same commit.
