import { expect } from "@std/expect";
import type { Identity } from "@commonfabric/identity";
import type { MemorySpace, Signer } from "@commonfabric/memory/interface";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import {
  type Options,
  type SessionFactory,
  StorageManager,
} from "../src/storage/v2.ts";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import {
  TEST_MEMORY_SERVER_AUTH,
  testPrincipalSessionOpenAuthFactory,
} from "./memory-v2-test-utils.ts";

// Shared, edge-triggered harness for the "append during the resume-await window"
// regression tests (filter/map/flatMap).
//
// The bug reproduces only when an element is appended while the per-element
// result documents of the resumed list builtin are still streaming in. A
// wall-clock delay on those documents cannot guarantee that ordering: on a slow
// or loaded CI host the documents can arrive before the append, the window never
// opens, and the test passes even with the fix reverted — a regression would
// then land on main. Instead this harness HOLDS the per-element documents in the
// transport until the test explicitly releases them, so the append lands inside
// the window on every run, and asserts the window was genuinely open.

// The per-element run documents are matched specifically: each element's op is a
// projection of `element.<field>`, so its result document carries a link whose
// path starts `["element", ...]`. The container/input sync (which carries the
// input array and the aggregate schema) does not, so the gate holds only the
// sibling result documents the coordinator reads while startup and resume still
// complete. A broader schema matcher (for example `"type":"boolean"`) would also
// catch the start-critical container sync and deadlock startup once the gate
// holds rather than delays those documents.
export const PER_ELEMENT_RESULT_DOC = /"path":\["element"/;

// A transport gate that holds inbound messages matching a pattern until the test
// opens it, rather than releasing them on a timer.
class Gate {
  #open = false;
  #held: string[] = [];
  #deliver: (payload: string) => void = () => {};
  #firstHeldResolve: (() => void) | undefined;
  /**
   * Resolves the first time a matching document is held back — the edge that the
   * coordinator has reconciled the resume batch (it has read, and so requested,
   * the per-element result documents). The test awaits this instead of polling.
   */
  readonly firstHeld: Promise<void>;
  constructor(private readonly match: RegExp) {
    this.firstHeld = new Promise((resolve) => {
      this.#firstHeldResolve = resolve;
    });
  }
  wrap(inner: MemoryV2Client.Transport): MemoryV2Client.Transport {
    return {
      send: (payload: string) => inner.send(payload),
      close: () => inner.close(),
      setReceiver: (receive: (payload: string) => void) => {
        this.#deliver = receive;
        inner.setReceiver((payload: string) => {
          if (!this.#open && this.match.test(payload)) {
            this.#held.push(payload);
            this.#firstHeldResolve?.();
            this.#firstHeldResolve = undefined;
          } else receive(payload);
        });
      },
      setCloseReceiver: (r: (e?: Error) => void) => inner.setCloseReceiver?.(r),
    };
  }
  /** How many matching documents are currently held back. */
  get heldCount(): number {
    return this.#held.length;
  }
  /** Open the gate and flush every held document to the client. */
  release(): void {
    this.#open = true;
    const queued = this.#held.splice(0);
    for (const payload of queued) this.#deliver(payload);
  }
}

class GatedSessionFactory implements SessionFactory {
  constructor(
    private getServer: () => MemoryV2Server.Server,
    private gate?: Gate,
  ) {}
  async create(id: string, signer?: Signer) {
    const base = MemoryV2Client.loopback(this.getServer());
    const transport = this.gate ? this.gate.wrap(base) : base;
    const client = await MemoryV2Client.connect({ transport });
    const session = await client.mount(
      id,
      {},
      testPrincipalSessionOpenAuthFactory(signer),
    );
    return { client, session };
  }
}

class GatedStorageManager extends StorageManager {
  static make(as: Identity, server: MemoryV2Server.Server, gate?: Gate) {
    return new GatedStorageManager(
      { as, memoryHost: new URL("memory://") } as Options,
      server,
      gate,
    );
  }
  private constructor(o: Options, server: MemoryV2Server.Server, gate?: Gate) {
    super(o, new GatedSessionFactory(() => server, gate));
  }
  override registerSpaceHost(): boolean {
    return false;
  }
}

export function makeServer(): MemoryV2Server.Server {
  return new MemoryV2Server.Server({
    authorizeSessionOpen(m) {
      const p = (m.authorization as { principal?: unknown })?.principal;
      return typeof p === "string" ? p : undefined;
    },
    sessionOpenAuth: TEST_MEMORY_SERVER_AUTH.sessionOpenAuth,
  });
}

export interface AppendScenario {
  readonly signer: Identity;
  readonly space: MemorySpace;
  readonly server: MemoryV2Server.Server;
  readonly program: RuntimeProgram;
  /** Result cell id in the space. */
  readonly cellId: string;
  /** Result field the aggregate is published under (e.g. "kept"/"values"). */
  readonly resultKey: string;
  /** Initial input list. */
  readonly items: readonly unknown[];
  /** Element appended during the resume window. */
  readonly appended: unknown;
  /** Extract the comparable aggregate from the result cell for assertions. */
  readonly read: (
    rc: { key: (k: string) => { getAsQueryResult: () => unknown } },
  ) => unknown[];
  /** Expected aggregate after the first-runtime build. */
  readonly buildExpected: unknown[];
}

async function build(scenario: AppendScenario): Promise<void> {
  const { signer, space, server, program, cellId, items } = scenario;
  const sm = GatedStorageManager.make(signer, server);
  // Build the durable aggregate through the LEGACY coordinator, even under the
  // interpreter flag. The gate window this harness forces (below) holds each
  // element's per-element RESULT document as it streams in on resume — but only
  // the legacy coordinator persists those documents. The flag-on inline filter
  // evaluates its predicates in-segment and keeps the ORIGINAL element
  // references, so it never writes a streamable per-element result doc; a
  // flag-on inline build would leave the gate with nothing to hold and
  // `firstHeld` would never resolve (the same reason map is not gated here).
  // The RESUME runtime keeps the ambient flag: the interpreter refuses resumed
  // collections and falls back to the legacy coordinator, so the resume path —
  // the actual subject of these tests — is still exercised flag-on.
  const rt = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: sm,
    experimental: { experimentalInterpreter: false },
  });
  const compiled = await rt.patternManager.compilePattern(program, { space });
  const tx0 = rt.edit();
  const rc = rt.getCell<Record<string, unknown>>(
    space,
    cellId,
    compiled.resultSchema,
    tx0,
  );
  rt.run(tx0, compiled, { items }, rc);
  await tx0.commit();
  // Drive the aggregate to convergence: pull() reads to quiescence and settled()
  // waits for the scheduler, storage sync, and any async builtin work — both
  // converge internally, so no pump loop here.
  await rc.pull();
  await rt.settled();
  await rt.patternManager.flushCompileCacheWrites();
  await sm.synced();
  expect(scenario.read(rc)).toEqual(scenario.buildExpected);
  rt.scheduler.dispose();
  await rt.dispose();
  // Close the build session's storage manager (sibling harnesses close theirs in
  // afterEach): a per-element result watch can otherwise keep a transport promise
  // pending past process end, which the op sanitizer reports as a leak.
  await sm.close();
}

