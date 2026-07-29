// W2.15b / register row R13 (`context-lattice-execution.md` §8): `wish`'s
// resolver surface, and the descriptor it now carries.
//
// R13 asked whether the resolver's write surface is expressible as a trivial
// output-only descriptor (the W2.15a selector shape) or needs envelope
// treatment (the W2.16 materializer shape). The FIRST answer (a69aec5f9) was
// "neither", and the reason was not that the surface is too wide — it is that
// the surface is MISLEADINGLY NARROW. `wish`'s sidecar paths (suggestion.tsx,
// profile-create.tsx, profile-picker.tsx) load a pattern over HTTP with a raw
// `globalThis.fetch` (via `HttpProgramResolver`), run it on a transaction of
// their own, and subscribe fresh scheduler actions — none of which shows up in
// the action's own transaction. So the run with the SMALLEST in-transaction
// write surface (exactly its direct output, nothing else) is precisely the run
// that egresses. A W2.15a-shaped descriptor over that surface classifies the
// egressing runs `claim-ready`, so both sides may perform that egress.
//
// OWNER RULING, 2026-07-29: **accept the egress.** "Accept the egress for now,
// as that's probably easier. It's safe." The egress is a GET of a system
// pattern from our own API (`patternUrl()` =
// `apiUrl + "api/patterns/system/" + name`, wish.ts), so performing it more
// than once is idempotent and harmless — the CP6 double-egress hazard is a
// hazard about EFFECTS with external consequence, and a cacheable GET of our
// own static pattern source is not one. `wish` therefore gets the W2.15a
// computation descriptor and runs server-side (D11: closing the serving gap
// is the work).
//
// Note the egress is still not brokered and not deniable by the executor's own
// switch: `wish` constructs `new HttpProgramResolver(url)` without a fetch
// transport, and that resolver defaults to `globalThis.fetch` — so the
// executor Worker's `fetch: denyExternalBuiltinFetch` Runtime option
// (`executor/executor-worker.ts`) never sees the call. That is now an ACCEPTED
// property rather than a blocker, and the pins below record it as such so the
// record shows a ruling changed the answer, not a weakened test.
//
// What the descriptor does NOT cover is still pinned: the sidecar runs' own
// transactions, the mid-run scheduler subscription, and the user-scoped
// instance of the minted state document. Those stay outside the declared write
// envelope, so a run that reaches them de-claims fail-closed at the dynamic
// write firewall instead of being served — which is the designed outcome, not
// an accident.
import { assert, assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { createExecutorActionTransactionRouter } from "../src/executor/action-transaction-router.ts";
import { classifyStaticActionServability } from "../src/scheduler/servability.ts";
import type { SchedulerActionObservation } from "../src/scheduler/persistent-observation.ts";
import type { IMemorySpaceAddress } from "../src/storage/interface.ts";

const WISH_SOURCE = join(
  dirname(fromFileUrl(import.meta.url)),
  "..",
  "src",
  "builtins",
  "wish.ts",
);

/** One wish per node so each observation is unambiguous. */
const wishProgram = (query: string): RuntimeProgram => ({
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "/// <cts-enable />",
      "import { pattern, wish } from 'commonfabric';",
      "export default pattern<{ seed: string }>(() => ({",
      `  target: wish<unknown>({ query: ${JSON.stringify(query)} }),`,
      "}));",
    ].join("\n"),
  }],
});

const scopeOf = (address: IMemorySpaceAddress): unknown =>
  (address as { scope?: unknown }).scope ?? "space";

/** Same envelope containment the dynamic write firewall applies
 *  (`scheduler/servability.ts`): same space/id/scope, declared path a prefix. */
const covers = (
  envelope: IMemorySpaceAddress,
  address: IMemorySpaceAddress,
): boolean =>
  envelope.space === address.space && envelope.id === address.id &&
  scopeOf(envelope) === scopeOf(address) &&
  envelope.path.length <= address.path.length &&
  envelope.path.every((part, index) => part === address.path[index]);

/**
 * Run a one-wish pattern with `globalThis.fetch` recorded, and return the
 * wish action's observation plus every URL the run reached for.
 *
 * The sidecar caches in `wish.ts` are module-level singletons keyed on the
 * pattern-environment `apiUrl`, so each call installs a UNIQUE apiUrl — that
 * keeps the probe cold and order-independent no matter what else in this
 * process already loaded a sidecar.
 */
