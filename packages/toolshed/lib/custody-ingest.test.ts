import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import {
  custodyIngest,
  durableSet,
  durableUpdate,
  type VouchedChannel,
} from "./custody-ingest.ts";

const channel: VouchedChannel = {
  channel: "did:key:test-channel",
  audience: "did:key:test-presenter",
};

type StoredEntry = {
  path: string[];
  label: { integrity?: unknown[] };
  origin?: string;
};

// custodyIngest is the one durable-write path for a vouched ingest channel: a
// governed write that mints the ExternalIngest mark by construction. These
// tests run a default runtime (enforce-explicit, flow off) — the posture
// toolshed itself inherits by passing no CFC options.
describe("custodyIngest", () => {
  let signer: Identity;
  let space: ReturnType<Identity["did"]>;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(async () => {
    signer = await Identity.fromPassphrase("custody-ingest-test");
    space = signer.did();
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://custody-test.invalid"),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  const ingestMarks = (id: string): unknown[] => {
    const replica = storageManager.open(space).replica as unknown as {
      getDocument(id: string): {
        cfc?: { labelMap?: { entries: StoredEntry[] } };
      } | undefined;
    };
    return (replica.getDocument(id)?.cfc?.labelMap?.entries ?? [])
      .filter((e) => e.origin === "external-ingest")
      .flatMap((e) => e.label.integrity ?? []);
  };

  const markType = (atom: unknown) => (atom as { type?: string })?.type;

  it("durably appends and mints the ExternalIngest mark", async () => {
    const cell = runtime.getCell<{ at: string }[]>(space, "events");
    const id = cell.getAsNormalizedFullLink().id;

    await custodyIngest.append(cell, { at: "first" }, channel);
    await custodyIngest.append(cell, { at: "second" }, channel);

    // Durable append: the array accumulates both records.
    expect(cell.get()).toEqual([{ at: "first" }, { at: "second" }]);

    // Exactly one provenance mark on the doc, carrying the channel metadata.
    const marks = ingestMarks(id);
    expect(marks.length).toBe(1);
    expect(markType(marks[0])).toBe(CFC_ATOM_TYPE.ExternalIngest);
    expect(marks[0]).toMatchObject({
      channel: "did:key:test-channel",
      audience: "did:key:test-presenter",
    });
  });

  it("durably sets a value and mints the mark", async () => {
    const cell = runtime.getCell<{ token: string }>(space, "oauth-token");
    const id = cell.getAsNormalizedFullLink().id;

    await custodyIngest.set(cell, { token: "abc" }, channel);
    expect(cell.get()).toEqual({ token: "abc" });

    const marks = ingestMarks(id);
    expect(marks.length).toBe(1);
    expect(markType(marks[0])).toBe(CFC_ATOM_TYPE.ExternalIngest);
  });

  it("update read-modify-writes off the CURRENT value and mints the mark", async () => {
    const cell = runtime.getCell<{ items: number[] }>(space, "upsert-cell");
    const id = cell.getAsNormalizedFullLink().id;
    await custodyIngest.set(cell, { items: [1] }, channel);

    // The merge is driven by the value read inside the transaction, not a
    // stale snapshot passed in — this is the atomic read-modify-write.
    await custodyIngest.update(
      cell,
      (current) => ({ items: [...(current?.items ?? []), 2] }),
      channel,
    );
    expect(cell.get()).toEqual({ items: [1, 2] });

    // Re-mint replaced: still exactly one mark on the doc.
    const marks = ingestMarks(id);
    expect(marks.length).toBe(1);
    expect(markType(marks[0])).toBe(CFC_ATOM_TYPE.ExternalIngest);
  });

  it("durableUpdate read-modify-writes atomically WITHOUT a mark", async () => {
    const cell = runtime.getCell<{ items: number[] }>(space, "remove-cell");
    const id = cell.getAsNormalizedFullLink().id;

    await durableUpdate(cell, (current) => ({
      items: [...(current?.items ?? []), 7],
    }));
    await durableUpdate(cell, (current) => ({
      items: (current?.items ?? []).filter((n) => n !== 7),
    }));
    expect(cell.get()).toEqual({ items: [] });
    // Operator read-modify-writes are not ingest — no mark.
    expect(ingestMarks(id).length).toBe(0);
  });

  it("durableSet writes durably WITHOUT a provenance mark (non-ingest path)", async () => {
    const cell = runtime.getCell<{ tokens: null }>(space, "cleared-auth");
    const id = cell.getAsNormalizedFullLink().id;

    await durableSet(cell, { tokens: null });

    // The value is durably written, but it carries no ExternalIngest mark —
    // clearing/operator writes are not ingest.
    expect(cell.get()).toEqual({ tokens: null });
    expect(ingestMarks(id).length).toBe(0);
  });

  it("binds the mark digest to the appended element, and re-mint replaces", async () => {
    const cell = runtime.getCell<number[]>(space, "points");
    const id = cell.getAsNormalizedFullLink().id;

    await custodyIngest.append(cell, 1, channel);
    const first = ingestMarks(id) as { valueDigest: string }[];

    await custodyIngest.append(cell, 2, channel);
    const second = ingestMarks(id) as { valueDigest: string }[];

    // One mark at a time, and the digest tracks the latest element (different
    // payloads -> different digests), never accumulating the stale one.
    expect(first.length).toBe(1);
    expect(second.length).toBe(1);
    expect(second[0].valueDigest).not.toBe(first[0].valueDigest);
  });
});
