// W2.15b / register row R13 (`context-lattice-execution.md` §8): the finding
// that `wish` is NOT descriptor-shaped, made executable.
//
// R13 asks whether the resolver's write surface is expressible as a trivial
// output-only descriptor (the W2.15a selector shape) or needs envelope
// treatment (the W2.16 materializer shape). Measured answer: NEITHER, and the
// reason is not that the surface is too wide — it is that the surface is
// MISLEADINGLY NARROW. `wish`'s sidecar paths (suggestion.tsx,
// profile-create.tsx, profile-picker.tsx) load a pattern over HTTP with a raw
// `globalThis.fetch` (via `HttpProgramResolver`), run it on a transaction of
// their own, and subscribe fresh scheduler actions — none of which shows up in
// the action's own transaction. So the run with the SMALLEST in-transaction
// write surface (exactly its direct output, nothing else) is precisely the run
// that egresses.
//
// A W2.15a-shaped descriptor over that surface would therefore classify the
// egressing runs `claim-ready`, and they would sail through the dynamic write
// firewall — re-opening the CP6 double-egress hole from the other side
// (`wish` is registered a COMPUTATION, so the never-speculate-effects rule
// does not hold a speculating client back either).
//
// Note the egress is not brokered and not deniable by the executor's own
// switch: `wish` constructs `new HttpProgramResolver(url)` without a fetch
// transport, and that resolver defaults to `globalThis.fetch` — so the
// executor Worker's `fetch: denyExternalBuiltinFetch` Runtime option
// (`executor/executor-worker.ts`) never sees the call.
//
// These tests pin the properties that block the descriptor. When one of them
// stops holding — e.g. the sidecar machinery moves out of the builtin, or
// `wish` is reclassified as an effect with a broker — the corresponding
// assertion fails and R13 should be re-decided rather than left deferred.
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

Deno.test("R13: a wish run whose whole transaction is its single direct output still egresses", async () => {
  // A freeform (non-`/`, non-`#`) query takes the suggestion-sidecar path.
  const { observation, fetched, space } = await observeWish(
    "somewhere for lunch",
    "freeform",
  );

  // The measured in-transaction write surface is ONE address: the node's
  // direct output spot. This is exactly the shape a W2.15a selector
  // descriptor certifies — which is the trap.
  assertEquals(
    observation.actualChangedWrites.map((address) => ({
      scope: scopeOf(address),
      path: address.path,
    })),
    [{ scope: "space", path: ["value"] }],
    "the freeform wish path is expected to write exactly its direct output",
  );

  // ...and that same run reached the network, unbrokered, for its sidecar.
  assert(
    fetched.some((url) => url.endsWith("/api/patterns/system/suggestion.tsx")),
    `expected the wish run to fetch its suggestion sidecar; saw ${
      JSON.stringify(fetched)
    }`,
  );

  // Therefore `wish` must stay descriptor-less until the sidecar machinery
  // leaves the builtin (or `wish` becomes a brokered effect). If this
  // assertion fails because a descriptor landed, the two assertions above are
  // the reason it is unsafe — re-decide R13, do not relax this.
  assertEquals(
    classifyStaticActionServability(observation, space),
    { status: "unservable", reason: "incomplete-static-surface" },
  );
});

Deno.test("R13: the wish result document's scope is chosen per run, not at registration", async () => {
  // A home-space target (`#profile`) makes `wishOutputScope` narrow the result
  // to `user`; a space-local target leaves it at the input scope. A descriptor
  // address carries ONE scope, fixed at registration (see the selector's
  // hardcoded `scope: "space"` in runner.ts), so no single declared address
  // covers both — independently of the egress problem above.
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

Deno.test("R13: the source properties that block a wish descriptor still hold", async () => {
  const source = await Deno.readTextFile(WISH_SOURCE);
  // Each entry: [what a descriptor would have to bound, the literal marker].
  // When a marker disappears, that half of the blocker is gone — revisit R13.
  const blockers: [string, RegExp][] = [
    [
      "unbrokered egress: the sidecar caches load patterns over HTTP " +
      "(HttpProgramResolver calls globalThis.fetch), yet `wish` is " +
      "registered a computation",
      /new HttpProgramResolver\(/,
    ],
    [
      "out-of-band commits: sidecar runs open and commit their OWN " +
      "transaction from inside the action body, so those writes never " +
      "ride the action transaction a claim would bound",
      /runtime\.edit\(\)/,
    ],
    [
      "runtime graph mutation: the shared hashtag resolver subscribes a " +
      "fresh, unfingerprinted Action to the scheduler mid-run",
      /runtime\.scheduler\.subscribe\(/,
    ],
    [
      "runtime-keyed minted identities: sidecar result documents are keyed " +
      "on the query text and the acting user DID, neither of which is " +
      "derivable at registration",
      /suggestionPattern: cause, situation:/,
    ],
  ];
  for (const [why, marker] of blockers) {
    assert(marker.test(source), `wish.ts no longer matches ${marker} — ${why}`);
  }
});
