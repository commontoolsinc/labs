# A′ Master Handoff — transform-time authored source locations (2026-07-07)

**Read this first.** It is the canonical carry-forward for the **A′ work-line**
(inject the *authored* source location at transform time so debug `fn.src` is
correct and free, then delete the eager runtime resolution) and its
prerequisite, the **transformer lineage fix**. Every claim in §2–§5 was
re-derived on `main` @ `39afdb62b` (2026-07-07) with the probe rig in §3 —
line numbers will drift; the rig is how you re-pin them. This doc supersedes
the memory file `project_aprime_lineage_workline.md` (retired) and the
workspace seed `APRIME-LINEAGE-SEED.md` (L-cf-repos, 2026-07-06).

Related merged context: #4458 (lazy/debug-only `fn.src`; production skips
per-primitive resolution; identity re-rooted on content-addressed
`{identity, symbol}` — see `cfc/implementation-identity.ts`), #4436 (identity
re-root). Sibling, NOT part of A′: CT-1819 lazy source-map compose (PR #4560,
open as of this writing) — do not merge scopes.

---

## 0. TL;DR

- **A′ is a debug-correctness line, not a boot-floor line.** The boot-floor
  arc is merged and done (~165ms floor, ~25ms/cold-boot banked by #4458 —
  historical numbers, re-derive before quoting). What remains wrong: dev
  builds still pay eager `.src` resolution
  (`EXPERIMENTAL_EAGER_SOURCE_ANNOTATION`, on by default in dev —
  `packages/shell/src/lib/env.ts`, gate in `packages/runner/src/builder/module.ts`
  `setEagerSourceAnnotation`), and what it computes is often wrong (historical
  finding: 64/82 lunch-poll primitives hit the expensive fallback; the 18
  "cheap successes" all returned the same colliding runtime-factory frame).
- **The prerequisite**: transform-time injection needs the transformer
  pipeline to know, at the hoisting stage, where each builder call/callback
  was authored. Probe-verified on current main: **it doesn't** — all hoisted
  builder origins arrive at `BuilderCallHoistingTransformer` (stage 14) with
  `pos=-1`, no `sourceMapRange`, no original chain.
- **The law behind the breakage** (cleaner than the inherited three-site
  diagnosis): TS `factory.update*` preserves textRange + original-chain
  automatically; `factory.create*` yields bare nodes. The pattern-body path
  uses `update*`/`preserveNodeSourceMap` throughout and stays healthy (a
  probe-observed 6-deep original chain still roots at the authored arrow);
  the closure strategies and SchemaInjection use `create*` **with the anchor
  node in scope and discarded** at every site. SchemaInjection is a second,
  independent strip layer the inherited diagnosis missed: a fix at the
  strategy sites alone still arrives at stage 14 with nothing.
- **Scope decision: narrow-first** — fix the enumerated builder-path sites
  (§5) with a shared `preserveLineage` helper (§6); price "broad" (every
  replacement node pipeline-wide) from the sweep in §7 and ticket it
  separately unless it turns out nearly free. Decision rationale in §7.

## 1. Value proposition (what A′ buys once lineage is fixed)

1. Debug-time `fn.src` becomes *truthful* (today's cheap path returns
   colliding runtime-factory frames; `INTERNAL_SOURCE_LOCATION_FRAME_PATTERNS`
   filters `factory.ts` but not `module.ts`; eval-frames mostly don't
   canonicalize — CT-1754 machinery).
2. Kills the dev-build eager resolution cost entirely (annotation becomes a
   transform-time constant read).
3. Unblocks seefeld's original directive — "remove the expensive fallback and
   error instead" — which was always gated on the cheap path being correct.