/**
 * Build the aggregate in a first runtime, then resume in a second runtime behind
 * a gate that holds the per-element result documents. Append an element while
 * they are held (so its reconcile reads the still-stale sibling results and is
 * reverted), release the documents, and let the aggregate converge. Returns the
 * final aggregate and how many documents were held when the append landed — the
 * caller asserts both, so a run that never opened the window fails loudly rather
 * than passing vacuously.
 */
export async function runResumeAppendScenario(
  scenario: AppendScenario,
): Promise<{ output: unknown[]; heldCount: number }> {
  await build(scenario);

  const gate = new Gate(PER_ELEMENT_RESULT_DOC);
  const sm2 = GatedStorageManager.make(scenario.signer, scenario.server, gate);
  const rt2 = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: sm2,
  });
  try {
    const compiled = await rt2.patternManager.compilePattern(scenario.program, {
      space: scenario.space,
    });
    const tx = rt2.edit();
    const rc2 = rt2.getCell<Record<string, unknown>>(
      scenario.space,
      scenario.cellId,
      compiled.resultSchema,
      tx,
    );
    await tx.commit();

    const started = await rt2.start(rc2);
    expect(started).toBe(true);

    // Standing effect so `idle()` drives the coordinator without `pull()`. While
    // the gate holds the per-element documents, `pull()` would block on the
    // armed recovery's cross-space promise, but `idle()` does not.
    // A standing effect keeps the coordinator pulled, so the scheduler drives it
    // to reconcile on its own as inputs load — the test awaits real edges rather
    // than pumping idle() in a loop.
    const cancel = rc2.key(scenario.resultKey).sink(() => {});
    let heldCount = 0;
    try {
      // Wait for the edge that the coordinator has reconciled the resume batch:
      // its first read of the per-element result cells causes their documents to
      // be requested, and the gate holds the first one. Only after that reconcile
      // is the resume-await flag cleared, so an element appended now is a
      // post-resume append that arms the recovery — appending earlier would fold
      // it into the resume batch instead, with no recovery.
      await gate.firstHeld;
      expect(gate.heldCount).toBeGreaterThan(0);

      // Append while the per-element results are held. The coordinator's
      // reconcile reads the still-stale sibling result cells, so its commit is
      // rejected as stale and the appended element's inline write is reverted.
      const tx1 = rt2.edit();
      const cur = (rc2.key("items").get() ?? []) as unknown[];
      rc2.withTx(tx1).key("items").set([...cur, scenario.appended]);
      await tx1.commit();
      // Let the coordinator reconcile the appended element (and arm its recovery)
      // against the still-held results. idle() drives the scheduler to quiescence
      // without blocking on the held documents the way pull() would.
      await rt2.idle();

      // The window was genuinely open: per-element documents were held while the
      // appended element reconciled.
      heldCount = gate.heldCount;

      // Release the held documents. The space catches up, the stale write is
      // dropped, and the post-sync recovery re-applies the appended element.
      gate.release();

      // Converge: pull() awaits the recovery's cross-space work (now unblocked)
      // and re-reads to quiescence; settled() then flushes the reconcile the
      // recovery's write triggers. Both converge internally, so no loop here.
      await rc2.pull();
      await rt2.settled();
    } finally {
      cancel();
    }

    return { output: scenario.read(rc2), heldCount };
  } finally {
    await rt2.dispose();
    await sm2.close();
  }
}
