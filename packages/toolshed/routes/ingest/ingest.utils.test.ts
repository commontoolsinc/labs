import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { type MemorySpace, Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import {
  appendToJournal,
  channelId,
  generateIngestSecret,
  getLastSeen,
  getRegistration,
  getRegistrationIndex,
  type IngestRegistration,
  isValidPartition,
  journalCell,
  MAX_BATCH,
  processIngest,
  saveRegistration,
  verifyIngestSecret,
} from "./ingest.utils.ts";

// Golden cell id for cause "location/2026-07-01" — pins the cross-repo cell
// address so a fabric hash-format change fails CI loudly (loom recomputes it).
const GOLDEN_ID = "of:fid1:d7_RmD4fNpTUheithVm0Q1Vha0Rn32c06qA_hOHE8x8";

// Golden channel id — rotate-in-place is a security property, so pin the exact
// derivation: a drift means "rotation" mints a NEW registration and leaves the
// old token live. A failure = coordinate a change, never just update the literal.
const GOLDEN_CHANNEL_ID = "ing_jMjaGfRO0Kg0BUegs9mzwImZ-CKcmlVw-wDbmV41_bs";

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
    sink: "journal",
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

  it("verifies bearer secrets in constant time", () => {
    const { secret, secretHash } = generateIngestSecret();
    expect(verifyIngestSecret(secret, secretHash)).toBe(true);
    expect(verifyIngestSecret("ingsec_wrong", secretHash)).toBe(false);
    expect(verifyIngestSecret(secret, "A".repeat(secretHash.length))).toBe(
      false,
    );
  });

  it("channelId is deterministic per (space, installId) — re-provisioning rotates in place", () => {
    const a = channelId("did:key:space1", "install-1");
    expect(channelId("did:key:space1", "install-1")).toBe(a);
    expect(channelId("did:key:space1", "install-2")).not.toBe(a);
    expect(channelId("did:key:space2", "install-1")).not.toBe(a);
    expect(a.startsWith("ing_")).toBe(true);
    // Pinned derivation (see GOLDEN_CHANNEL_ID).
    expect(a).toBe(GOLDEN_CHANNEL_ID);
  });

  it("round-trips a registration in the service space", async () => {
    const r = reg({ id: "ing_rt", secretHash: "abc123" });
    await saveRegistration(runtime, space, r);
    expect(await getRegistration(runtime, space, "ing_rt")).toEqual(r);
    expect(await getRegistration(runtime, space, "ing_missing")).toBeNull();
  });

  it("day-cell id is a stable function of the cause (cross-repo golden id)", async () => {
    // loom READS by recomputing this exact id from the cause string. If the
    // fabric hash format changes, this literal breaks CI loudly instead of
    // silently orphaning loom's reader.
    const cell = journalCell(runtime, reg(), "2026-07-01");
    await cell.sync();
    expect(cell.getAsNormalizedFullLink().id).toBe(GOLDEN_ID);
  });

  // --- processIngest: the full auth + validation contract ---
  const savedReg = async (
    overrides: Partial<IngestRegistration> = {},
  ): Promise<{ r: IngestRegistration; secret: string }> => {
    const { secret, secretHash } = generateIngestSecret();
    const r = reg({ id: "ing_auth", secretHash, ...overrides });
    await saveRegistration(runtime, space, r);
    return { r, secret };
  };

  it("processIngest: unknown / disabled / wrong-token all -> identical 401", async () => {
    const { r } = await savedReg({ id: "ing_ok" });
    await saveRegistration(
      runtime,
      space,
      reg({ id: "ing_off", secretHash: "unused", enabled: false }),
    );

    const unknown = await processIngest(runtime, space, "ing_unknown", "t", {
      partition: "2026-07-01",
      records: [{ x: 1 }],
    });
    const disabled = await processIngest(runtime, space, "ing_off", "t", {
      partition: "2026-07-01",
      records: [{ x: 1 }],
    });
    const wrong = await processIngest(runtime, space, "ing_ok", "ingsec_nope", {
      partition: "2026-07-01",
      records: [{ x: 1 }],
    });

    for (const res of [unknown, disabled, wrong]) {
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: "Invalid request" });
    }
    // A wrong token wrote nothing.
    const cell = journalCell(runtime, r, "2026-07-01");
    await cell.sync();
    expect(cell.get()).toBeUndefined();
  });

  it("processIngest: storage lookup error -> 502 (not 401)", async () => {
    const broken = {
      getCell() {
        throw new Error("boom");
      },
    } as unknown as Runtime;
    const res = await processIngest(broken, space, "ing_x", "t", {
      partition: "d",
      records: [{ x: 1 }],
    });
    expect(res.status).toBe(502);
  });

  it("processIngest: valid token -> 200 and durably appends", async () => {
    const { r, secret } = await savedReg({ id: "ing_write" });
    const res = await processIngest(runtime, space, "ing_write", secret, {
      partition: "2026-07-05",
      records: [{ point_id: "a" }, { point_id: "b" }],
    });
    expect(res).toEqual({ status: 200, body: { received: 2, appended: 2 } });
    const cell = journalCell(runtime, r, "2026-07-05");
    await cell.sync();
    expect(cell.get()).toEqual([{ point_id: "a" }, { point_id: "b" }]);
  });

  it("processIngest: hostile / missing partition -> 400, no write", async () => {
    const { secret } = await savedReg({ id: "ing_part" });
    for (const bad of ["../x", "", "a/b", "..", "."]) {
      const res = await processIngest(runtime, space, "ing_part", secret, {
        partition: bad,
        records: [{ x: 1 }],
      });
      expect(res.status).toBe(400);
    }
    const missing = await processIngest(runtime, space, "ing_part", secret, {
      records: [{ x: 1 }],
    });
    expect(missing.status).toBe(400);
  });

  it("processIngest: bad records shape -> 400", async () => {
    const { secret } = await savedReg({ id: "ing_rec" });
    const bodies: unknown[] = [
      { partition: "d", records: [] },
      { partition: "d", records: "nope" },
      { partition: "d", records: [1, 2] },
      { partition: "d", records: [null] },
      { partition: "d", records: [["nested"]] },
      { partition: "d" },
    ];
    for (const body of bodies) {
      const res = await processIngest(runtime, space, "ing_rec", secret, body);
      expect(res.status).toBe(400);
    }
  });

  it("processIngest: over-cap batch -> 413", async () => {
    const { secret } = await savedReg({ id: "ing_cap" });
    const records = Array.from({ length: MAX_BATCH + 1 }, (_, i) => ({ i }));
    const res = await processIngest(runtime, space, "ing_cap", secret, {
      partition: "2026-07-06",
      records,
    });
    expect(res.status).toBe(413);
  });

  it("processIngest: wrong-sink channel -> identical 401, no write", async () => {
    const { secret, r } = await savedReg({ id: "ing_stream" });
    // Force a non-journal sink at rest (a future stream channel).
    await saveRegistration(runtime, space, {
      ...r,
      sink: "stream",
    } as unknown as IngestRegistration);
    const res = await processIngest(runtime, space, "ing_stream", secret, {
      partition: "2026-07-01",
      records: [{ x: 1 }],
    });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Invalid request" });
    const cell = journalCell(runtime, r, "2026-07-01");
    await cell.sync();
    expect(cell.get()).toBeUndefined();
  });

  it("saveRegistration indexes ids exactly once", async () => {
    await saveRegistration(runtime, space, reg({ id: "ing_i1" }));
    await saveRegistration(runtime, space, reg({ id: "ing_i2" }));
    await saveRegistration(runtime, space, reg({ id: "ing_i1" })); // re-provision
    const idx = await getRegistrationIndex(runtime, space);
    expect(idx.filter((x) => x === "ing_i1").length).toBe(1);
    expect(idx).toContain("ing_i1");
    expect(idx).toContain("ing_i2");
  });

  it("last-seen bumps on successful ingest, unchanged on auth failure", async () => {
    const { secret } = await savedReg({ id: "ing_seen" });
    expect(await getLastSeen(runtime, space, "ing_seen")).toBeNull();

    const ok = await processIngest(runtime, space, "ing_seen", secret, {
      partition: "2026-07-07",
      records: [{ x: 1 }],
    });
    expect(ok.status).toBe(200);
    const seen = await getLastSeen(runtime, space, "ing_seen");
    expect(seen).not.toBeNull();
    expect(Number.isNaN(Date.parse(seen as string))).toBe(false);

    // A wrong token must not touch last-seen.
    await processIngest(runtime, space, "ing_seen", "ingsec_wrong", {
      partition: "2026-07-07",
      records: [{ x: 1 }],
    });
    expect(await getLastSeen(runtime, space, "ing_seen")).toBe(seen);
  });
});