4. Carries the empty-`fn.name` debug-name gap (#4458 follow-on): hoisted
   `__cfLift_N` names replaced authored names in debug output. The original
   chain reaches the authored *node*, not just a position, so the authored
   binding name is recoverable at the same injection point.

## 2. Probe findings on main @ 39afdb62b (re-derived 2026-07-07)

Fixture: five authored origins (see §3). What arrives at stage 14
(BuilderCallHoisting), per probe:

| Authored origin | At stage 14 | Lineage dies at |
| --- | --- | --- |
| `computed(() => …)` (×2) | hoisted `__cfLift_1/2`: NOTHING | **LiftAppliedStrategy** (stage 8). Probe in/out: enters with FULL lineage (stage-7 lowering preserves the triple), exits bare. |
| inline JSX expr `{count * 3}` | hoisted `__cfLift_3`: NOTHING | Born mostly bare in **expression-rewrite emitters** (stages 9–10); the inner call *is* born with smr via `createHelperCall`, which **SchemaInjection** (stage 13) then strips. |
| `.map((item) => <li>…)` in JSX | hoisted `__cfPattern_1`: original chains exist but root in synthetics | **ArrayMethodStrategy** (stage 8). Probe in/out: enters as the authored node, exits bare. |
| module-scope `handler(…)` (in-place) | call: NOTHING; **callback: authored pos survives** (30:60) | Call wrapper rebuilt by **SchemaInjection**'s handler schema-prepend (`schema-injection.ts:3190` family — the prepended two-schema shape matches the emitted output); callback never rebuilt. |
| `export default pattern(…)` (in-place) | call: depth-1 chain to synthetic; **callback: authored pos + 6-deep chain** | Callback preserved correctly by the pattern-body path (precedent, §6); call wrapper stripped like the handler's. |

Key mechanism notes:

- Stage 7 (`lift/transformer.ts` `finalizeLoweredCall`) does the full triple —
  `setTextRange` + `setSourceMapRange` + `setOriginalNode` — and the probe
  validates the instrument against it (lineage there is true *by
  construction*; if the probe reports nulls there, the probe is broken).
- `CfHelpers.createHelperCall` smr-preserves everything it builds (anchored to
  its `originalNode` arg). That smr is the most fragile channel: it lives on
  `emitNode`, which nothing copies — any later `create*` rebuild silently
  drops it. That is exactly what SchemaInjection does.
- The hoisting stage itself is lineage-neutral (it relocates the inner call
  node and `update*`s the site) and already uses `setOriginalNode` for
  checker-identity (`__cfLift_N` identifier → inner call, so
  `detectCallKind`/`resolveBuilderExpressionKind` classify the applied hoist).

Inherited-diagnosis scorecard (Opus line, 2026-07-02, secondhand): all three
cited rebuild sites confirmed live (the pattern-builder citation's
`setParentPointers` detail was seed-compression garble — the real point, its
two `createArrowFunction`/`createFunctionExpression` returns, is right and
they are the chokepoint). Missed: the SchemaInjection second layer; the
in-place-callback survival; the update*-vs-create* law.

## 3. The probe rig (re-run recipe)

The instrumentation is temporary and NOT left in the tree; this section is the
complete recipe. (The fix PR should graduate it into a proper regression test —
a stage-14 assertion fixture; see §8.)

1. **Fixture** — `packages/patterns/aprime-lineage-probe-fixture.tsx`
   (untracked), one authored builder per origin path:

   ```tsx
   import { computed, Default, handler, NAME, pattern, UI, Writable } from "commonfabric";
   interface ProbeInput {
     count: number | Default<0>;
     label: string | Default<"probe">;
     items: string[] | Default<[]>;
   }
   // ORIGIN-C: authored handler (module scope, applied in JSX)
   const bump = handler<unknown, { count: Writable<number> }>((_, state) => {
     state.count.set(state.count.get() + 1);
   });
   export default pattern<ProbeInput>(({ count, label, items }) => {
     // ORIGIN-A: authored computed with capture
     const doubled = computed(() => count * 2);
     return {
       // ORIGIN-N: authored computed template
       [NAME]: computed(() => `probe ${label}`),
       [UI]: (
         <div>
           <span>{count * 3}</span>{/* ORIGIN-B: inline reactive expr */}
           <b>{doubled}</b>
           <ul>{items.map((item) => <li>{item}</li>)}</ul>{/* ORIGIN-D */}
           <cf-button onClick={bump({ count })}>bump</cf-button>
         </div>
       ),
       count, label, items,
     };
   });
   ```

2. **Probe module** — `packages/ts-transformers/src/lineage-probe.ts`
   (untracked), env-gated (`CF_LINEAGE_PROBE=1`), reporting per node: kind,
   `pos..end`, explicit smr (detect via `ts.getSourceMapRange(n) !== n` —
   the API returns the node itself when unset), original-chain depth +
   terminal, and `recovered` = what the best-available position points at in
   authored text (line:col + snippet). **Content is the ground truth**: a
   `pos >= 0` pointing at the wrong text is still broken lineage.

3. **Insertion points** (all one-liners plus imports):
   - `transformers/builder-call-hoisting.ts` — in the visit loop right after a
     `HOISTABLE_BUILDERS` spec resolves (probe visited/inner/callback, tagged
     `hoist:<name>`); in the statement loop for in-place authored builder
     consts (inside `collectTopLevelBuilderArtifactNames`'s builder branch,
     tagged `authored:<name>`) and for `export default <call>` (tagged
     `authored:export-default`).
   - `lift/transformer.ts` `finalizeLoweredCall`, after the triple-set —
     the **instrument-validation** probe (`lower:computed`).
   - `closures/transformer.ts` strategy dispatch, when
     `transformed !== node` — in/out pairs tagged
     `closure:<StrategyName>` (this is what pins stage-8 kill sites).

4. **Run**:

   ```bash
   CF_LINEAGE_PROBE=1 deno task cf check \
     packages/patterns/aprime-lineage-probe-fixture.tsx --no-run 2>&1 \
     | grep lineage-probe
   ```

   Validate the instrument first: the `lower:computed` lines MUST show
   `pos>=0`, explicit smr, `origDepth=1`, `recovered=self→<authored line>`.
   Only then trust downstream `NONE`s. Emitted-output inspection idiom, as
   ever: `--show-transformed --no-run | deno task cf view`.

## 4. Acceptance criterion for the lineage fix

Re-run the §3 probe: every `hoist:*` and `authored:*` line — outer/inner call
AND callback — reports `recovered=` pointing at the correct authored snippet
(the origin markers make correctness eyeball-able). Plus the standard full
gate (§8).

## 5. The narrow fix set (all sites probe- or read-verified on 39afdb62b)

One shared helper (§6) applied at the sites below. Anchor = the authored-or-
predecessor node, verified in scope at each site.

| # | Site | Materializes | Anchor in scope | Fix shape |
| --- | --- | --- | --- | --- |
| N1 | `closures/utils/pattern-builder.ts:170` (`buildCallback`) and `:316` (`buildHandlerCallback`) | every rebuilt closure callback (computed-origin, array-method, inline-handler — all strategies route through here) | `originalCallback` param | `preserveLineage` on the returned function |
| N2 | `closures/strategies/lift-applied-strategy.ts:587` | outer lift-applied call | `inputCall` | `preserveLineage` |
| N3 | `transformers/expression-rewrite/rewrite-helpers.ts:160` / `:177` | wrapper arrow + outer applied call | `expression` | `preserveLineage` |
| N4 | `transformers/builtins/lift-applied.ts:224` / `:270` | wrapper arrow + outer applied call | `expression` | `preserveLineage` |
| N5 | `closures/strategies/array-method-transform.ts:297` | `mapWithPattern` call | `methodCall` | `preserveLineage` |
| N6 | `closures/utils/capture-scaffold.ts:54` | outer applied handler call (inline-closure handlers) | `originalNode` | `preserveLineage` (direct parallel of N2/N3/N4 outers; sweep-found, spot-verified) |
| N7 | `transformers/schema-injection.ts` builder-call rebuild family: `:1489`, `:2379–:2410` (self-verified) + `:2728`, `:3190`, `:3289`, `:3520`, `:3729`, `:3818`, `:3895`, `:3985`, `:4080` and cluster `:985`, `:3782` (sweep-enumerated; `:2728`/`:3190` spot-verified — re-verify each at implementation) | every builder call SchemaInjection rebuilds to splice/prepend/append schemas — the immediate predecessor of the hoisting stage, so this family alone strips whatever survives stages 8–12 | `node` / `innerLiftCall` | **create→`factory.update*`** (these are literally update-the-arguments operations; update* preserves textRange+original for free) |
| N8 (optional strengthener) | `core/cf-helpers.ts` `createHelperCall` | inner helper calls | already smr-anchored | pass `identityNode` so the original-chain rides too |

"Narrow" here means **builder-path-complete**: every site that materializes or
rebuilds what `BuilderCallHoistingTransformer` consumes (builder calls, inner
calls, callbacks — hoisted AND in-place). ~22 edit sites total, the
schema-injection family being mechanical create→update conversions.

Notes:
- N6/N7's `update*` switch also future-proofs against the smr-fragility class:
  once nodes carry textRange+original, later `update*` rebuilds preserve them
  with no cooperation needed.
- `setParentPointers` at the existing call sites is orthogonal (tree
  navigability, not lineage) and stays as-is.

## 6. `preserveLineage` design (and why `preserveNodeSourceMap` stays)

```ts
// ast/utils.ts (next to setParentPointers; export via ast/mod.ts)
/**
 * Carry full lineage from `origin` onto a synthesized replacement/reification
 * of it: textRange (pos/end), sourceMapRange, and the original-node chain.
 * `origin` is the node this one replaces in the emitted tree (or reifies,
 * e.g. a wrapper arrow whose body is the authored expression). `origin` may
 * itself be synthetic mid-chain — the channels compose (original chains
 * extend; getSourceMapRange propagates; a -1 textRange copies as a no-op
 * while recovery still works through the chain).
 */
export function preserveLineage<T extends ts.Node>(node: T, origin: ts.Node): T {
  return ts.setOriginalNode(
    ts.setSourceMapRange(
      ts.setTextRange(node, origin),
      ts.getSourceMapRange(origin),
    ),
    origin,
  );
}
```

Precedents in-tree: the full triple at `lift/transformer.ts`
`finalizeLoweredCall` (stage 7, probe-validated); the healthy pattern-body
path (`pattern-callback-lowering.ts` / `pattern-callback-transform.ts` /
`pattern-body-reactive-root-lowering.ts` — `update*` + `preserveNodeSourceMap`
throughout).

**Naming rationale — two helpers, two concepts, not weak-vs-strong:**

- `preserveLineage(node, origin)` = **provenance**: "in authored text I was
  born there, as that node." For replacement-materialization sites, where the
  provenance target and the checker-identity target are the same node.
- `preserveNodeSourceMap(node, originalNode, identityNode?)` = the resolution
  for sites where the two concerns **diverge**: a node has exactly one
  `original` pointer, so when position should map to the authored expression
  but identity must point elsewhere (e.g. `getHelperExpr` pointing a fresh
  `__cfHelpers` identifier's original at the module's helper binding so the
  checker resolves it), position goes via smr and original carries identity.
  Same move as builder-call-hoisting's `setOriginalNode(name, innerCall)`.
  Keep the name for now; a follow-up may fold its non-identity uses into
  `preserveLineage` and rename what remains (candidate:
  `preserveSourceMapRange`, aligning with the TS API it wraps). Reading note:
  its `ts.getSourceMapRange(x) ?? x` has a dead `??` — `getSourceMapRange`
  never returns undefined.

**Hazards (why this isn't a mechanical sweep):**

- `setTextRange` on synthetics feeds sourcemaps/diagnostics/`getText()`. Fine
  when the anchor is the true semantic predecessor; subtly wrong spans when
  it isn't. Anchor discipline is the mitigation.
- `setOriginalNode` is **not inert metadata**: existing code consults original
  chains for semantic fallback (`lift-applied-strategy.ts:522` checks the
  original's explicit return type; scope-analysis and the builder-kind
  resolver walk originals). Giving rebuilt nodes real originals feeds those
  fallbacks new — almost certainly more-correct — answers. Mostly a feature;
  reason for the full gate per site and for broad needing per-site judgment.

## 7. Narrow vs broad — decision and pricing

**Decision: narrow-first (the §5 set), broad as a separately-ticketed sweep.**
Rationale: the narrow set is complete against direct probe evidence, every
site has its anchor in hand, and it fully unblocks A′. Broad (every
replacement node pipeline-wide carries lineage) dissolves the bug-class and
is worth doing, but each site needs individual anchor-correctness judgment
(see hazards, §6) — a wrong anchor produces wrong sourcemap spans, worse than
absent ones. Contingency honored from the seed: fold broad in now ONLY if the
sweep prices it nearly-free.

**Sweep results (read-only Opus survey, 2026-07-07, on 39afdb62b; three
claims spot-verified exactly — treat the rest as a work list to re-verify at
implementation):**

- **Folded INTO narrow** (builder-path): the schema-injection builder-call
  rebuild family (~11 sites, §5 N7) and `capture-scaffold.ts:54` (§5 N6).
  The sweep's key structural point: SchemaInjection (stage 13) is the
  immediate predecessor of BuilderCallHoisting (stage 14) and rebuilds
  essentially every builder call bare — it alone re-strips anything stages
  8–12 preserve, which is why the original three-site diagnosis could never
  have been sufficient.
- **Remaining for broad** (~15–18 sites, none A′-gating, none structurally
  hard — an anchor is in scope at every one):
  - `pattern-body-reactive-root-lowering.ts` key()-lowering replacements
    (`:360`, `:853/:858`, `:895`) + destructured-binding decls
    (`:659/:666/:682`). Natural chokepoint: `registerReplacementType`
    (`:124`) already receives the original node and could attach lineage for
    all of them.
  - `ui-helper-lowering.ts:85/:96` (lowered `<ct-…>` JSX elements).
  - JSX container rebuilds: `jsx-expression-site-router.ts:66/:86`,
    `expression-site-lowering.ts:572/:903`, `handler-strategy.ts:85/:90`
    (all have `update*` drop-ins).
  - `array-method-transform.ts:93` (receiver `key()` rewrite),
    `module-scope-cf-data.ts:138` (wrapper, borderline additive).
  - Caveat to carry: `ifelse.ts` when/unless helpers anchor on `condition`
    (left operand), not the whole expression — fine for emit, worth a look
    when broad lands.
- **Excluded correctly** (sweep audit list retained in the session record):
  expression-rewrite emitters (delegate to known sites), reactive-variable-for
  (already fully preserved), type-position construction, additive schema/
  coverage/hardening/shadowing machinery, analysis-only stages.

**Final call: narrow-first stands, with "narrow" = builder-path-complete
(§5).** Broad is real but not nearly-free: it roughly doubles the diff into
exactly the sites where anchor-judgment is subtlest (containers, key()
lowering), and none of it gates A′. It gets its own ticket with the sweep
table as the work list, sequenced after A′'s injection design rather than
before.

## 8. Verification discipline for the fix PR

- Full gate before green: fmt + lint + check + the FULL ts-transformers suite
  (not targeted tests) — transformer output is load-bearing for everything
  downstream.
- The §3/§4 probe as acceptance; graduate it into a tracked regression test
  (stage-14 fixture asserting recovered-authored positions for all five
  origins) rather than leaving instrumentation ad hoc.
- Emit sanity: `--show-transformed` diff on a corpus pattern (e.g.
  `age-category.tsx`) should be **byte-identical** pre/post fix — lineage
  channels are emit-map metadata, not output text. Any text diff is a bug.
- Sourcemap spot-check in a dev shell (positions in devtools land on authored
  lines for a rebuilt callback).

## 9. The A′ line proper — shape of remaining work (post-lineage)

1. **Lineage fix lands** (§5–§8). Everything below reads positions through it.
2. **Transform-time injection design** (the next design conversation):
   - *Where to inject*: at `BuilderCallHoistingTransformer`, which already
     visits every hoisted builder AND every in-place/authored builder
     (`collectTopLevelBuilderArtifactNames`) AND `export default pattern(…)`;
     recovered authored position = walk `getOriginalNode`/smr of the inner
     call + callback (the §3 probe's `recovered` logic is the prototype).
   - *What shape*: open — candidates: extra argument on the builder call
     (schema-injection-style splice; runtime signature change), a property in
     the `__cfReg` registration (registrar contract change — note exported
     builders bypass `__cfReg`, so registration-only coverage is incomplete),
     or a sibling annotation call. Decide with runner owners; the
     `{identity, symbol}` provenance plumbing from #4436/#4458 is the natural
     rendezvous.
   - *What content*: file + line:col of the authored callback (and the
     authored binding name — closes the empty-`fn.name` debug-name gap).
3. **Runtime read side**: `fn.src` lazy getter reads injected data instead of
   eval-frame resolution (CT-1754 machinery in `harness/engine.ts` becomes
   dead on this path).
4. **Delete the dev-build eager resolution**:
   `EXPERIMENTAL_EAGER_SOURCE_ANNOTATION` and `setEagerSourceAnnotation`
   gate (~25ms dev cold-boot, historical — re-derive).
5. **seefeld's directive**: remove the expensive fallback; error instead.
   Gated on 2–3 making the cheap path correct.
6. **Boundaries**: CT-1819 / PR #4560 (lazy source-map compose) is a sibling —
   don't re-tread composition here. `~/coding/L-cf-repos/ct1848-repro/` is
   another line's preserved repro kit — don't touch.

## 10. Tickets & memory

Filed 2026-07-07:

- **[CT-1868](https://linear.app/common-tools/issue/CT-1868)** — the narrow
  lineage fix: `preserveLineage` helper + the §5 builder-path-complete site
  set (create→update in SchemaInjection). Acceptance = §4, verification = §8.
- **[CT-1869](https://linear.app/common-tools/issue/CT-1869)** — the broad
  sweep, carrying the §7 work list. Related to CT-1868; sequenced after A′'s
  injection design.
- **[CT-1870](https://linear.app/common-tools/issue/CT-1870)** — A′ proper
  (§9.2–9.5 + the empty-`fn.name` gap). Blocked by CT-1868; related to
  CT-1819 (sibling boundary).

Memory: `project_aprime_lineage_workline.md` in the canonical store is
retired in favor of this doc once tickets exist (pointer line in MEMORY.md
updated to reference this file + ticket IDs).

## 11. Appendix — probe module source (for §3.2)

`packages/ts-transformers/src/lineage-probe.ts`, exactly as used for the §2
findings (env-gated; safe to leave imported only while probing):

```ts
import ts from "typescript";

const ENABLED = typeof Deno !== "undefined" &&
  Deno.env.get("CF_LINEAGE_PROBE") === "1";

export function lineageProbeEnabled(): boolean {
  return ENABLED;
}

function kindName(n: ts.Node): string {
  return ts.SyntaxKind[n.kind] ?? `kind#${n.kind}`;
}

function originalChain(n: ts.Node): ts.Node[] {
  const chain: ts.Node[] = [n];
  let cur = n;
  // deno-lint-ignore no-explicit-any
  while ((cur as any).original && chain.length <= 16) {
    // deno-lint-ignore no-explicit-any
    cur = (cur as any).original as ts.Node;
    chain.push(cur);
  }
  return chain;
}

function fmtPos(sf: ts.SourceFile, pos: number, end: number): string {
  try {
    const lc = sf.getLineAndCharacterOfPosition(pos);
    const snippet = sf.text.slice(pos, Math.min(end, pos + 56)).trim()
      .replace(/\s+/g, " ");
    return `${lc.line + 1}:${lc.character + 1} «${snippet}»`;
  } catch {
    return `pos=${pos} (unmappable)`;
  }
}

export function probeNode(
  tag: string,
  role: string,
  node: ts.Node,
  sf: ts.SourceFile,
): void {
  if (!ENABLED) return;
  const chain = originalChain(node);
  const term = chain[chain.length - 1];
  const smrRange = ts.getSourceMapRange(node);
  const smrSet = (smrRange as unknown) !== (node as unknown);
  const smr = smrSet ? `${smrRange.pos}..${smrRange.end}` : "none";
  let recovered = "NONE";
  if (node.pos >= 0) {
    recovered = `self→${fmtPos(sf, node.pos, node.end)}`;
  } else if (smrSet && smrRange.pos >= 0) {
    recovered = `smr→${fmtPos(sf, smrRange.pos, smrRange.end)}`;
  } else if (term !== node && term.pos >= 0) {
    recovered = `orig→${fmtPos(sf, term.pos, term.end)}`;
  }
  console.error(
    `[lineage-probe] ${tag} role=${role} kind=${kindName(node)} ` +
      `pos=${node.pos}..${node.end} smr=${smr} origDepth=${chain.length - 1}` +
      (chain.length > 1
        ? ` origTerm=${kindName(term)}@${term.pos}..${term.end}`
        : "") +
      ` recovered=${recovered}`,
  );
}

/** Probe a hoistable builder site: the visited (outer/applied) call, the inner
 * call being relocated, and the inner call's function-valued argument. */
export function probeBuilderSite(
  tag: string,
  visited: ts.CallExpression,
  innerCall: ts.CallExpression,
  sf: ts.SourceFile,
): void {
  if (!ENABLED) return;
  probeNode(tag, "outer", visited, sf);
  if (innerCall !== visited) probeNode(tag, "inner", innerCall, sf);
  probeCallback(tag, innerCall, sf);
}

/** Probe an in-place (non-hoisted) authored builder call and its callback. */
export function probeAuthoredBuilder(
  tag: string,
  call: ts.CallExpression,
  sf: ts.SourceFile,
): void {
  if (!ENABLED) return;
  probeNode(tag, "call", call, sf);
  probeCallback(tag, call, sf);
}

/** Probe a rebuild boundary: the node a strategy received vs what it
 * returned. Shows whether lineage existed on entry and survived on exit. */
export function probeRebuild(
  tag: string,
  before: ts.Node,
  after: ts.Node,
  sf: ts.SourceFile,
): void {
  if (!ENABLED) return;
  probeNode(tag, "in", before, sf);
  probeNode(tag, "out", after, sf);
}

function probeCallback(
  tag: string,
  call: ts.CallExpression,
  sf: ts.SourceFile,
): void {
  const cb = call.arguments.find(
    (a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a),
  );
  if (cb) {
    probeNode(tag, "callback", cb, sf);
  } else {
    console.error(`[lineage-probe] ${tag} role=callback MISSING(no fn arg)`);
  }
}
```
