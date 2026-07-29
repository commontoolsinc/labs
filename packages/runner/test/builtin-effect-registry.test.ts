// P2.0 of the client-passivity plan (panel finding CP6): the declared
// effect/computation kind of every builtin must match its egress reality.
//
// WHY this exists: the never-speculate-effects rule — and C2.8's
// double-egress prevention generally — keys on the REGISTERED kind. CP6
// found `streamData` performing arbitrary fetch egress while registered as
// a computation: with that drift, a future passivity/speculation dial would
// happily re-run it locally under a server claim and egress twice. These
// tests bind the two facts together STATICALLY (no Runtime construction):
// the registration source carries the kind literally, and the builtin
// sources carry the egress calls literally, so drift in either direction
// fails here before it can reach a servability or speculation decision.
//
// The binding is deliberately conservative: a NEW builtin source that
// matches the network-call pattern must either register as an effect and
// join EGRESS_EFFECT_IDS, or document itself in NON_EGRESS_MATCH_ALLOWLIST
// with the reason the match is not egress. Silent additions fail.

import { assert, assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";

const BUILTINS_DIR = join(
  dirname(fromFileUrl(import.meta.url)),
  "..",
  "src",
  "builtins",
);

/** Builtins whose implementations perform direct network egress; every one
 * of these MUST be registered `isEffect: true`. Keep in sync with the R5
 * register row in context-lattice-execution.md §8. */
const EGRESS_EFFECT_IDS = [
  "fetchBinary",
  "fetchText",
  "fetchJson",
  "fetchJsonUnchecked",
  "fetchProgram",
  "streamData",
] as const;

/** Effects for other reasons (server round-trips / broker egress via their
 * own clients rather than a literal `fetch(` in the builtin source). Their
 * kind is asserted too — they are the rest of the double-egress surface. */
const OTHER_EFFECT_IDS = [
  "llm",
  "generateObject",
  "generateText",
  "sqliteQuery",
] as const;

/** Files where the network-call regex matches for a reason that is NOT
 * builtin egress. Every entry carries its justification; an entry that
 * stops matching should be removed. */
const NON_EGRESS_MATCH_ALLOWLIST: Record<string, string> = {
  // A pattern-cache METHOD NAMED `fetch` (pattern-API loading through
  // runtime infrastructure); no direct network call in the builtin body.
  // wish's servability is tracked by register row R13, not this test.
  "wish.ts": "method named fetch on the suggestion-pattern cache",
  // The fetch FAMILY implementation itself — registered as effects; its
  // ids are asserted through EGRESS_EFFECT_IDS above.
  "fetch.ts": "the fetch-family effect implementations",
  "stream-data.ts": "streamData's polling fetch loop (effect since P2.0)",
};

const NETWORK_CALL = /\bfetch\s*\(|new\s+WebSocket|EventSource\s*\(/;

/** Extract `addModuleByRef("<id>", raw(...))` registrations with whether the
 * registration options carry `isEffect: true`, from the literal source. */
function registeredKinds(source: string): Map<string, boolean> {
  const kinds = new Map<string, boolean>();
  const pattern = /addModuleByRef\s*\(\s*"([^"]+)"\s*,([\s\S]*?)\)\s*;/g;
  for (const match of source.matchAll(pattern)) {
    kinds.set(match[1], /isEffect:\s*true/.test(match[2]));
  }
  return kinds;
}

Deno.test("P2.0: every egress-capable builtin is registered as an effect (kind matches egress reality)", async () => {
  const registry = await Deno.readTextFile(join(BUILTINS_DIR, "index.ts"));
  const kinds = registeredKinds(registry);
  assert(kinds.size > 10, "registration parse found the builtin registry");
  for (const id of [...EGRESS_EFFECT_IDS, ...OTHER_EFFECT_IDS]) {
    assertEquals(
      kinds.get(id),
      true,
      `${id} must be registered isEffect: true — its implementation performs ` +
        `egress (or a server round-trip); a computation kind here re-opens ` +
        `the CP6 double-egress hole`,
    );
  }
  // llmDialog is absent from the REGISTRATION options — and that is all this
  // assertion can see. Do not read it as "llmDialog is a computation": its
  // factory returns `isEffect: true`, so its EFFECTIVE kind is effect. The
  // next test pins that, and the docblock above it explains why the
  // distinction is load-bearing for W2.15. (This line previously carried a
  // comment claiming llmDialog "stays a computation"; that claim was false
  // and it propagated into the arc plan before being caught.)
  assertEquals(
    kinds.get("llmDialog"),
    false,
    "llmDialog carries no isEffect in its registration options (its factory " +
      "supplies the effect kind instead — see the next test)",
  );
});

/**
 * Builtins whose EFFECTIVE scheduler kind does not come from `index.ts` at
 * all: their factory returns a `RawBuiltinResult` carrying `isEffect: true`,
 * and the runner resolves the kind as `module.isEffect ?? builtinIsEffect`
 * (runner.ts, "isEffect can come from module options or from the builtin
 * result"). So `addModuleByRef("<id>", raw(fn))` with no options still
 * registers an EFFECT node, and `registeredKinds` above — which only reads
 * the registration source — reports `false` for them.
 *
 * Pinned because the gap is load-bearing for the W2.15 descriptor work: a
 * COMPUTATION descriptor can never serve these nodes.
 * `serverBuiltinComputationScopeSummary` returns undefined unless
 * `observation.actionKind === "computation"`, so adding either id to
 * `SERVER_COMPUTATION_BUILTIN_IDS` would mint a descriptor that never
 * assembles. If one of these ever stops returning `isEffect: true`, this
 * test goes red and the descriptor question is genuinely re-opened.
 */
const FACTORY_DECLARED_EFFECT_SOURCES: Record<string, string> = {
  // `return { action, isEffect: true };` at the end of `llmDialog`.
  "llm-dialog.ts": "llmDialog",
  // `return { action, isEffect: true, useDeclaredReadsAsDependencies: true };`
  "navigate-to.ts": "navigateTo",
};

Deno.test("P2.0: builtins whose factory declares isEffect are effect nodes regardless of the registration source", async () => {
  const registry = await Deno.readTextFile(join(BUILTINS_DIR, "index.ts"));
  const kinds = registeredKinds(registry);
  for (const [file, id] of Object.entries(FACTORY_DECLARED_EFFECT_SOURCES)) {
    const source = await Deno.readTextFile(join(BUILTINS_DIR, file));
    assert(
      /return\s*\{[^}]*isEffect:\s*true/.test(source),
      `${file} no longer returns isEffect: true from its builtin factory — ` +
        `${id}'s effective scheduler kind changed, so its exclusion from ` +
        `SERVER_COMPUTATION_BUILTIN_IDS must be re-decided`,
    );
    // The registration source says nothing; the factory is what decides.
    assertEquals(
      kinds.get(id),
      false,
      `${id} is registered without isEffect in index.ts — if that changed, ` +
        `simplify this pin rather than carrying two sources of the kind`,
    );
  }
});

Deno.test("P2.0: no builtin source performs network egress without a classification", async () => {
  const registry = await Deno.readTextFile(join(BUILTINS_DIR, "index.ts"));
  const kinds = registeredKinds(registry);
  for await (const entry of Deno.readDir(BUILTINS_DIR)) {
    if (!entry.isFile || !entry.name.endsWith(".ts")) continue;
    if (entry.name === "index.ts") continue;
    const source = await Deno.readTextFile(join(BUILTINS_DIR, entry.name));
    if (!NETWORK_CALL.test(source)) continue;
    if (entry.name in NON_EGRESS_MATCH_ALLOWLIST) continue;
    // A matching file must correspond to effect-registered builtins. We
    // cannot map file -> id mechanically, so the contract is: add the id(s)
    // to EGRESS_EFFECT_IDS (registered isEffect) or document the file in
    // NON_EGRESS_MATCH_ALLOWLIST. Failing loudly here is the point.
    throw new Error(
      `${entry.name} matches the network-call pattern but is neither ` +
        `allowlisted nor covered: classify the builtin (isEffect: true + ` +
        `EGRESS_EFFECT_IDS) or document the false positive in ` +
        `NON_EGRESS_MATCH_ALLOWLIST. Registered kinds seen: ${
          JSON.stringify([...kinds.keys()])
        }`,
    );
  }
});

/**
 * A2 (R5 sqliteQuery row): registering the right KIND is necessary but not
 * sufficient for double-execution prevention. The suppression decision lives
 * entirely in `ExtendedStorageTransaction.externalSinkDisposition()` — it is
 * what flips `tx.executionEffectAuthority` to `"server"` and returns
 * `"suppress"` once the source action carries a server EFFECT claim — and the
 * ONLY caller of that method is `enqueueSinkRequestPostCommitEffect`
 * (`src/cfc/sink-request.ts`). A builtin that reaches
 * `tx.enqueuePostCommitEffect` directly therefore never consults the gate:
 * the client keeps issuing its external work under the server's claim, and
 * the executor Worker keeps issuing it with NO claim (the productionServer
 * preset's `externalSinkDisposition` is exactly the "suppress unless claimed"
 * policy). It also skips the CFC sink-request policy input + release check.
 *
 * So the contract is a file-level one: a builtin source enqueues its
 * post-commit side effect through `enqueueSinkRequestPostCommitEffect`, or it
 * is documented here with the reason its effect is not a suppression surface.
 */
const DIRECT_POST_COMMIT_EFFECT_ALLOWLIST: Record<string, string> = {
  // navigateTo's post-commit effect is the LOCAL shell navigation callback
  // (`runtime.navigateCallback`), not an external sink: there is no second
  // issuer to double-fire, and the executor Worker installs no navigate
  // callback at all, so the effect is inert server-side. Its server-side
  // classification is tracked by register row R5 (W2.15 descriptors), not by
  // the suppression gate.
  "navigate-to.ts": "local shell navigation callback, not an external sink",
};

const DIRECT_POST_COMMIT_EFFECT = /\.enqueuePostCommitEffect\s*\(/;

Deno.test("A2: every builtin post-commit side effect routes through the sink-request suppression gate", async () => {
  for await (const entry of Deno.readDir(BUILTINS_DIR)) {
    if (!entry.isFile || !entry.name.endsWith(".ts")) continue;
    if (entry.name === "index.ts") continue;
    const source = await Deno.readTextFile(join(BUILTINS_DIR, entry.name));
    if (!DIRECT_POST_COMMIT_EFFECT.test(source)) continue;
    if (entry.name in DIRECT_POST_COMMIT_EFFECT_ALLOWLIST) continue;
    throw new Error(
      `${entry.name} calls tx.enqueuePostCommitEffect directly, bypassing ` +
        `externalSinkDisposition() — the only double-execution gate there ` +
        `is. Route it through enqueueSinkRequestPostCommitEffect ` +
        `(src/cfc/sink-request.ts), or document here why its effect is not ` +
        `a suppression surface.`,
    );
  }
});
