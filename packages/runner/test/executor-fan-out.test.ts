// Server-execution v2 fan-out stage B — the per-demander run SUPPLY, END
// TO END against a real memory server, a live ExecutorHost, and N flag-ON
// clients. Owner ruling (2026-08-16): "if a space scoped calculation gets
// narrowed to user, it'll have to run for all users that demand it … as
// of now we haven't actually accomplished our goal of running all
// reactive computation server-side". The mechanism sentence (scopes.md §2,
// RULED 2026-08-16): a principal's demand at a BROAD address is demand
// for THAT principal's instance of every node that narrows beneath it.
//
// Every client here watches ONLY the space-scoped piece root — the one
// watch every client holds — never a scoped instance (stage A reached
// cardinality 2 through P2-F's scoped-root supply; stage B is what makes
// the plain root watch enough). Pinned red-first at the stage-A tip
// (978da5295), where the space root registered no identity and every
// per-user node ran once, as the service:
//
// - (a) two users demanding one node that narrows to user → TWO
//   server-side instances with the RIGHT per-user values, attributed to
//   the user (no session), the service identity never running demanded
//   work;
// - (b) a user arriving AFTER the node narrowed → their instance
//   materializes on demand (the ARRIVAL RE-ARM), the earlier user's
//   instance untouched;
// - (c) RAGGED: user-scoped for Alice, session-scoped for Bob → both
//   correct, Bob per session, no session-keyed rows for Alice (S4);
// - (d) a space-scoped node runs ONCE regardless of demander count, and
//   (e) the service identity runs NO demanded work;
// - (h) B7: an N-user × M-node probe — one user's input change recomputes
//   O(1) instances, not O(N);
// - (i) the OW29 storm pin: two users, divergent inputs, many authored
//   edits → waves bounded, no non-settling.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import * as Engine from "@commonfabric/memory/v2/engine";
import { decodeMemoryBoundary, resolveScopeKey } from "@commonfabric/memory/v2";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import { ExecutorHost } from "../src/executor/host.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const spaceSigner = await Identity.fromPassphrase("fan-out stage B");
const space = spaceSigner.did() as MemorySpace;
const serviceSigner = await Identity.fromPassphrase("fan-out stage B service");
const aliceSigner = await Identity.fromPassphrase("fan-out stage B alice");
const bobSigner = await Identity.fromPassphrase("fan-out stage B bob");
const carolSigner = await Identity.fromPassphrase("fan-out stage B carol");
const daveSigner = await Identity.fromPassphrase("fan-out stage B dave");

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

/** A piece with a PerUser draft its derivation READS (narrows to user),
 * a PerSession note a second derivation reads (narrows to session), and
 * a space-only `label` derivation. */
const FAN_OUT_PATTERN = [
  "import { computed, Default, pattern, PerSession, PerUser, Writable } from 'commonfabric';",
  "type Draft = Writable<string | Default<''>>;",
  "const text = (cell: Draft): string => (cell.get() as string | undefined) ?? '';",
  "export default pattern<",
  "  { draft?: PerUser<Draft>; note?: PerSession<Draft>; n?: number },",
  "  { echo: string; noteEcho: string; label: string }",
  ">(({ draft, note, n }) => {",
  "  const draftCell: Draft = draft!;",
  "  const noteCell: Draft = note!;",
  "  return {",
  "    echo: computed(() => 'echo:' + text(draftCell)),",
  "    noteEcho: computed(() => 'note:' + text(noteCell)),",
  "    label: computed(() => 'label:' + String(n ?? 0)),",
  "  };",
  "});",
].join("\n");

/** M per-user derivations over one PerUser draft (the B7 probe). */
const MULTI_NODE_PATTERN = (m: number) =>
  [
    "import { computed, Default, pattern, PerUser, Writable } from 'commonfabric';",
    "type Draft = Writable<string | Default<''>>;",
    "const text = (cell: Draft): string => (cell.get() as string | undefined) ?? '';",
    "export default pattern<",
    "  { draft?: PerUser<Draft>; n?: number },",
    `  { ${Array.from({ length: m }, (_, i) => `e${i}: string`).join("; ")} }`,
    ">(({ draft }) => {",
    "  const draftCell: Draft = draft!;",
    "  return {",
    ...Array.from(
      { length: m },
      (_, i) => `    e${i}: computed(() => 'e${i}:' + text(draftCell)),`,
    ),
    "  };",
    "});",
  ].join("\n");