async function observeWish(query: string, label: string): Promise<{
  observation: SchedulerActionObservation;
  fetched: string[];
  space: MemorySpace;
}> {
  const signer = await Identity.fromPassphrase(`wish R13 surface ${label}`);
  const space = signer.did() as MemorySpace;
  const attempts: SchedulerActionObservation[] = [];
  const fetched: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    fetched.push(
      typeof input === "string"
        ? input
        : input instanceof URL
        ? input.href
        : input.url,
    );
    return Promise.resolve(new Response("absent", { status: 404 }));
  }) as typeof globalThis.fetch;

  const executorRouter = createExecutorActionTransactionRouter({
    servedSpace: space,
    branch: "",
    claimForAction: () => undefined,
    onCandidate: () => {},
    onDiagnostic: () => {},
  });
  const storage = StorageManager.emulate({
    as: signer,
    actionTransactionRouter(input) {
      const route = executorRouter(input);
      const observation = input.commit.schedulerObservation;
      if (
        observation !== undefined &&
        (observation as { transactionKind?: unknown }).transactionKind ===
          "action-run"
      ) {
        attempts.push(
          structuredClone(observation) as SchedulerActionObservation,
        );
      }
      return route;
    },
  });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    // Unique per call: keeps the module-level sidecar caches cold.
    patternEnvironment: {
      apiUrl: new URL(`http://wish-r13-${label}.invalid/`),
    },
    storageManager: storage,
    experimental: {
      persistentSchedulerState: true,
      serverPrimaryExecution: true,
    },
    trustSnapshotProvider: () => ({
      id: `principal:${space}`,
      actingPrincipal: space,
    }),
  });

  try {
    const compiled = await runtime.patternManager.compilePattern(
      wishProgram(query),
      { space },
    );
    const tx = runtime.edit();
    const result = runtime.getCell<Record<string, unknown>>(
      space,
      `wish-r13-${label}`,
      undefined,
      tx,
    );
    const handle = runtime.run(tx, compiled, { seed: label }, result);
    runtime.prepareTxForCommit(tx);
    assertEquals((await tx.commit()).error, undefined);
    await handle.pull();
    await runtime.settled();
    // The sidecar load is kicked off inside the action and settles on its own
    // continuation, so give it bounded time to reach the recorder.
    for (let i = 0; i < 50 && fetched.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const wishAttempts = attempts.filter((observation) =>
      observation.implementationFingerprint === "impl:cf:builtin/wish:v1"
    );
    assertEquals(
      wishAttempts.length,
      1,
      `expected exactly one wish action-run for ${query}; saw ${
        JSON.stringify(
          attempts.map((a) => a.implementationFingerprint),
        )
      }`,
    );
    return { observation: wishAttempts[0], fetched, space };
  } finally {
    globalThis.fetch = realFetch;
    await runtime.dispose();
    await storage.close();
  }
}

