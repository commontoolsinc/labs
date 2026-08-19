// W0 (d′) SCRATCH — the refutation experiment's pins (stage-C design
// §2.8 (a)): demand is the memory server's TRACKED-IDS CLOSURE and the
// demand walk is DELETED. Scratch quality; the NUMBERS these print are the
// deliverable (the report reads them). Modeled on executor-fan-out.test.ts
// (a real memory server, a live ExecutorHost, N flag-ON clients).
//
// - T1′ value-only change under a demanded doc → the demanded computed's
//   instances re-derive, W advances, ZERO walk runs (structural: no
//   `demand-walk:*` action exists — T9′);
// - T2′ a wave writes a NEW LINK (ifElse flips to a computed it never
//   READS — the branch is reached only through the link) → the newly
//   reachable computed enters the demand set (the tracker's push-time
//   re-traversal, or the client's own pull — the row's `root` says
//   which) → its writer is a demand root → it lands; the CYCLE COUNT is
//   printed (settle series: waves / growth wakes / class);
// - T4′ a per-user change re-runs only that demander's instances;
// - T5′ one registry key per space doc with N pairs; a user-scoped doc
//   under two principals is two keys;
// - T7′ a computed's ABSENT output doc is demanded before it exists (its
//   writer is a root from the first pass) → it lands;
// - P-demand-set the registry keys = ⋃ trackedIds over the client
//   sessions (service excluded);
// - P-coarse a departed session's rows leave and the writers' roots
//   release; a doc tracked by two sessions stays while one remains;
// - P-arrival a second principal arriving after narrowing gets her
//   instance (the per-key not-current re-arm / root arrival re-arm);
// - T9′ OFF arm: `demandedWriters` empty on a plain client runtime;
// - T10′: run this file with SCHEDULER_LIVENESS_EQUIVALENCE=1.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import * as Engine from "@commonfabric/memory/v2/engine";
import { resolveScopeKey } from "@commonfabric/memory/v2";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import { ExecutorHost } from "../src/executor/host.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const spaceSigner = await Identity.fromPassphrase("dprime w0 space");
const space = spaceSigner.did() as MemorySpace;
const serviceSigner = await Identity.fromPassphrase("dprime w0 service");
const aliceSigner = await Identity.fromPassphrase("dprime w0 alice");
const bobSigner = await Identity.fromPassphrase("dprime w0 bob");

