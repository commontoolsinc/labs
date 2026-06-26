import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { Signer } from "@commonfabric/memory/interface";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import {
  type Options,
  type SessionFactory,
  StorageManager,
} from "../src/storage/v2.ts";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";

// Resume preservation guard for the list builtins (filter/flatMap).
//
// On a reload the result container of a `filter` can already hold its durable
// non-empty value while the per-element predicate result cells are still
// streaming in from storage. While a predicate cell reads `undefined` (its
// value not yet arrived), the coordinator's reconcile treats the element as
// excluded and republishes a shrunk aggregate, overwriting the durable list
// with a partial/empty array — the user-visible reload flicker where a
// populated list blinks to empty and refills (e.g. the Lunch Poll vote swatches
// going 35 -> 0 -> refill). The correct behavior: do not let a per-element run
// whose result is still pending clobber a known durable aggregate; preserve the
// prior value until the children settle, then reconcile normally (so a child
// that genuinely settles falsy/undefined is still excluded — convergence, not
// freeze).
//
// The window is timing-dependent, so this test forces it deterministically: a
// loopback transport delays delivery of the per-element predicate documents
// (boolean-valued) relative to everything else, modeling a real reload where the
// per-element results rehydrate after the aggregate container has loaded. The
// container's `kept` entries are `{ keep, label }` objects, so the boolean
// predicate documents are cleanly separable from the container document. The
// test asserts that the `kept` list is never observed as empty or a strict
// shrink during the resume window.

const signer = await Identity.fromPassphrase("list resume preserve");
const space = signer.did();

// Per-element result docs are separated from the aggregate container by the
// schema type their query carries. A `filter` predicate result is a boolean and
// its sync carries `"type":"boolean"`; a `flatMap` op result here is a number
// (the container's own query carries no scalar item type, only `asCell` slots),
// so the two builtins pass distinct matchers below.
const FILTER_CHILD_DOC = /"type":"boolean"/;
const FLATMAP_CHILD_DOC = /"type":"number"/;

function delayingLoopback(
  server: MemoryV2Server.Server,
  childDelayMs: number,
  childDoc: RegExp,
  onDelay: () => void,
): MemoryV2Client.Transport {
  const inner = MemoryV2Client.loopback(server);
  return {
    send: (p: string) => inner.send(p),
    close: () => inner.close(),
    setReceiver: (r: (p: string) => void) => {
      inner.setReceiver((payload: string) => {
        if (childDelayMs > 0 && childDoc.test(payload)) {
          onDelay();
          setTimeout(() => r(payload), childDelayMs);
        } else {
          r(payload);
        }
      });
    },
    setCloseReceiver: (r: (e?: Error) => void) => inner.setCloseReceiver?.(r),
  };
}

class DelayingSessionFactory implements SessionFactory {
  constructor(
    private readonly getServer: () => MemoryV2Server.Server,
    private readonly childDelayMs: number,
    private readonly childDoc: RegExp,
    private readonly onDelay: () => void,
  ) {}
  async create(spaceId: string, sgnr?: Signer) {
    const client = await MemoryV2Client.connect({
      transport: delayingLoopback(
        this.getServer(),
        this.childDelayMs,
        this.childDoc,
        this.onDelay,
      ),
    });
    const session = await client.mount(spaceId, {}, () => ({
      invocation: {},
      authorization: { principal: sgnr?.did() },
    }));
    return { client, session };
  }
}

class DelayingStorageManager extends StorageManager {
  static make(
    as: Identity,
    server: MemoryV2Server.Server,
    childDelayMs: number,
    childDoc: RegExp,
    onDelay: () => void = () => {},
  ): DelayingStorageManager {
    return new DelayingStorageManager(
      { as, memoryHost: new URL("memory://") } as Options,
      server,
      childDelayMs,
      childDoc,
      onDelay,
    );
  }
  private constructor(
    options: Options,
    server: MemoryV2Server.Server,
    childDelayMs: number,
    childDoc: RegExp,
    onDelay: () => void,
  ) {
    super(
      options,
      new DelayingSessionFactory(
        () => server,
        childDelayMs,
        childDoc,
        onDelay,
      ),
    );
  }
  override registerSpaceHost(): boolean {
    return false;
  }
}

const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { pattern } from 'commonfabric';",
      "export default pattern<{ items: { keep: boolean; label: string }[] }>(({ items }) => {",
      "  return { kept: items.filter((item) => item.keep) };",
      "});",
    ].join("\n"),
  }],
};

const ITEMS = [
  { keep: true, label: "a" },
  { keep: true, label: "b" },
  { keep: false, label: "c" },
  { keep: true, label: "d" },
  { keep: true, label: "e" },
  { keep: false, label: "f" },
  { keep: true, label: "g" },
  { keep: true, label: "h" },
];
const EXPECTED = ["a", "b", "d", "e", "g", "h"];

