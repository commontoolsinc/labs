/**
 * EXPERIMENT: does lifting the single-flight `#watchRefreshFlushing` guard let
 * watch-refresh round trips overlap?
 *
 * Measured motivation: in mobile-Loom HAR captures, per-space watch acquisition
 * is strict single-flight — 0 overlapping requests within a space across 154
 * round trips — so traversal-driven pulls discovered a tick apart serialize
 * into one-RTT-each frames. This pins the current behavior and the behavior
 * under `experimentalConcurrentWatchRefresh`.
 *
 * The transport holds every `watch.add` response open and signals on receipt,
 * so the test can observe how many refreshes are in flight at once.
 */
import { assert, assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import type { URI } from "@commonfabric/memory/interface";
import {
  type EntityDocument,
  type SessionSync,
  type SessionSyncUpsert,
} from "@commonfabric/memory/v2";
import type { IStorageProviderWithReplica } from "../src/storage/interface.ts";
import { defaultSettings } from "../src/storage/v2.ts";
import { __setConcurrentWatchRefresh } from "@commonfabric/memory/v2/client";
import {
  ScriptedSessionTransport,
  type ScriptedTransportMessage,
  SingleSessionFactory,
  TestStorageManager,
} from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("memory-v2-concurrent-refresh");
const space = signer.did();

type TestProvider = IStorageProviderWithReplica & {
  get(uri: URI): EntityDocument | undefined;
  sync(
    uri: URI,
    selector?: { path: string[]; schema: unknown },
  ): Promise<unknown>;
};

const doc = (
  id: URI,
  seq: number,
  value: SessionSyncUpsert["doc"],
): SessionSyncUpsert => ({ branch: "", id, seq, doc: value });

const fullSync = (
  toSeq: number,
  upserts: SessionSyncUpsert[],
): SessionSync => ({ type: "sync", fromSeq: 0, toSeq, upserts, removes: [] });

/**
 * Holds every `watch.add` response open. Records how many are in flight
 * simultaneously (the whole point of the measurement) and lets the test
 * release them explicitly.
 */
class HoldingTransport extends ScriptedSessionTransport {
  watchAddCount = 0;
  inFlight = 0;
  maxConcurrent = 0;
  rootCounts: number[] = [];
  #held: Array<() => void> = [];
  #sentSignals = new Map<number, ReturnType<typeof Promise.withResolvers<void>>>();

  constructor() {
    super({
      name: "concurrent-refresh",
      sessionId: "session:concurrent-refresh",
      space,
    });
  }

  /** Resolves when the Nth `watch.add` has been received. */
  sent(n: number): Promise<void> {
    let d = this.#sentSignals.get(n);
    if (!d) {
      d = Promise.withResolvers<void>();
      this.#sentSignals.set(n, d);
    }
    return d.promise;
  }

  releaseAll(): void {
    const held = this.#held;
    this.#held = [];
    for (const respond of held) respond();
  }

  protected override ackServerSeq(): number {
    return 100;
  }

  protected override handle(message: ScriptedTransportMessage): void {
    if (message.type !== "session.watch.add") {
      throw new Error(`Unhandled scripted message: ${message.type}`);
    }
    this.watchAddCount += 1;
    this.inFlight += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.inFlight);
    const roots = message.watches?.flatMap((w) =>
      w.query?.roots?.map((r) => r.id as URI) ?? []
    ) ?? [];
    this.rootCounts.push(roots.length);

    (this.#sentSignals.get(this.watchAddCount) ??
      (() => {
        const d = Promise.withResolvers<void>();
        this.#sentSignals.set(this.watchAddCount, d);
        return d;
      })()).resolve();

    this.#held.push(() => {
      this.inFlight -= 1;
      this.respond({
        type: "response",
        requestId: message.requestId!,
        ok: {
          serverSeq: roots.length,
          sync: fullSync(
            roots.length,
            roots.map((id, i) => doc(id, i + 1, { value: { label: id } })),
          ),
        },
      });
    });
  }
}

function makeProvider(concurrent: boolean) {
  // Both serialization layers must lift together: the SpaceReplica flush guard
  // (settings flag) AND the client session's runWatchMutation chain (this
  // toggle). Lifting only one leaves the other serializing.
  __setConcurrentWatchRefresh(concurrent);
  const transport = new HoldingTransport();
  const storageManager = TestStorageManager.create({
    as: signer,
    memoryHost: new URL(`memory://concurrent-refresh-${concurrent}`),
    settings: {
      ...defaultSettings,
      experimentalConcurrentWatchRefresh: concurrent,
    },
  }, new SingleSessionFactory(transport));
  return { transport, storageManager,
    provider: storageManager.open(space) as TestProvider };
}

/**
 * Issue N pulls one microtask-wave apart (each after the previous refresh has
 * been *sent* but not answered), simulating traversal that discovers the next
 * cell only after the prior request goes out.
 */
async function drive(provider: TestProvider, transport: HoldingTransport, n: number) {
  const pulls: Promise<unknown>[] = [];
  for (let i = 0; i < n; i++) {
    const uri = `of:concurrent-${i}-${crypto.randomUUID()}` as unknown as URI;
    pulls.push(provider.sync(uri, { path: [], schema: false }));
    // Wait until this pull's refresh has actually been sent before issuing the
    // next, so they are genuinely discovered a wave apart (not same-tick
    // coalesced). Under the single-flight guard the send blocks until release,
    // so bound the wait so the guarded run doesn't hang.
    await Promise.race([
      transport.sent(i + 1),
      new Promise((r) => setTimeout(r, 25)),
    ]);
  }
  return pulls;
}

Deno.test("single-flight by default: watch refreshes do NOT overlap", async () => {
  const { transport, storageManager, provider } = makeProvider(false);
  try {
    const pulls = drive(provider, transport, 4);
    // Give the guarded pipeline time to send whatever it will while held.
    await new Promise((r) => setTimeout(r, 60));
    assertEquals(transport.maxConcurrent, 1, "guard should serialize to 1");
    assertEquals(transport.watchAddCount, 1, "only the first refresh is sent");
    transport.releaseAll();
    // As each response lands the next flush drains; keep releasing.
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 10));
      transport.releaseAll();
    }
    await Promise.all(await pulls);
    assertEquals(transport.maxConcurrent, 1, "never more than 1 in flight");
  } finally {
    await storageManager.close();
  }
});

Deno.test("experimentalConcurrentWatchRefresh: refreshes overlap", async () => {
  const { transport, storageManager, provider } = makeProvider(true);
  try {
    const pulls = drive(provider, transport, 4);
    await new Promise((r) => setTimeout(r, 60));
    assert(
      transport.maxConcurrent >= 2,
      `expected overlapping refreshes, got maxConcurrent=${transport.maxConcurrent}`,
    );
    transport.releaseAll();
    await new Promise((r) => setTimeout(r, 20));
    transport.releaseAll();
    await Promise.all(await pulls);
    console.log(
      `[concurrent] watchAdds=${transport.watchAddCount} ` +
        `maxConcurrent=${transport.maxConcurrent} rootCounts=${transport.rootCounts}`,
    );
  } finally {
    await storageManager.close();
  }
});
