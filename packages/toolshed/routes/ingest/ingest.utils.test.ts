import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { type MemorySpace, Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import {
  appendToJournal,
  generateIngestSecret,
  getRegistration,
  type IngestRegistration,
  isValidPartition,
  journalCell,
  saveRegistration,
  verifyIngestSecret,
} from "./ingest.utils.ts";

// The journal sink is the security-critical write path (durable, marked, into a
// caller-provided space). These exercise it directly against an emulated store
// (no ACL layer — see the cross-space test's caveat).
describe("ingest journal sink", () => {
  let signer: Identity;
  let space: ReturnType<Identity["did"]>;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(async () => {
    signer = await Identity.fromPassphrase("ingest-test");
    space = signer.did();
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://ingest-test.invalid"),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  const ingestMarks = (docSpace: string, id: string): unknown[] => {
    const replica = storageManager.open(docSpace as MemorySpace)
      .replica as unknown as {
        getDocument(id: string): {
          cfc?: {
            labelMap?: {
              entries: { origin?: string; label: { integrity?: unknown[] } }[];
            };
          };
        } | undefined;
      };
    return (replica.getDocument(id)?.cfc?.labelMap?.entries ?? [])
      .filter((e) => e.origin === "external-ingest")
      .flatMap((e) => e.label.integrity ?? []);
  };
  const markType = (atom: unknown) => (atom as { type?: string })?.type;

  const reg = (
    overrides: Partial<IngestRegistration> = {},
  ): IngestRegistration => ({
    id: "ing_test",
    name: "test",
    space,
    causePrefix: "location",
    installId: "install-1",
    secretHash: "unused",
    createdBy: space,
    createdAt: "2026-07-01T00:00:00.000Z",
    enabled: true,
    ...overrides,
  });

  it("durably appends records to a partition cell and mints the mark", async () => {
    const r = reg();
    await appendToJournal(runtime, r, "2026-07-01", [
      { point_id: "a", ts: 1 },
      { point_id: "b", ts: 2 },
    ]);

    const cell = journalCell(runtime, r, "2026-07-01");
    await cell.sync();
    expect(cell.get()).toEqual([{ point_id: "a", ts: 1 }, {
      point_id: "b",
      ts: 2,
    }]);

    const marks = ingestMarks(space, cell.getAsNormalizedFullLink().id);
    expect(marks.length).toBe(1);
    expect(markType(marks[0])).toBe(CFC_ATOM_TYPE.ExternalIngest);
    expect(marks[0]).toMatchObject({ channel: space, audience: "install-1" });
  });

  it("stores records byte-identical — no labs-added fields, strings kept", async () => {
    const r = reg();
    // lat/lng as exact decimal strings: labs must not reparse to float (loom's
    // versionId parity depends on the wire bytes).
    const point = {
      point_id: "p1",
      ts: 123,
      lat: "37.123456",
      lng: "-122.654321",
      accuracy_m: 5,
      extra: { nested: true },
    };
    await appendToJournal(runtime, r, "2026-07-02", [point]);

    const cell = journalCell(runtime, r, "2026-07-02");
    await cell.sync();
    expect(cell.get()).toEqual([point]);
  });

  it("a never-written partition cell reads back ABSENT (undefined), not []", async () => {
    // The load-bearing tri-state invariant: absent (never captured) must be
    // distinguishable from empty. The schema must not inject a [] default.
    const cell = journalCell(runtime, reg(), "1999-01-01");
    await cell.sync();
    expect(cell.get()).toBeUndefined();
  });

  it("distinct partitions land in distinct cells", async () => {
    const r = reg();
    await appendToJournal(runtime, r, "2026-07-01", [{ point_id: "a" }]);
    await appendToJournal(runtime, r, "2026-07-02", [{ point_id: "b" }]);

    const c1 = journalCell(runtime, r, "2026-07-01");
    const c2 = journalCell(runtime, r, "2026-07-02");
    await c1.sync();
    await c2.sync();

    expect(c1.get()).toEqual([{ point_id: "a" }]);
    expect(c2.get()).toEqual([{ point_id: "b" }]);
    expect(c1.getAsNormalizedFullLink().id).not.toBe(
      c2.getAsNormalizedFullLink().id,
    );
  });

  it("writes into a DIFFERENT principal's space and marks it", async () => {
    // Mechanism proof: the operator runtime targets the registered (foreign)
    // space and mints there. CAVEAT: emulate has NO ACL layer, so this does NOT
    // prove a production memory server AUTHORIZES the cross-space commit — that
    // is the deploy-time probe (MEMORY_ACL_MODE), not a unit test.
    const other = await Identity.fromPassphrase("some-other-user");
    const otherSpace = other.did();
    const r = reg({ space: otherSpace, installId: "install-2" });

    await appendToJournal(runtime, r, "2026-07-01", [{ point_id: "z" }]);

    const cell = journalCell(runtime, r, "2026-07-01");
    await cell.sync();
    expect(cell.get()).toEqual([{ point_id: "z" }]);

    const marks = ingestMarks(otherSpace, cell.getAsNormalizedFullLink().id);
    expect(marks.length).toBe(1);
    expect(marks[0]).toMatchObject({
      channel: otherSpace,
      audience: "install-2",
    });
  });

  it("concurrent appends to the same partition don't lose each other", async () => {
    const r = reg();
    await Promise.all([
      appendToJournal(runtime, r, "2026-07-03", [{ point_id: "a" }]),
      appendToJournal(runtime, r, "2026-07-03", [{ point_id: "b" }]),
      appendToJournal(runtime, r, "2026-07-03", [{ point_id: "c" }]),
    ]);

    const cell = journalCell(runtime, r, "2026-07-03");
    await cell.sync();
    const ids = (cell.get() as { point_id: string }[]).map((p) => p.point_id)
      .sort();
    expect(ids).toEqual(["a", "b", "c"]);
  });

  it("validates the partition segment", () => {
    expect(isValidPartition("2026-07-01")).toBe(true);
    expect(isValidPartition("v1.2_beta-3")).toBe(true);
    for (const bad of ["a/b", "", "x".repeat(65), "a b", "foo\tbar", "💥"]) {
      expect(isValidPartition(bad)).toBe(false);
    }
  });

  it("verifies bearer secrets in constant time", async () => {
    const { secret, hashPromise } = generateIngestSecret();
    const hash = await hashPromise;
    expect(await verifyIngestSecret(secret, hash)).toBe(true);
    expect(await verifyIngestSecret("ingsec_wrong", hash)).toBe(false);
    expect(await verifyIngestSecret(secret, "0".repeat(64))).toBe(false);
  });

  it("round-trips a registration in the service space", async () => {
    const r = reg({ id: "ing_rt", secretHash: "abc123" });
    await saveRegistration(runtime, space, r);
    expect(await getRegistration(runtime, space, "ing_rt")).toEqual(r);
    expect(await getRegistration(runtime, space, "ing_missing")).toBeNull();
  });
});