const labelsOf = (v: unknown): string[] | null =>
  Array.isArray(v)
    ? (v as { label?: string }[]).map((x) => x?.label as string)
    : v == null
    ? null
    : ["<non-array>"];

describe("list builtin resume preservation", () => {
  let server: MemoryV2Server.Server;
  let sm1: DelayingStorageManager;
  let sm2: DelayingStorageManager;
  let delayed: number;

  beforeEach(() => {
    delayed = 0;
    server = new MemoryV2Server.Server({
      authorizeSessionOpen(message) {
        const principal = (message.authorization as { principal?: unknown })
          ?.principal;
        return typeof principal === "string" ? principal : undefined;
      },
    });
    sm1 = DelayingStorageManager.make(signer, server, 0, FILTER_CHILD_DOC);
    sm2 = DelayingStorageManager.make(
      signer,
      server,
      80,
      FILTER_CHILD_DOC,
      () => delayed++,
    );
  });
  afterEach(async () => {
    await sm1?.close();
    await sm2?.close();
    await server?.close();
  });

  it("preserves a durable filter result while per-element children resync", async () => {
    // CREATE (runtime A): build the durable, non-empty filtered list.
    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: sm1,
    });
    const compiled1 = await rt1.patternManager.compilePattern(PROGRAM, {
      space,
    });
    const tx0 = rt1.edit();
    const rc1 = rt1.getCell<{ kept: { label: string }[] }>(
      space,
      "lr-result",
      compiled1.resultSchema,
      tx0,
    );
    const h1 = rt1.run(tx0, compiled1, { items: ITEMS }, rc1);
    await tx0.commit();
    for (let k = 0; k < 10; k++) {
      await h1.pull();
      await rt1.idle();
    }
    await rt1.patternManager.flushCompileCacheWrites();
    await sm1.synced();
    expect(
      (rc1.key("kept").getAsQueryResult() ?? []).map((x: { label: string }) =>
        x.label
      ),
    ).toEqual(EXPECTED);
    rt1.scheduler.dispose();

    // RELOAD (runtime B): cold cache, with per-element predicate documents
    // delivered late so the container loads before the children.
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: sm2,
    });
    const trajectory: (string[] | null)[] = [];
    try {
      await rt2.patternManager.compilePattern(PROGRAM, { space });
      const tx = rt2.edit();
      const rc2 = rt2.getCell<{ kept: { label: string }[] }>(
        space,
        "lr-result",
        compiled1.resultSchema,
        tx,
      );
      await tx.commit();

      const cancel = rc2.key("kept").sink((v) => {
        trajectory.push(labelsOf(v));
      });

      const started = await rt2.start(rc2);
      expect(started).toBe(true);

      for (let k = 0; k < 24; k++) {
        await rc2.pull();
        await rt2.idle();
        trajectory.push(labelsOf(rc2.key("kept").get()));
      }
      cancel();

      // Self-check: the harness only exercises the bug if it actually deferred
      // some per-element documents. If the storage payload shape changes so the
      // matcher no longer fires, fail loudly rather than pass vacuously.
      expect(delayed).toBeGreaterThan(0);

      const finalLabels = (rc2.key("kept").getAsQueryResult() ?? []).map(
        (x: { label: string }) => x.label,
      );
      // Converges to the durable value.
      expect(finalLabels).toEqual(EXPECTED);

      // Never transiently emptied or shrunk during the resume window. On
      // failure the offending values (the empty/partial snapshots) are shown;
      // the full trajectory is logged for context.
      const shrank = trajectory.filter(
        (t) => t !== null && t.length > 0 && t.length < EXPECTED.length,
      );
      const empties = trajectory.filter((t) => t !== null && t.length === 0);
      if (shrank.length > 0 || empties.length > 0) {
        console.log("kept trajectory:", JSON.stringify(trajectory));
      }
      expect(empties).toEqual([]);
      expect(shrank).toEqual([]);
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });
});

// The flatMap mirror. The op result is a number, so each per-element result
// doc's sync carries `"type":"number"`, which the aggregate container's own
// slot-link query does not — that is the matcher the reload uses to deliver the
// per-element results late. Each element carries a distinct `n` so the skip test
// can assert exactly which element is omitted; the per-test self-check on the
// delayed count guards against the matcher drifting if the payload shape moves.
const FLATMAP_ITEMS = [
  { keep: true, n: 1, label: "a" },
  { keep: true, n: 2, label: "b" },
  { keep: false, n: 3, label: "c" },
  { keep: true, n: 4, label: "d" },
  { keep: true, n: 5, label: "e" },
  { keep: false, n: 6, label: "f" },
  { keep: true, n: 7, label: "g" },
  { keep: true, n: 8, label: "h" },
];

const FLATMAP_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { pattern } from 'commonfabric';",
      "export default pattern<{ items: { keep: boolean; n: number; label: string }[] }>(({ items }) => {",
      "  return { values: items.flatMap((item) => item.n) };",
      "});",
    ].join("\n"),
  }],
};
const FLATMAP_EXPECTED = [1, 2, 3, 4, 5, 6, 7, 8];