/** Every current row of one scope INSTANCE: id → document value. */
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

const basisKeys = (engine: Engine.Engine): Set<string> =>
  new Set(
    (engine.database.prepare(
      `SELECT DISTINCT action_scope_key FROM scheduler_basis`,
    ).all() as Array<{ action_scope_key: string }>).map((row) =>
      row.action_scope_key
    ),
  );

const actingAnnotations = (engine: Engine.Engine) =>
  (engine.database.prepare(
    `SELECT annotations FROM "commit"
     WHERE class = 'derived' AND annotations IS NOT NULL`,
  ).all() as Array<{ annotations: string }>).flatMap((row) =>
    decodeMemoryBoundary(row.annotations) as unknown as Array<{
      scopeKey?: string;
      actingUser?: string;
      actingSession?: string;
    }>
  ).filter((annotation) => annotation.actingUser !== undefined);

describe("fan-out stage B: the per-demander run supply (E2E)", () => {
  let server: MemoryV2Server.Server;
  let host: ExecutorHost | undefined;
  let managers: EmulatedStorageManager[];
  let runtimes: Runtime[];
  let servingRuntime: Runtime | undefined;

  const newHost = (
    policy: ConstructorParameters<typeof ExecutorHost>[0]["policy"] = {},
  ): ExecutorHost =>
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
      policy: { flushDeadlineMs: 5_000, idleParkMs: 600_000, ...policy },
    });

  beforeEach(() => {
    server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
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

  const openClient = (signer: Identity): Runtime => {
    const manager = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      experimental: { serverExecution: true },
    });
    managers.push(manager);
    runtimes.push(runtime);
    return runtime;
  };

  /** Alice stands the piece up; every client then holds ONLY the
   * space-scoped root watch (`sink` on the result doc) — the demand every
   * browser has, and nothing more. */
  const standUp = async (options: {
    names: { arg: string; result: string };
    pattern?: string;
    clients: Identity[];
  }) => {
    host = newHost();
    const alice = openClient(aliceSigner);
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

    const clients = new Map<string, Runtime>([[aliceSigner.did(), alice]]);
    const cancels: Array<() => void> = [];
    const watchRoot = async (signer: Identity): Promise<Runtime> => {
      const runtime = clients.get(signer.did()) ?? openClient(signer);
      clients.set(signer.did(), runtime);
      const result = runtime.getCell<Record<string, unknown>>(
        space,
        options.names.result,
        undefined,
      );
      await result.sync();
      // THE demand: the space-scoped root watch. Nothing scoped.
      cancels.push(result.sink(() => {}));
      return runtime;
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
      runtime.getCell<{ draft: string; note: string; n: number }>(
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
    const writeNote = async (runtime: Runtime, value: string) => {
      const arg = typedArg(runtime);
      await arg.sync();
      const tx = runtime.edit();
      arg.key("note").withTx(tx).set(value);
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
      writeNote,
      userKey,
      serviceUserKey: resolveScopeKey("user", {
        principal: serviceSigner.did(),
      }),
      cancel: () => cancels.forEach((cancel) => cancel()),
    };
  };

  it("(a) two users watching ONLY the space root of a piece with a per-user derivation get TWO server-side instances with their OWN values, attributed to the user alone; the service identity ran no demanded work (the arbitration)", async () => {
    const setup = await standUp({
      names: { arg: "fo-a-arg", result: "fo-a-result" },
      clients: [aliceSigner, bobSigner],
    });
    const { engine, clients } = setup;
    const alice = clients.get(aliceSigner.did())!;
    const bob = clients.get(bobSigner.did())!;
    const aliceKey = setup.userKey(aliceSigner);
    const bobKey = setup.userKey(bobSigner);

    // Divergent per-user drafts, through the argument schema.
    await setup.writeDraft(alice, "A");
    await setup.writeDraft(bob, "B");

    // THE ARBITRATION: each principal's instance of the echo doc holds
    // ITS OWN input's echo — with nothing but the space root demanded.
    // At the stage-A tip the space root registered no identity, so the
    // node ran once as the service and wrote `user:<serviceDID>` only.
    await waitUntil(
      () =>
        instanceHolds(engine, aliceKey, '"echo:A"') &&
        instanceHolds(engine, bobKey, '"echo:B"'),
      () =>
        `each instance's echo of its own draft (alice: ${
          instanceHolds(engine, aliceKey, '"echo:A"')
        }, bob: ${instanceHolds(engine, bobKey, '"echo:B"')})`,
    );
    expect(instanceHolds(engine, aliceKey, '"echo:B"')).toBe(false);
    expect(instanceHolds(engine, bobKey, '"echo:A"')).toBe(false);
    // (e) The service identity NEVER runs demanded work: no demanded
    // instance value under its key, no basis row under it.
    expect(instanceHolds(engine, setup.serviceUserKey, '"echo:')).toBe(false);
    expect(basisKeys(engine).has(setup.serviceUserKey)).toBe(false);
    expect(basisKeys(engine).has(aliceKey)).toBe(true);
    expect(basisKeys(engine).has(bobKey)).toBe(true);
    // Attribution (design §F, RULED 2026-08-16): a user-scoped instance
    // run acts as the USER — no session on its writes; never the service.
    await waitUntil(
      () =>
        actingAnnotations(engine).some((a) =>
          a.actingUser === aliceSigner.did()
        ) &&
        actingAnnotations(engine).some((a) => a.actingUser === bobSigner.did()),
      "both users' acting annotations",
    );
    const annotations = actingAnnotations(engine);
    expect(annotations.every((a) => a.actingSession === undefined)).toBe(
      true,
    );
    expect(annotations.some((a) => a.actingUser === serviceSigner.did()))
      .toBe(false);
    // Each user's writes are keyed under that user's instance.
    for (
      const [signer, key] of [[aliceSigner, aliceKey], [
        bobSigner,
        bobKey,
      ]] as const
    ) {
      expect(
        annotations.filter((a) => a.actingUser === signer.did()).every((a) =>
          a.scopeKey === undefined || a.scopeKey === key
        ),
      ).toBe(true);
    }
    // No stage-B counter tripped: no early emit, no undemanded narrowing.
    expect(host!.stats().earlyEmitRefusals).toBe(0);
    setup.cancel();
  });

  it("(b) a user who arrives AFTER the node narrowed gets their instance on demand — the ARRIVAL RE-ARM — while the earlier user's instance is untouched", async () => {
    const setup = await standUp({
      names: { arg: "fo-b-arg", result: "fo-b-result" },
      clients: [aliceSigner],
    });
    const { engine, clients } = setup;
    const alice = clients.get(aliceSigner.did())!;
    const aliceKey = setup.userKey(aliceSigner);
    const bobKey = setup.userKey(bobSigner);
    await setup.writeDraft(alice, "A");
    await waitUntil(
      () => instanceHolds(engine, aliceKey, '"echo:A"'),
      "alice's instance (the node narrowed for her)",
    );
    const arrivalsBefore = host!.stats().demandArrivals;
    const traceBefore = servingRuntime!.scheduler.getActionRunTrace().length;

    // Bob ARRIVES: his root watch (space) is a new demander of a root
    // whose nodes already narrowed. Nothing else changes — no input
    // write. Pre-stage-B (and with the re-arm removed): a clean node
    // never re-runs for a demander that did not exist when it last ran,
    // so Bob's instance would never materialize.
    const bob = await setup.watchRoot(bobSigner);
    await waitUntil(
      () => instanceHolds(engine, bobKey, '"echo:"'),
      "bob's instance to materialize on arrival (empty draft → 'echo:')",
    );
    expect(host!.stats().demandArrivals).toBeGreaterThan(arrivalsBefore);
    // Alice's instance did not re-run for Bob's arrival (B7: the arrival
    // re-arm keeps her instance clean).
    const sinceArrival = servingRuntime!.scheduler.getActionRunTrace()
      .slice(traceBefore);
    expect(
      sinceArrival.filter((entry) => entry.instanceKey === aliceKey).length,
    ).toBe(0);
    // And once Bob types, his instance follows his input.
    await setup.writeDraft(bob, "B");
    await waitUntil(
      () => instanceHolds(engine, bobKey, '"echo:B"'),
      "bob's instance to re-derive from his draft",
    );
    expect(instanceHolds(engine, aliceKey, '"echo:B"')).toBe(false);
    setup.cancel();
  });

  it("(c) RAGGED: a node user-scoped for Alice and session-scoped for Bob — Bob's instance per session, Alice's per user, both correct, no session-keyed rows for Alice (S4)", async () => {
    const setup = await standUp({
      names: { arg: "fo-c-arg", result: "fo-c-result" },
      clients: [aliceSigner, bobSigner],
    });
    const { engine, clients } = setup;
    const alice = clients.get(aliceSigner.did())!;
    const bob = clients.get(bobSigner.did())!;
    const aliceKey = setup.userKey(aliceSigner);
    const bobKey = setup.userKey(bobSigner);
    // Alice writes a per-user draft; Bob writes a per-SESSION note. The
    // `noteEcho` node then reads session state for Bob (his note is a
    // session doc) and — through the never-written note slot's redirect
    // chain — for Alice too once Bob's write narrowed the slot: the
    // slot's space redirect points via user to session (the eager
    // via-user hop), so Alice's read of it discovers `session` as well.
    // The RAGGED shape lives on the `echo` node: Alice's draft narrows
    // it to user; Bob's session note does not touch it. Bob's session
    // instances of `noteEcho` hold his note; Alice's session instances
    // hold nothing.
    await setup.writeDraft(alice, "A");
    await setup.writeNote(bob, "N");
    await waitUntil(
      () => instanceHolds(engine, aliceKey, '"echo:A"'),
      "alice's user instance of echo",
    );
    // Bob's note echo lands under his SESSION instance.
    const bobSessions = engine.database.prepare(
      `SELECT DISTINCT scope_key FROM head WHERE scope_key LIKE :prefix AND op != 'delete'`,
    ).all({
      prefix: `session:${encodeURIComponent(bobSigner.did())}:%`,
    }) as Array<{ scope_key: string }>;
    await waitUntil(
      () =>
        (engine.database.prepare(
          `SELECT DISTINCT scope_key FROM head WHERE scope_key LIKE :prefix AND op != 'delete'`,
        ).all({
          prefix: `session:${encodeURIComponent(bobSigner.did())}:%`,
        }) as Array<{ scope_key: string }>).some((row) =>
          instanceHolds(engine, row.scope_key, '"note:N"')
        ),
      () =>
        `bob's session instance of noteEcho (session keys: ${
          JSON.stringify(bobSessions)
        })`,
    );
    // Neither user's value crossed.
    expect(instanceHolds(engine, bobKey, '"echo:A"')).toBe(false);
    // Basis rows: Alice's `echo` rows under her USER key; Bob's noteEcho
    // rows under his SESSION key; the space-only label under `space`;
    // NO session-keyed basis row for Alice's echo — the ragged S4 pin:
    // a session-deep sibling never over-keys a user-scoped principal.
    await waitUntil(
      () =>
        [...basisKeys(engine)].some((key) =>
          key.startsWith(`session:${encodeURIComponent(bobSigner.did())}:`)
        ),
      () => `bob's session basis key (keys: ${[...basisKeys(engine)]})`,
    );
    const keys = basisKeys(engine);
    expect(keys.has(aliceKey)).toBe(true);
    expect(keys.has("space")).toBe(true);
    expect(keys.has(setup.serviceUserKey)).toBe(false);
    // The scheduler's ratchet is RAGGED: Bob session-deep on the note
    // node, Alice user-deep everywhere — asserted on the store truth
    // above and on the run trace's instance keys below.
    const trace = servingRuntime!.scheduler.getActionRunTrace();
    const sessionRuns = trace.filter((entry) =>
      entry.instanceKey?.startsWith("session:")
    );
    expect(sessionRuns.length).toBeGreaterThan(0);
    // Every session-keyed run belongs to Bob — Alice never ran per
    // session (the ragged ratchet is per principal).
    const aliceSessionRuns = sessionRuns.filter((entry) =>
      !entry.instanceKey!.startsWith(
        `session:${encodeURIComponent(bobSigner.did())}:`,
      )
    );
    // (A pre-fix shape made THIS assertion flake: Bob's session
    // narrowing wrote the session redirect at the SHARED space slot
    // when Alice's user narrowing had already put the user redirect
    // there — pattern-binding.ts's ragged fix keeps the second hop in
    // Bob's own user slot.)
    expect(
      aliceSessionRuns.map((e) => [e.actionId, e.instanceKey]),
    ).toEqual([]);
    setup.cancel();
  });

  it("(d) a space-scoped node runs ONCE regardless of demander count, and (e) never as the service: three demanders, one `label` run per input change, stamped as a demander", async () => {
    const setup = await standUp({
      names: { arg: "fo-d-arg", result: "fo-d-result" },
      clients: [aliceSigner, bobSigner, carolSigner],
    });
    const { engine, clients } = setup;
    const alice = clients.get(aliceSigner.did())!;
    // The label doc: the result's `label` link target.
    const aliceResult = alice.getCell<{ label?: unknown }>(
      space,
      "fo-d-result",
      setup.compiled.resultSchema,
    );
    await aliceResult.sync();
    await waitUntil(
      () => instanceHolds(engine, "space", '"label:1"'),
      "the label derivation to land",
    );
    // Change the space input: the label node re-runs.
    const traceBefore = servingRuntime!.scheduler.getActionRunTrace().length;
    {
      const arg = alice.getCell<{ n: number }>(space, "fo-d-arg", undefined);
      await arg.sync();
      const tx = alice.edit();
      arg.key("n").withTx(tx).set(2);
      expect((await tx.commit()).error).toBeUndefined();
    }
    await waitUntil(
      () => instanceHolds(engine, "space", '"label:2"'),
      "the label derivation to re-derive",
    );
    // Give the loop a moment to run anything else it would.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const since = servingRuntime!.scheduler.getActionRunTrace().slice(
      traceBefore,
    );
    // Find the label node's runs: the ones that WROTE the label doc.
    const labelDocId = (() => {
      const rows = engine.database.prepare(
        `SELECT id FROM head WHERE scope_key = 'space' AND op != 'delete'`,
      ).all() as Array<{ id: string }>;
      for (const { id } of rows) {
        const value = Engine.read(engine, { id, scopeKey: "space" } as never)
          ?.value;
        if (JSON.stringify(value ?? null).includes('"label:2"')) return id;
      }
      throw new Error("label doc not found");
    })();
    const labelRuns = since.filter((entry) =>
      entry.actualWrites.some((write) => write.entityId === labelDocId)
    );
    // ONE run — the probe — for THREE demanders (pre-stage-B P2-F ran
    // one per identity-bearing demand; the design's B2 runs a space node
    // once). Stamped `space`, as a demander (never the fallback: an
    // undemanded fallback run carries no instance key).
    expect(labelRuns.length).toBe(1);
    expect(labelRuns[0].instanceKey).toBe("space");
    // And the label's basis rows key `space` only.
    expect(basisKeys(engine).has(setup.serviceUserKey)).toBe(false);
    setup.cancel();
  });

  it("(h) B7 scaling probe — N users × M narrowed nodes: ONE user's input change re-runs only that user's M instances, never the other users' (precise per-instance dirtiness); the node count stays independent of N (C11b)", async () => {
    const M = 3;
    const users = [aliceSigner, bobSigner, carolSigner, daveSigner];
    const setup = await standUp({
      names: { arg: "fo-h-arg", result: "fo-h-result" },
      pattern: MULTI_NODE_PATTERN(M),
      clients: users,
    });
    const { engine, clients } = setup;
    // Every user types once: N × M instances materialize.
    for (const [index, signer] of users.entries()) {
      await setup.writeDraft(clients.get(signer.did())!, `v${index}`);
    }
    await waitUntil(
      () =>
        users.every((signer, index) =>
          Array.from({ length: M }, (_, i) =>
            instanceHolds(
              engine,
              setup.userKey(signer),
              `"e${i}:v${index}"`,
            )).every(Boolean)
        ),
      "every user's M instances",
      30_000,
    );
    // The DERIVATION nodes (the demand WALKS are effect nodes, one per
    // demand key — a client syncing a new doc adds a key, never an
    // instance; they are excluded from both counts below).
    const derivationNodeCount = () =>
      servingRuntime!.scheduler.getGraphSnapshot().nodes.filter((node) =>
        !node.id.startsWith("demand-walk:")
      ).length;
    const nodesBefore = derivationNodeCount();
    // Quiesce, then ONE user's change.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const traceBefore = servingRuntime!.scheduler.getActionRunTrace().length;
    await setup.writeDraft(clients.get(bobSigner.did())!, "v1b");
    await waitUntil(
      () =>
        Array.from(
          { length: M },
          (_, i) =>
            instanceHolds(engine, setup.userKey(bobSigner), `"e${i}:v1b"`),
        )
          .every(Boolean),
      "bob's M instances to re-derive",
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    const since = servingRuntime!.scheduler.getActionRunTrace().slice(
      traceBefore,
    );
    const perUserRuns = since.filter((entry) =>
      entry.instanceKey !== undefined &&
      entry.instanceKey.startsWith("user:") &&
      // The demand walk re-fires per changed doc it read (an effect, N ×
      // walk per changed root — the design's stated cost); B7's claim is
      // about the DERIVATIONS.
      !entry.actionId.startsWith("demand-walk:")
    );
    const bobRuns = perUserRuns.filter((entry) =>
      entry.instanceKey === setup.userKey(bobSigner)
    );
    const otherRuns = perUserRuns.filter((entry) =>
      entry.instanceKey !== setup.userKey(bobSigner)
    );
    // THE PROBE: Bob's change recomputed Bob's M instances (each once)
    // and NOBODY else's — O(1) users, not O(N). With instance-imprecise
    // dirtiness every user's M instances re-run (the mutation: N × M).
    expect(bobRuns.length).toBe(M);
    expect(otherRuns.length).toBe(0);
    // Reported for the record: runs since Bob's change vs. the naive
    // bound N × M.
    const perAction = new Map<string, number>();
    for (const entry of bobRuns) {
      perAction.set(entry.actionId, (perAction.get(entry.actionId) ?? 0) + 1);
    }
    console.log(
      `[B7 probe] N=${users.length} M=${M}: per-user runs after one ` +
        `user's change = ${perUserRuns.length} (bob ${bobRuns.length}, ` +
        `others ${otherRuns.length}); naive bound N×M = ${users.length * M}; ` +
        `bob's runs per action: ${
          JSON.stringify(
            [...perAction.entries()].map(([id, n]) => [id.slice(-24), n]),
          )
        }; derivation nodes before ${nodesBefore} after ${derivationNodeCount()}`,
    );
    // C11b: the derivation graph did not grow with the instances.
    expect(derivationNodeCount()).toBe(nodesBefore);
    setup.cancel();
  });

  it("(i) the OW29 storm pin: two users, divergent per-user inputs, many authored edits each → waves bounded by the inputs, no non-settling, both instances converge on the last value", async () => {
    const setup = await standUp({
      names: { arg: "fo-i-arg", result: "fo-i-result" },
      clients: [aliceSigner, bobSigner],
    });
    const { engine, clients } = setup;
    const alice = clients.get(aliceSigner.did())!;
    const bob = clients.get(bobSigner.did())!;
    const aliceKey = setup.userKey(aliceSigner);
    const bobKey = setup.userKey(bobSigner);
    await setup.writeDraft(alice, "a0");
    await setup.writeDraft(bob, "b0");
    await waitUntil(
      () =>
        instanceHolds(engine, aliceKey, '"echo:a0"') &&
        instanceHolds(engine, bobKey, '"echo:b0"'),
      "both instances derived once",
    );
    const wavesBefore = host!.stats().waves;
    const EDITS = 20;
    for (let i = 1; i <= EDITS; i++) {
      await setup.writeDraft(alice, `a${i}`);
      await setup.writeDraft(bob, `b${i}`);
    }
    await waitUntil(
      () =>
        instanceHolds(engine, aliceKey, `"echo:a${EDITS}"`) &&
        instanceHolds(engine, bobKey, `"echo:b${EDITS}"`),
      "both instances to converge on the last edit",
      30_000,
    );
    // Quiescence: no further waves once the inputs stop (the storm was
    // 4,427 waves / 5 min at the deadline cadence, without inputs).
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const wavesAtQuiescence = host!.stats().waves;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(host!.stats().waves).toBe(wavesAtQuiescence);
    // Bounded by the inputs plus a small constant (one wave may carry
    // several inputs; a discovery re-arm runs inside its wave).
    expect(wavesAtQuiescence - wavesBefore).toBeLessThanOrEqual(
      2 * EDITS + 8,
    );
    // Never the sibling's value in either instance.
    expect(instanceHolds(engine, aliceKey, `"echo:b`)).toBe(false);
    expect(instanceHolds(engine, bobKey, `"echo:a`)).toBe(false);
    setup.cancel();
  });
});