Deno.test("R13: a wish run whose whole transaction is its single direct output egresses — and that egress is accepted", async () => {
  // A freeform (non-`/`, non-`#`) query takes the suggestion-sidecar path.
  const { observation, fetched, space } = await observeWish(
    "somewhere for lunch",
    "freeform",
  );

  // The measured in-transaction write surface is ONE address: the node's
  // direct output spot. This is exactly the shape a W2.15a selector
  // descriptor certifies.
  assertEquals(
    observation.actualChangedWrites.map((address) => ({
      scope: scopeOf(address),
      path: address.path,
    })),
    [{ scope: "space", path: ["value"] }],
    "the freeform wish path is expected to write exactly its direct output",
  );

  // ...and that same run reached the network, unbrokered, for its sidecar.
  // STILL PINNED, and still meaningful: this is the egress the 2026-07-29
  // owner ruling accepts, so the record must keep showing that it is real and
  // that the descriptor below classifies the egressing run claim-ready with
  // full knowledge of it. What makes it acceptable is the URL — a GET of a
  // system pattern from our own API — which the next assertion pins.
  const sidecarUrl = fetched.find((url) =>
    url.endsWith("/api/patterns/system/suggestion.tsx")
  );
  assert(
    sidecarUrl !== undefined,
    `expected the wish run to fetch its suggestion sidecar; saw ${
      JSON.stringify(fetched)
    }`,
  );
  // The ruling's whole basis: the egress is an idempotent GET of OUR OWN
  // pattern-serving route. If `wish` ever reaches a different host or a
  // non-`api/patterns/system/` path, performing it twice stops being provably
  // harmless and D11's acceptance has to be re-decided.
  assert(
    /^https?:\/\/[^/]+\/api\/patterns\/system\/[^/?#]+$/.test(sidecarUrl),
    `wish's sidecar egress is no longer a plain GET of our own ` +
      `api/patterns/system/<name> route (${sidecarUrl}) — the 2026-07-29 ` +
      `acceptance of a possibly-doubled wish egress rested on exactly that`,
  );

  // The descriptor: `wish` is claim-ready. This assertion is the inversion of
  // the a69aec5f9 pin (`incomplete-static-surface`); the two assertions above
  // are the properties that used to argue against it, kept green so the record
  // shows a RULING changed the answer, not a weakened test.
  assertEquals(
    classifyStaticActionServability(observation, space),
    { status: "claim-ready", actionKind: "computation" },
  );
});

Deno.test("R13: the wish result document's scope is chosen per run, not at registration", async () => {
  // A home-space target (`#profile`) makes `wishOutputScope` narrow the result
  // to `user`; a space-local target leaves it at the input scope. A descriptor
  // address carries ONE scope, fixed at registration (see the selector's
  // hardcoded `scope: "space"` in runner.ts), so no single DECLARED address
  // spans both instances.
  //
  // STILL PINNED, and still the reason the descriptor's coverage is partial:
  // the §4 lane-instance relaxation (`laneInstanceCovers` in
  // scheduler/servability.ts, with `widenLaneOutputEnvelopes` in the executor
  // router) admits the scoped INSTANCE of a declared document only under a
  // scoped lane. A space-rank run that lands the state document at `user`
  // therefore de-claims fail-closed rather than being served — the designed
  // outcome, and the thing this test exists to keep observable.
  const { observation, fetched } = await observeWish("#profile", "persona");

  const stateWrites = observation.actualChangedWrites.filter((address) =>
    scopeOf(address) === "user"
  );
  assert(
    stateWrites.length > 0,
    `expected the #profile wish result document at user scope; saw ${
      JSON.stringify(
        observation.actualChangedWrites.map((a) => ({
          scope: scopeOf(a),
          path: a.path,
        })),
      )
    }`,
  );
  // The #profile create surface is a sidecar too: the error path renders it
  // regardless of `headless`, so this target egresses as well.
  assert(
    fetched.some((url) =>
      url.endsWith("/api/patterns/system/profile-create.tsx")
    ),
    `expected the #profile wish run to fetch its create sidecar; saw ${
      JSON.stringify(fetched)
    }`,
  );
});

Deno.test("R13: the source properties the wish descriptor deliberately does NOT cover still hold", async () => {
  const source = await Deno.readTextFile(WISH_SOURCE);
  // Each entry: [what the descriptor does not bound and why that is safe, the
  // literal marker]. Before the 2026-07-29 ruling these were recorded as
  // BLOCKERS; they are unchanged as facts, and the first one is now an
  // explicitly accepted property rather than a veto. When a marker disappears,
  // that property is gone — re-read R13 rather than assuming the descriptor
  // still needs to allow for it.
  const uncoveredProperties: [string, RegExp][] = [
    [
      "ACCEPTED (owner, 2026-07-29): unbrokered egress — the sidecar caches " +
      "load patterns over HTTP (HttpProgramResolver defaults to " +
      "globalThis.fetch, so the executor's denyExternalBuiltinFetch never " +
      "sees it) while `wish` is registered a computation, hence both sides " +
      "may perform it. Safe because it is an idempotent GET of our own " +
      "api/patterns/system/<name> route",
      /new HttpProgramResolver\(/,
    ],
    [
      "out-of-band commits: sidecar runs open and commit their OWN " +
      "transaction from inside the action body, so those writes never ride " +
      "the action transaction a claim would bound — they are outside the " +
      "descriptor's envelope by construction, not by omission",
      /runtime\.edit\(\)/,
    ],
    [
      "runtime graph mutation: the shared hashtag resolver subscribes a " +
      "fresh, unfingerprinted Action to the scheduler mid-run; that action " +
      "carries its own (uncertified) identity and is never served under " +
      "this node's claim",
      /runtime\.scheduler\.subscribe\(/,
    ],
    [
      "runtime-keyed minted identities: sidecar result documents are keyed " +
      "on the query text and the acting user DID, neither of which is " +
      "derivable at registration, so they stay outside the declared surface",
      /suggestionPattern: cause, situation:/,
    ],
  ];
  for (const [why, marker] of uncoveredProperties) {
    assert(marker.test(source), `wish.ts no longer matches ${marker} — ${why}`);
  }
});

Deno.test("R13: the wish descriptor's write envelope covers every write a resolving run makes", async () => {
  // The load-bearing pin for the descriptor: the runner re-derives the minted
  // wish-state document at REGISTRATION (`selectorBuiltinResultCause("wish",
  // cause)` in runner.ts) and `sendWishState` mints it at RUN time through the
  // same helper. If the two ever key it on different causes, the declared
  // write surface names a document `wish` never writes while the document it
  // does write is uncovered — and every resolving run de-claims fail-closed at
  // the dynamic write firewall. A path query is used because it is the shape
  // that actually resolves and writes the state document (the freeform path
  // writes only the output spot).
  const { observation, space } = await observeWish("/notes", "path");

  assertEquals(
    classifyStaticActionServability(observation, space),
    { status: "claim-ready", actionKind: "computation" },
  );
  const summary = observation.completeActionScopeSummary;
  assert(summary !== undefined, "expected an assembled wish summary");
  const envelopes = [...summary.writes, ...summary.directOutputs];
  const uncovered = observation.actualChangedWrites.filter((address) =>
    !envelopes.some((envelope) => covers(envelope, address))
  );
  assertEquals(
    uncovered.map((address) => ({
      scope: scopeOf(address),
      id: address.id,
      path: address.path,
    })),
    [],
    `every actual write of a resolving wish run must be covered by the ` +
      `declared envelope; declared: ${
        JSON.stringify(
          envelopes.map((e) => ({ scope: scopeOf(e), id: e.id, path: e.path })),
        )
      }`,
  );
  // ...and the minted state document must genuinely be among them, or the
  // check above would pass vacuously on a run that wrote only its output spot.
  assert(
    observation.actualChangedWrites.some((address) =>
      address.id !== summary.directOutputs[0]?.id
    ),
    "expected the resolving wish run to write its minted state document " +
      "as well as its direct output",
  );
});