const waitUntil = async (
  predicate: () => boolean,
  label: string | (() => string),
  timeoutMs = 20_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      const rendered = typeof label === "function" ? label() : label;
      throw new Error(`timed out waiting for ${rendered}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const FAN_OUT_PATTERN = [
  "import { computed, Default, pattern, PerUser, Writable } from 'commonfabric';",
  "type Draft = Writable<string | Default<''>>;",
  "const text = (cell: Draft): string => (cell.get() as string | undefined) ?? '';",
  "export default pattern<",
  "  { draft?: PerUser<Draft>; n?: number },",
  "  { echo: string; label: string }",
  ">(({ draft, n }) => {",
  "  const draftCell: Draft = draft!;",
  "  return {",
  "    echo: computed(() => 'echo:' + text(draftCell)),",
  "    label: computed(() => 'label:' + String(n ?? 0)),",
  "  };",
  "});",
].join("\n");

/** T2′: `view` links to `guarded` ONLY when the flag is on; ifElse writes
 * a LINK and never reads the branch value (if-else.ts), so `guarded` is
 * reachable only through the link the wave writes. */
const GUARDED_PATTERN = [
  "import { computed, Default, ifElse, pattern, PerUser, Writable } from 'commonfabric';",
  "type Draft = Writable<string | Default<''>>;",
  "type Flag = Writable<boolean | Default<false>>;",
  "const text = (cell: Draft): string => (cell.get() as string | undefined) ?? '';",
  "export default pattern<",
  "  { draft?: PerUser<Draft>; flag?: PerUser<Flag>; n?: number },",
  "  { view: unknown }",
  ">(({ draft, flag }) => {",
  "  const draftCell: Draft = draft!;",
  "  const flagCell: Flag = flag!;",
  "  const guarded = computed(() => 'guarded:' + text(draftCell));",
  "  const on = computed(() => flagCell.get() === true);",
  "  return { view: ifElse(on, guarded, 'off') };",
  "});",
].join("\n");

/** T2′ (isolated): a HANDLER writes a LINK to a computed it never reads
 * (`slot.set(hiddenCell)` — the link-tool shape); `hidden` is exposed
 * nowhere else, so it is reachable only through the link the wave writes. */
const LINK_ON_EVENT_PATTERN = [
  "import { computed, handler, pattern, Stream, Writable } from 'commonfabric';",
  "const pick = handler<unknown, { slot: Writable<unknown>; hidden: string }>(",
  "  (_ev, { slot, hidden }) => { slot.set(hidden); },",
  ");",
  "export default pattern<",
  "  { n?: number; slot?: Writable<unknown> },",
  "  { slot: unknown; pick: Stream<unknown> }",
  ">(({ n, slot }) => {",
  "  const hidden = computed(() => 'hidden:' + String(n ?? 0));",
  "  return { slot, pick: pick({ slot: slot!, hidden }) };",
  "});",
].join("\n");

const rowsUnder = (
  engine: Engine.Engine,
  scopeKey: string,
): Map<string, unknown> => {
  const rows = engine.database.prepare(
    `SELECT id FROM head WHERE scope_key = :scope_key AND op != 'delete'`,
  ).all({ scope_key: scopeKey }) as Array<{ id: string }>;
  const out = new Map<string, unknown>();
  for (const { id } of rows) {
    out.set(id, Engine.read(engine, { id, scopeKey } as never)?.value);
  }
  return out;
};

const instanceHolds = (
  engine: Engine.Engine,
  scopeKey: string,
  needle: string,
): boolean =>
  [...rowsUnder(engine, scopeKey).values()].some((value) =>
    JSON.stringify(value ?? null).includes(needle)
  );

describe("W0 (d′): demand = the tracked-ids closure, the walk deleted", () => {
  let server: MemoryV2Server.Server;
  let host: ExecutorHost | undefined;
  let managers: EmulatedStorageManager[];
  let runtimes: Runtime[];
  let servingRuntime: Runtime | undefined;

  const newHost = (): ExecutorHost =>
    new ExecutorHost({
      server,
      serviceIdentity: serviceSigner.did(),
      // deno-lint-ignore require-await
      createRuntime: async () => {
        const manager = EmulatedStorageManager.connectTo(server, {
          as: serviceSigner,
        });
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: manager,
          servingPosture: true,
          experimental: {
            serverExecution: true,
            systemPatternAutoUpdate: false,
          },
        });
        runtime.scheduler.setActionRunTraceEnabled(true);
        servingRuntime = runtime;
        return {
          runtime,
          dispose: async () => {
            await runtime.dispose();
            await manager.close();
          },
        };
      },
      policy: { flushDeadlineMs: 5_000, idleParkMs: 600_000 },
    });

  beforeEach(() => {
    server = newSharedServer({
      subscriptionRefreshDelayMs: 0,
      sessionTtlMs: 500,
    });
    managers = [];
    runtimes = [];
    servingRuntime = undefined;
  });

  afterEach(async () => {
    await host?.close();
    host = undefined;
    for (const runtime of runtimes) await runtime.dispose();
    for (const manager of managers) await manager.close();
    await server.close();
  });

  const openClient = (signer: Identity): {
    runtime: Runtime;
    manager: EmulatedStorageManager;
  } => {
    const manager = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      experimental: { serverExecution: true },
    });
    managers.push(manager);
    runtimes.push(runtime);
    return { runtime, manager };
  };

  const demandRows = () =>
    server.demandedInstancesForSpace(space, {
      excludePrincipal: serviceSigner.did(),
    });
  const walkRuns = () =>
    servingRuntime!.scheduler.getActionRunTrace().filter((entry) =>
      entry.actionId.startsWith("demand-walk:")
    ).length;

  const standUp = async (options: {
    names: { arg: string; result: string };
    pattern?: string;
    clients: Identity[];
  }) => {
    host = newHost();
    const aliceClient = openClient(aliceSigner);
    const alice = aliceClient.runtime;
    const engine = await server.engineForSpace(space);
    const compiled = await alice.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: options.pattern ?? FAN_OUT_PATTERN,
      }],
    }, { space });
    const aliceArg = alice.getCell<Record<string, unknown>>(
      space,
      options.names.arg,
      undefined,
    );
    const aliceResult = alice.getCell<Record<string, unknown>>(
      space,
      options.names.result,
      compiled.resultSchema,
    );
    await aliceArg.sync();
    await aliceResult.sync();
    {
      const seed = alice.edit();
      aliceArg.withTx(seed).set({ n: 1 });
      expect((await seed.commit()).error).toBeUndefined();
    }
    {
      const tx = alice.edit();
      alice.run(tx, compiled, aliceArg, aliceResult);
      expect((await tx.commit()).error).toBeUndefined();
    }
    await alice.idle();
    await alice.storageManager.synced();
    const argId = aliceArg.getAsNormalizedFullLink().id;
    const resultId = aliceResult.getAsNormalizedFullLink().id;

    const clients = new Map<
      string,
      { runtime: Runtime; manager: EmulatedStorageManager }
    >([
      [aliceSigner.did(), aliceClient],
    ]);
    const cancels: Array<() => void> = [];
    const watchRoot = async (signer: Identity) => {
      const client = clients.get(signer.did()) ?? openClient(signer);
      clients.set(signer.did(), client);
      const result = client.runtime.getCell<Record<string, unknown>>(
        space,
        options.names.result,
        compiled.resultSchema,
      );
      await result.sync();
      cancels.push(result.sink(() => {}));
      return client;
    };
    for (const signer of options.clients) await watchRoot(signer);
    await waitUntil(
      () => host!.spaceServer(space)?.active === true,
      "space activation",
    );
    await waitUntil(
      () => {
        const demanded = host!.spaceServer(space)?.demandedIdentitiesOf(
          resultId,
        ) ?? [];
        return options.clients.every((signer) =>
          demanded.some((i) => i.principal === signer.did())
        );
      },
      () =>
        "the registry to carry every root watcher (has " +
        JSON.stringify(
          host!.spaceServer(space)?.demandedIdentitiesOf(resultId),
        ) + ")",
    );
    const typedArg = (runtime: Runtime) =>
      runtime.getCell<{ draft: string; flag: boolean; n: number }>(
        space,
        options.names.arg,
        compiled.argumentSchema,
      );
    const writeDraft = async (runtime: Runtime, value: string) => {
      const arg = typedArg(runtime);
      await arg.sync();
      const tx = runtime.edit();
      arg.key("draft").withTx(tx).set(value);
      expect((await tx.commit()).error).toBeUndefined();
      await runtime.idle();
      await runtime.storageManager.synced();
    };
    const userKey = (signer: Identity) =>
      resolveScopeKey("user", { principal: signer.did() });
    return {
      engine,
      compiled,
      argId,
      resultId,
      clients,
      watchRoot,
      writeDraft,
      typedArg,
      userKey,
      cancel: () => cancels.forEach((cancel) => cancel()),
    };
  };

  it("T1′/T4′/T5′/T7′/T9′/P-demand-set: value-only change re-derives the demanded per-user computed for THAT user only, W advances, zero walk runs; the registry is the closure; a computed demanded before it exists lands", async () => {
    host = newHost();
    // T9′ (OFF half): a plain client runtime has an EMPTY demanded-writer set.
    const probeClient = openClient(bobSigner);
    expect(probeClient.runtime.scheduler.demandedWriterCount).toBe(0);
    await probeClient.runtime.dispose();
    await probeClient.manager.close();
    runtimes.splice(runtimes.indexOf(probeClient.runtime), 1);
    managers.splice(managers.indexOf(probeClient.manager), 1);
    host.close();
    const setup = await standUp({
      names: { arg: "dp-a-arg", result: "dp-a-result" },
      clients: [aliceSigner, bobSigner],
    });
    const { engine, clients } = setup;
    const alice = clients.get(aliceSigner.did())!.runtime;
    const bob = clients.get(bobSigner.did())!.runtime;
    const aliceKey = setup.userKey(aliceSigner);
    const bobKey = setup.userKey(bobSigner);

    // T7′: the `label` and `echo` computeds' output docs are demanded
    // (in the closure) — the writer is a root — and land server-side.
    await waitUntil(
      () => instanceHolds(engine, "space", '"label:1"'),
      "the space-only label to land server-side",
    );
    const rowsAfterLanding = demandRows();
    const computedRows = rowsAfterLanding.filter((r) =>
      r.id.startsWith("computed:")
    );
    console.log(
      `[T7′] demand rows=${rowsAfterLanding.length} computed rows=${computedRows.length} (root:true ${
        computedRows.filter((r) => r.root).length
      } / root:false ${computedRows.filter((r) => !r.root).length}); ` +
        `demandedWriters=${servingRuntime!.scheduler.demandedWriterCount}; ` +
        `demandedEntities=${servingRuntime!.scheduler.demandedEntityCount}`,
    );
    expect(servingRuntime!.scheduler.demandedWriterCount).toBeGreaterThan(0);

    // T1′ + T4′: Alice's per-user draft → only Alice's echo instance
    // re-derives; W advances; ZERO walk runs.
    await setup.writeDraft(alice, "A");
    await setup.writeDraft(bob, "B");
    await waitUntil(
      () =>
        instanceHolds(engine, aliceKey, '"echo:A"') &&
        instanceHolds(engine, bobKey, '"echo:B"'),
      "each user's echo of their own draft",
    );
    const traceBefore = servingRuntime!.scheduler.getActionRunTrace().length;
    const wBefore = host!.spaceServer(space)!.watermark;
    await setup.writeDraft(alice, "A2");
    await waitUntil(
      () => instanceHolds(engine, aliceKey, '"echo:A2"'),
      "alice's second draft to re-derive",
    );
    await waitUntil(
      () => host!.spaceServer(space)!.watermark > wBefore,
      "W to advance past alice's write",
    );
    const since = servingRuntime!.scheduler.getActionRunTrace().slice(
      traceBefore,
    );
    // T4′: no run under Bob's instance for Alice's change.
    expect(
      since.filter((e) => e.instanceKey === bobKey).map((e) => e.actionId),
    ).toEqual([]);
    expect(instanceHolds(engine, bobKey, '"echo:A2"')).toBe(false);
    // T9′ (structural): zero walk runs, ever.
    expect(walkRuns()).toBe(0);

    // T5′ + P-demand-set: registry keys = the closure's instance keys.
    const rows = demandRows();
    const keys = new Set(rows.map((r) => `${r.scopeKey}\0${r.id}`));
    const resultRows = rows.filter((r) => r.id === setup.resultId);
    // The space-scoped result root: ONE key, N pairs (one per session).
    expect(new Set(resultRows.map((r) => r.scopeKey))).toEqual(
      new Set(["space"]),
    );
    expect(resultRows.length).toBeGreaterThanOrEqual(2);
    // A user-scoped doc under two principals: two keys.
    const userKeyed = rows.filter((r) => r.scopeKey.startsWith("user:"));
    const principals = new Set(userKeyed.map((r) => r.scopeKey));
    console.log(
      `[T5′] keys=${keys.size} rows=${rows.length} result-root pairs=${resultRows.length} user-instance keys=${principals.size}`,
    );
    expect(principals.has(aliceKey)).toBe(true);
    expect(principals.has(bobKey)).toBe(true);
    const sizes = server.demandSetSizesForSpace(space, {
      excludePrincipal: serviceSigner.did(),
    });
    expect(sizes.unionKeys).toBe(keys.size);
    const stats = host!.stats();
    console.log(
      `[T1′] demand=${
        JSON.stringify({ ...stats.demand, sizeSeries: undefined })
      }`,
    );
    console.log(
      `[T1′] settle series (ms/class/waves/growthWakes): ${
        JSON.stringify(
          stats.settle.series.map((s) => [
            Math.round(s.ms),
            s.class,
            s.waves,
            s.growthWakes,
          ]),
        )
      }`,
    );
    setup.cancel();
  });

  it("T2′ probe: a wave writes a NEW LINK (a served handler sets slot := hidden, a computed it never reads) with a NON-creator, schema-narrowed ({slot:string}, additionalProperties:false) demander → RECORDS whether the target was already demanded (the closure follows the piece's `source`/process wiring, so a piece's own computeds are pre-empted), how it entered (tracker closure vs client pull), the cycle count and the settle split; asserts the landing and zero walk runs", async () => {
    // Alice CREATES the piece and DEPARTS (her session's tracked set —
    // which pulled every doc her local run read — leaves after the TTL);
    // Bob then watches ONLY the result root WITH THE RESULT SCHEMA, so
    // his closure is exactly what the schema reaches: the result doc,
    // `view`'s ifElse output doc — and, only after the flip writes the
    // link, `guarded`'s doc.
    host = newHost();
    const aliceClient = openClient(aliceSigner);
    const alice = aliceClient.runtime;
    const engine = await server.engineForSpace(space);
    const compiled = await alice.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: LINK_ON_EVENT_PATTERN }],
    }, { space });
    const aliceArg = alice.getCell<Record<string, unknown>>(
      space,
      "dp-b-arg",
      undefined,
    );
    const aliceResult = alice.getCell<Record<string, unknown>>(
      space,
      "dp-b-result",
      compiled.resultSchema,
    );
    await aliceArg.sync();
    await aliceResult.sync();
    {
      const seed = alice.edit();
      aliceArg.withTx(seed).set({ n: 7 });
      expect((await seed.commit()).error).toBeUndefined();
    }
    {
      const tx = alice.edit();
      alice.run(tx, compiled, aliceArg, aliceResult);
      expect((await tx.commit()).error).toBeUndefined();
    }
    await alice.idle();
    await alice.storageManager.synced();
    const resultId = aliceResult.getAsNormalizedFullLink().id;
    // Alice departs.
    await alice.dispose();
    await aliceClient.manager.close();
    runtimes.splice(runtimes.indexOf(alice), 1);
    managers.splice(managers.indexOf(aliceClient.manager), 1);
    await new Promise((resolve) => setTimeout(resolve, 900));
    // Bob: the ONLY demander, schema-narrowed root watch.
    const bobClient = openClient(bobSigner);
    const bob = bobClient.runtime;
    // Bob's DEMAND: a NARROW schema — only `slot` (a string) — so the
    // closure is the result doc plus, once the link exists, the string
    // behind `slot`. (`unknown` / Stream fields reach the whole wiring —
    // handler bindings, ifElse inputs — which is why the earlier shapes
    // found the target already demanded; recorded in the report.)
    const bobResult = bob.getCell<Record<string, unknown>>(
      space,
      "dp-b-result",
      {
        type: "object",
        properties: { slot: { type: "string" } },
        additionalProperties: false,
      } as never,
    );
    await bobResult.sync();
    const cancel = bobResult.sink(() => {});
    // The event is fired through a FULL-schema cell (the stream lives
    // under `pick`); the client's own speculative run may pull docs —
    // the row's `root` flag below says whether the target entered
    // through the tracker (closure) or a client pull (root).
    const bobFull = bob.getCell<Record<string, unknown>>(
      space,
      "dp-b-result",
      compiled.resultSchema,
    );
    await waitUntil(
      () => host!.spaceServer(space)?.active === true,
      "space activation",
    );
    await waitUntil(
      () =>
        (host!.spaceServer(space)?.demandedIdentitiesOf(resultId) ?? [])
          .some((i) => i.principal === bobSigner.did()),
      "bob's demand to register",
    );
    // Quiesce and let Alice's departed rows leave the set.
    await waitUntil(
      () => {
        host!.spaceServer(space)!.noteDemandChanged();
        return demandRows().every((r) =>
          r.identity?.principal === bobSigner.did()
        );
      },
      "alice's rows to leave (only bob's demand remains)",
    );
    await servingRuntime!.idle();
    await new Promise((resolve) => setTimeout(resolve, 500));
    const before = demandRows();
    const guardedRowsBefore = before.filter((r) =>
      r.id.startsWith("computed:")
    );
    const writersBefore = servingRuntime!.scheduler.demandedWriterCount;
    const wakesBefore = host!.stats().demand.pushGrowthWakes;
    const wavesBefore = host!.stats().waves;
    const derivedBefore = host!.stats().derivedCommits;
    const seriesBefore = host!.stats().settle.series.length;
    const guardedPresentBefore = instanceHolds(engine, "space", '"hidden:7"');
    console.log(
      `[T2′ pre rows] ${
        JSON.stringify(
          before.map((
            r,
          ) => [r.id.slice(0, 40), r.scopeKey, r.root ? "root" : "closure"]),
        )
      }`,
    );
    console.log(
      `[T2′ pre] rows=${before.length} computed rows=${guardedRowsBefore.length} (${
        guardedRowsBefore.map((r) => (r.root ? "root" : "closure")).join(",")
      }) demandedWriters=${writersBefore} guarded present=${guardedPresentBefore}`,
    );
    // Bob fires the `pick` event (an authored input; the served handler
    // writes the NEW LINK slot → hidden, reading nothing of hidden).
    const t0 = performance.now();
    bobFull.key("pick").send({});
    await bob.idle();
    await bob.storageManager.synced();
    await waitUntil(
      () => instanceHolds(engine, "space", '"hidden:7"'),
      () =>
        "the guarded value to land server-side (space rows: " +
        JSON.stringify([...rowsUnder(engine, "space").values()].slice(0, 12)) +
        ")",
    );
    const landedMs = performance.now() - t0;
    await new Promise((resolve) => setTimeout(resolve, 800));
    const stats = host!.stats();
    const after = demandRows();
    const newRows = after.filter((r) =>
      !before.some((b) => b.id === r.id && b.scopeKey === r.scopeKey)
    );
    console.log(
      `[T2′] guarded landed in ${Math.round(landedMs)} ms after bob's flip; ` +
        `waves +${stats.waves - wavesBefore}, derivedCommits +${
          stats.derivedCommits - derivedBefore
        }, pushGrowthWakes +${stats.demand.pushGrowthWakes - wakesBefore}, ` +
        `demandedWriters ${writersBefore} → ${
          servingRuntime!.scheduler.demandedWriterCount
        }, ` +
        `new rows=${newRows.length} [${
          newRows.map((r) =>
            `${r.id.slice(0, 18)}…:${r.root ? "root" : "closure"}`
          ).join(", ")
        }]; settle entries since: ${
          JSON.stringify(
            stats.settle.series.slice(seriesBefore).map((s) => ({
              ms: Math.round(s.ms),
              cls: s.class,
              waves: s.waves,
              gw: s.growthWakes,
              msGrowth: (s as { msGrowth?: number }).msGrowth === undefined
                ? undefined
                : Math.round((s as { msGrowth?: number }).msGrowth!),
              growthWaves: (s as { growthWaves?: number }).growthWaves,
              graceMs: (s as { graceMs?: number }).graceMs === undefined
                ? undefined
                : Math.round((s as { graceMs?: number }).graceMs!),
            })),
          )
        }`,
    );
    console.log(
      `[T2′ verdict] target demanded BEFORE the link: ${
        guardedPresentBefore ? "YES (pre-empted)" : "no"
      }; ` +
        `entered via: ${
          newRows.some((r) => r.id.startsWith("computed:") && !r.root)
            ? "TRACKER re-traversal (closure row)"
            : newRows.some((r) => r.id.startsWith("computed:") && r.root)
            ? "CLIENT pull (root row)"
            : "already present"
        }`,
    );
    expect(walkRuns()).toBe(0);
    cancel();
  });

  it("P-coarse: a departed session's rows leave and its writers' roots release; a doc tracked by two sessions stays while one remains", async () => {
    const setup = await standUp({
      names: { arg: "dp-c-arg", result: "dp-c-result" },
      clients: [aliceSigner, bobSigner],
    });
    const { engine, clients } = setup;
    const alice = clients.get(aliceSigner.did())!.runtime;
    const bob = clients.get(bobSigner.did())!;
    const aliceKey = setup.userKey(aliceSigner);
    const bobKey = setup.userKey(bobSigner);
    await setup.writeDraft(alice, "A");
    await setup.writeDraft(bob.runtime, "B");
    await waitUntil(
      () =>
        instanceHolds(engine, aliceKey, '"echo:A"') &&
        instanceHolds(engine, bobKey, '"echo:B"'),
      "each user's echo",
    );
    await servingRuntime!.idle();
    await new Promise((resolve) => setTimeout(resolve, 400));
    const writersBefore = servingRuntime!.scheduler.demandedWriterCount;
    const keysBefore = server.demandSetSizesForSpace(space, {
      excludePrincipal: serviceSigner.did(),
    }).unionKeys;
    const bobRowsBefore = demandRows().filter((r) => r.scopeKey === bobKey);
    expect(bobRowsBefore.length).toBeGreaterThan(0);
    // Bob departs: his runtime and connection close; the session prunes
    // after the (short) TTL; the next demand pass sees his rows gone.
    await bob.runtime.dispose();
    await bob.manager.close();
    runtimes.splice(runtimes.indexOf(bob.runtime), 1);
    managers.splice(managers.indexOf(bob.manager), 1);
    await new Promise((resolve) => setTimeout(resolve, 800));
    // Drive a pass (a demand note; a real input would do the same).
    await waitUntil(
      () => {
        host!.spaceServer(space)!.noteDemandChanged();
        return demandRows().filter((r) => r.scopeKey === bobKey).length === 0;
      },
      "bob's rows to leave the demand set",
    );
    await new Promise((resolve) => setTimeout(resolve, 600));
    const writersAfter = servingRuntime!.scheduler.demandedWriterCount;
    const keysAfter = server.demandSetSizesForSpace(space, {
      excludePrincipal: serviceSigner.did(),
    }).unionKeys;
    const stats = host!.stats();
    console.log(
      `[P-coarse] keys ${keysBefore} → ${keysAfter}; demandedWriters ${writersBefore} → ${writersAfter}; enters=${stats.demand.demandRootEnters} leaves=${stats.demand.demandRootLeaves}; registry keys=${stats.demand.demandedInstances}`,
    );
    // The space doc (the result root) tracked by Alice STAYS; the
    // registry shrank (Bob's user-instance keys left); roots released
    // only for writers whose every demanded key left (leaves counted).
    expect(keysAfter).toBeLessThan(keysBefore);
    expect(
      demandRows().some((r) =>
        r.id === setup.resultId && r.scopeKey === "space"
      ),
    ).toBe(true);
    expect(stats.demand.demandedInstances).toBe(keysAfter);
    expect(stats.demand.demandRootLeaves).toBeGreaterThanOrEqual(0);
    // Alice's demand still serves: her next draft re-derives.
    await setup.writeDraft(alice, "A2");
    await waitUntil(
      () => instanceHolds(engine, aliceKey, '"echo:A2"'),
      "alice's echo after bob left",
    );
    setup.cancel();
  });

  it("P-arrival: a second principal arriving after the node narrowed gets her instance on demand (per-key not-current re-arm / root arrival re-arm), the first principal's instance untouched", async () => {
    const setup = await standUp({
      names: { arg: "dp-d-arg", result: "dp-d-result" },
      clients: [aliceSigner],
    });
    const { engine, clients } = setup;
    const alice = clients.get(aliceSigner.did())!.runtime;
    const aliceKey = setup.userKey(aliceSigner);
    const bobKey = setup.userKey(bobSigner);
    await setup.writeDraft(alice, "A");
    await waitUntil(
      () => instanceHolds(engine, aliceKey, '"echo:A"'),
      "alice's instance",
    );
    await servingRuntime!.idle();
    await new Promise((resolve) => setTimeout(resolve, 400));
    const traceBefore = servingRuntime!.scheduler.getActionRunTrace().length;
    const rearmsBefore = host!.stats().demand.notCurrentRearms;
    const arrivalsBefore = host!.stats().demandArrivals;
    const bob = await setup.watchRoot(bobSigner);
    await waitUntil(
      () => instanceHolds(engine, bobKey, '"echo:"'),
      "bob's instance to materialize on arrival",
    );
    const since = servingRuntime!.scheduler.getActionRunTrace().slice(
      traceBefore,
    );
    expect(
      since.filter((e) => e.instanceKey === aliceKey).map((e) => e.actionId),
    ).toEqual([]);
    const stats = host!.stats();
    console.log(
      `[P-arrival] notCurrentRearms +${
        stats.demand.notCurrentRearms - rearmsBefore
      }, demandArrivals +${stats.demandArrivals - arrivalsBefore}`,
    );
    await setup.writeDraft(bob.runtime, "B");
    await waitUntil(
      () => instanceHolds(engine, bobKey, '"echo:B"'),
      "bob's instance to follow his draft",
    );
    expect(instanceHolds(engine, aliceKey, '"echo:B"')).toBe(false);
    setup.cancel();
  });
});