// As above but the op returns undefined for non-`keep` elements, which flatMap
// treats as a skip. The aggregate omits exactly those elements, and must do so
// by convergence (settled undefined is honored) rather than by ever republishing
// a transient shrink while the kept elements' results are still resyncing.
const FLATMAP_SKIP_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { pattern } from 'commonfabric';",
      "export default pattern<{ items: { keep: boolean; n: number; label: string }[] }>(({ items }) => {",
      "  return { values: items.flatMap((item) => item.keep ? item.n : undefined) };",
      "});",
    ].join("\n"),
  }],
};
const FLATMAP_SKIP_EXPECTED = [1, 2, 4, 5, 7, 8]; // omits 3 and 6 (non-keep)

const numbersOf = (v: unknown): number[] | null =>
  Array.isArray(v) ? (v as number[]) : v == null ? null : [NaN];

describe("flatMap builtin resume preservation", () => {
  let server: MemoryV2Server.Server;
  let sm1: DelayingStorageManager;
  let sm2: DelayingStorageManager;
  let delayed: number;

  beforeEach(() => {
    delayed = 0;
    server = new MemoryV2Server.Server({
      authorizeSessionOpen(message) {
        const principal = (message.authorization as { principal?: unknown })
          ?.principal;
        return typeof principal === "string" ? principal : undefined;
      },
    });
    sm1 = DelayingStorageManager.make(signer, server, 0, FLATMAP_CHILD_DOC);
    sm2 = DelayingStorageManager.make(
      signer,
      server,
      80,
      FLATMAP_CHILD_DOC,
      () => delayed++,
    );
  });
  afterEach(async () => {
    await sm1?.close();
    await sm2?.close();
    await server?.close();
  });

  async function runFlatMapResume(
    program: RuntimeProgram,
    items: typeof FLATMAP_ITEMS,
    expected: number[],
  ): Promise<void> {
    // CREATE (runtime A): build the durable, non-empty flattened list.
    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: sm1,
    });
    const compiled1 = await rt1.patternManager.compilePattern(program, {
      space,
    });
    const tx0 = rt1.edit();
    const rc1 = rt1.getCell<{ values: number[] }>(
      space,
      "fm-result",
      compiled1.resultSchema,
      tx0,
    );
    const h1 = rt1.run(tx0, compiled1, { items }, rc1);
    await tx0.commit();
    for (let k = 0; k < 10; k++) {
      await h1.pull();
      await rt1.idle();
    }
    await rt1.patternManager.flushCompileCacheWrites();
    await sm1.synced();
    expect(rc1.key("values").getAsQueryResult() ?? []).toEqual(expected);
    rt1.scheduler.dispose();

    // RELOAD (runtime B): cold cache, per-element result docs delivered late so
    // the container loads before the children.
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: sm2,
    });
    const trajectory: (number[] | null)[] = [];
    try {
      await rt2.patternManager.compilePattern(program, { space });
      const tx = rt2.edit();
      const rc2 = rt2.getCell<{ values: number[] }>(
        space,
        "fm-result",
        compiled1.resultSchema,
        tx,
      );
      await tx.commit();

      const cancel = rc2.key("values").sink((v) => {
        trajectory.push(numbersOf(v));
      });

      const started = await rt2.start(rc2);
      expect(started).toBe(true);

      for (let k = 0; k < 24; k++) {
        await rc2.pull();
        await rt2.idle();
        trajectory.push(numbersOf(rc2.key("values").get()));
      }
      cancel();

      // Self-check: fail loudly if the matcher stopped firing, rather than pass
      // vacuously.
      expect(delayed).toBeGreaterThan(0);

      const finalValues = rc2.key("values").getAsQueryResult() ?? [];
      // Converges to the durable value.
      expect(finalValues).toEqual(expected);

      // Never transiently emptied or shrunk during the resume window.
      const shrank = trajectory.filter(
        (t) => t !== null && t.length > 0 && t.length < expected.length,
      );
      const empties = trajectory.filter((t) => t !== null && t.length === 0);
      if (shrank.length > 0 || empties.length > 0) {
        console.log("values trajectory:", JSON.stringify(trajectory));
      }
      expect(empties).toEqual([]);
      expect(shrank).toEqual([]);
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  }

  it("preserves a durable flatMap result while per-element children resync", async () => {
    await runFlatMapResume(FLATMAP_PROGRAM, FLATMAP_ITEMS, FLATMAP_EXPECTED);
  });

  it("skips a flatMap element that settles undefined without dropping the list", async () => {
    await runFlatMapResume(
      FLATMAP_SKIP_PROGRAM,
      FLATMAP_ITEMS,
      FLATMAP_SKIP_EXPECTED,
    );
  });
});
