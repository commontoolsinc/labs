import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { parseLink } from "../src/link-utils.ts";
import {
  canonicalizeCfcMetadata,
  canonicalizePreparedDigestInput,
  canonicalizeWritePolicyInput,
  logicalPathToPointer,
} from "../src/cfc/mod.ts";

const signer = await Identity.fromPassphrase("runner-cfc-boundary-tests");

describe("CFC canonicalization helpers", () => {
  it("strips the value wrapper and sorts metadata entries canonically", () => {
    const metadata = canonicalizeCfcMetadata({
      version: 1,
      schemaHash: "abc",
      labelMap: {
        version: 1,
        entries: [
          { path: ["value", "b"], label: { classification: ["secret"] } },
          { path: ["value", "a"], label: { classification: ["confidential"] } },
        ],
      },
    });

    expect(metadata.labelMap.entries.map((entry) => entry.path)).toEqual([
      ["a"],
      ["b"],
    ]);
    expect(logicalPathToPointer(["value", "a"])).toBe("/a");
  });

  it("canonicalizes write-policy input deterministically", () => {
    const canonical = canonicalizeWritePolicyInput({
      kind: "structural-provenance",
      target: {
        space: signer.did(),
        id: "of:target",
        type: "application/json",
        path: ["value", "items"],
      },
      claim: "projection",
      sources: [
        {
          space: signer.did(),
          id: "of:b",
          type: "application/json",
          path: ["value", "items", "1"],
        },
        {
          space: signer.did(),
          id: "of:a",
          type: "application/json",
          path: ["value", "items", "0"],
        },
      ],
    });

    expect(canonical).toMatchObject({
      target: { path: ["items"] },
      sources: [{ id: "of:a", path: ["items", "0"] }, {
        id: "of:b",
        path: ["items", "1"],
      }],
    });
  });

  it("canonicalizes prepared digest input independently of insertion order", () => {
    const input = canonicalizePreparedDigestInput({
      consumedReads: [{
        space: signer.did(),
        id: "of:doc",
        type: "application/json",
        path: ["value", "z"],
      }, {
        space: signer.did(),
        id: "of:doc",
        type: "application/json",
        path: ["value", "a"],
      }],
      potentialWrites: [],
      writes: [],
      writePolicyInputs: [{
        kind: "custom",
        name: "b",
        value: 2,
      }, {
        kind: "custom",
        name: "a",
        value: 1,
      }],
    });

    expect(input.consumedReads.map((read) => read.path)).toEqual([
      ["a"],
      ["z"],
    ]);
    expect(
      input.writePolicyInputs.map((item) =>
        item.kind === "custom" ? item.name : ""
      ),
    ).toEqual(["a", "b"]);
  });
});

describe("ExtendedStorageTransaction CFC gate", () => {
  const createRuntime = () => {
    const storageManager = StorageManager.emulate({
      as: signer,
      memoryVersion: "v2",
    });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      memoryVersion: "v2",
    });
    return { runtime, storageManager };
  };

  it("rejects relevant unprepared commits in enforcing modes", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      tx.markCfcRelevant("test");
      tx.writeValueOrThrow({
        space: signer.did(),
        id: "of:cfc-enforce",
        type: "application/json",
        path: [],
      }, { ok: true });

      const result = await tx.commit();
      expect(result.error?.message).toContain(
        "relevant transaction was not prepared",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("allows observe-mode commits without blocking", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("observe");
      tx.markCfcRelevant("test");
      tx.writeValueOrThrow({
        space: signer.did(),
        id: "of:cfc-observe",
        type: "application/json",
        path: [],
      }, { ok: true });

      const result = await tx.commit();
      expect(result.ok).toBeDefined();
      expect(tx.getCfcState().prepare.status).toBe("prepared");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("invalidates prepared state on post-prepare policy changes", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      tx.markCfcRelevant("test");
      tx.writeValueOrThrow({
        space: signer.did(),
        id: "of:cfc-prepare",
        type: "application/json",
        path: [],
      }, { count: 1 });

      tx.prepareCfc();
      tx.recordCfcWritePolicyInput({
        kind: "custom",
        name: "schema",
        value: "x",
      });

      expect(tx.getCfcState().prepare.status).toBe("invalidated");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("commits a prepared relevant transaction when the digest is unchanged", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      tx.markCfcRelevant("test");
      tx.writeValueOrThrow({
        space: signer.did(),
        id: "of:cfc-prepared-success",
        type: "application/json",
        path: [],
      }, { count: 1 });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.ok).toBeDefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("invalidates prepared state on post-prepare reads and writes", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const readTx = runtime.edit();
      readTx.setCfcEnforcementMode("enforce-explicit");
      readTx.markCfcRelevant("test");
      readTx.writeValueOrThrow({
        space: signer.did(),
        id: "of:cfc-read-invalidate",
        type: "application/json",
        path: [],
      }, { count: 1 });
      readTx.prepareCfc();
      readTx.readValueOrThrow({
        space: signer.did(),
        id: "of:cfc-read-invalidate",
        type: "application/json",
        path: [],
      });
      expect(readTx.getCfcState().prepare.status).toBe("invalidated");

      const writeTx = runtime.edit();
      writeTx.setCfcEnforcementMode("enforce-explicit");
      writeTx.markCfcRelevant("test");
      writeTx.writeValueOrThrow({
        space: signer.did(),
        id: "of:cfc-write-invalidate",
        type: "application/json",
        path: [],
      }, { count: 1 });
      writeTx.prepareCfc();
      writeTx.writeValueOrThrow({
        space: signer.did(),
        id: "of:cfc-write-invalidate",
        type: "application/json",
        path: [],
      }, { count: 2 });
      expect(writeTx.getCfcState().prepare.status).toBe("invalidated");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("flushes outbox effects only after successful commit", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const flushed: string[] = [];
      const tx = runtime.edit();
      tx.enqueuePostCommitEffect({
        id: "effect-1",
        kind: "test",
        flush() {
          flushed.push("effect-1");
        },
      });
      tx.writeValueOrThrow({
        space: signer.did(),
        id: "of:cfc-outbox",
        type: "application/json",
        path: [],
      }, { ok: true });

      const result = await tx.commit();
      expect(result.ok).toBeDefined();
      expect(flushed).toEqual(["effect-1"]);

      const rejected = runtime.edit();
      rejected.setCfcEnforcementMode("enforce-explicit");
      rejected.markCfcRelevant("test");
      rejected.enqueuePostCommitEffect({
        id: "effect-2",
        kind: "test",
        flush() {
          flushed.push("effect-2");
        },
      });
      rejected.writeValueOrThrow({
        space: signer.did(),
        id: "of:cfc-outbox-reject",
        type: "application/json",
        path: [],
      }, { ok: false });

      const rejectedResult = await rejected.commit();
      expect(rejectedResult.error).toBeDefined();
      expect(flushed).toEqual(["effect-1"]);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("clears outbox state on abort", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      tx.enqueuePostCommitEffect({
        id: "effect-abort",
        kind: "test",
        flush() {
          throw new Error("should not flush");
        },
      });
      tx.abort("test");
      expect(tx.getCfcState().outbox).toEqual([]);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("marks labeled reads as CFC-relevant and leaves unlabeled reads alone", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const labeledTx = runtime.edit();
      const labeledCell = runtime.getCell(
        signer.did(),
        "cfc-read-labeled",
        { type: "string", ifc: { classification: ["secret"] } },
        labeledTx,
      );
      labeledCell.get();
      expect(labeledTx.getCfcState().relevant).toBe(true);

      const plainTx = runtime.edit();
      const plainCell = runtime.getCell(
        signer.did(),
        "cfc-read-plain",
        { type: "string" },
        plainTx,
      );
      plainCell.get();
      expect(plainTx.getCfcState().relevant).toBe(false);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("marks labeled writes as CFC-relevant", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      const cell = runtime.getCell(
        signer.did(),
        "cfc-write-labeled",
        { type: "string", ifc: { classification: ["secret"] } },
        tx,
      );
      cell.set("value");
      expect(tx.getCfcState().relevant).toBe(true);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("persists cfc metadata and canonical schema documents for prepared writes", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      const cell = runtime.getCell(
        signer.did(),
        "cfc-persisted-write",
        {
          type: "object",
          properties: {
            secret: {
              type: "string",
              ifc: { classification: ["secret"], integrity: ["trusted"] },
            },
          },
        },
        tx,
      );
      cell.set({ secret: "hello" });
      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.ok).toBeDefined();
      const persistedId = parseLink(cell.getAsLink()).id!;

      const replica = storageManager.open(signer.did()).replica as unknown as {
        getDocument(id: string): {
          value?: unknown;
          cfc?: { schemaHash: string; labelMap?: { entries: unknown[] } };
        } | undefined;
      };
      const persisted = replica.getDocument(persistedId);
      expect(persisted?.value).toEqual({ secret: "hello" });
      expect(persisted?.cfc?.schemaHash).toBeDefined();
      expect(persisted?.cfc?.labelMap?.entries.length).toBeGreaterThan(0);

      const schemaDoc = replica.getDocument(
        `cid:${persisted!.cfc!.schemaHash}`,
      );
      expect(schemaDoc?.value).toBeDefined();

      const readTx = runtime.edit();
      const readCell = runtime.getCell(
        signer.did(),
        "cfc-persisted-write",
        {
          type: "object",
          properties: {
            secret: {
              type: "string",
              ifc: { classification: ["secret"], integrity: ["trusted"] },
            },
          },
        },
        readTx,
      );
      expect(readCell.get()).toEqual({ secret: "hello" });
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("merges canonical schema envelopes monotonically across writes", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const firstTx = runtime.edit();
      firstTx.setCfcEnforcementMode("enforce-explicit");
      const firstCell = runtime.getCell(
        signer.did(),
        "cfc-schema-merge",
        {
          type: "object",
          properties: {
            secret: {
              type: "string",
              ifc: { classification: ["secret"] },
            },
          },
          required: ["secret"],
        },
        firstTx,
      );
      firstCell.set({ secret: "hello" });
      firstTx.prepareCfc();
      const firstResult = await firstTx.commit();
      expect(firstResult.ok).toBeDefined();

      const replica = storageManager.open(signer.did()).replica as unknown as {
        getDocument(id: string): {
          value?: unknown;
          cfc?: { schemaHash: string };
        } | undefined;
      };
      const persistedId = parseLink(firstCell.getAsLink()).id!;
      const before = replica.getDocument(persistedId);
      expect(before?.cfc?.schemaHash).toBeDefined();

      const secondTx = runtime.edit();
      secondTx.setCfcEnforcementMode("enforce-explicit");
      const secondCell = runtime.getCell(
        signer.did(),
        "cfc-schema-merge",
        {
          type: "object",
          properties: {
            secret: {
              type: "string",
              ifc: { classification: ["secret"] },
            },
            title: {
              type: "string",
              default: "",
            },
          },
          required: ["secret", "title"],
        },
        secondTx,
      );
      secondCell.set({ secret: "hello", title: "updated" });
      secondTx.prepareCfc();
      const secondResult = await secondTx.commit();
      expect(secondResult.ok).toBeDefined();

      const after = replica.getDocument(persistedId);
      expect(after?.cfc?.schemaHash).toBeDefined();
      expect(after?.cfc?.schemaHash).not.toEqual(before?.cfc?.schemaHash);

      const schemaDoc = replica.getDocument(`cid:${after!.cfc!.schemaHash}`);
      expect(schemaDoc?.value).toMatchObject({
        type: "object",
        required: ["secret", "title"],
      });
      expect(
        (schemaDoc?.value as { properties?: { title?: unknown } }).properties
          ?.title,
      )
        .toMatchObject({
          type: "string",
          default: "",
        });
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("reloads stored schema envelopes after a fresh runtime restart", async () => {
    const storageManager = StorageManager.emulate({
      as: signer,
      memoryVersion: "v2",
    });
    const runtime1 = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      memoryVersion: "v2",
    });
    try {
      const firstTx = runtime1.edit();
      firstTx.setCfcEnforcementMode("enforce-explicit");
      const firstCell = runtime1.getCell(
        signer.did(),
        "cfc-schema-restart",
        {
          type: "object",
          properties: {
            secret: {
              type: "string",
              ifc: { classification: ["secret"] },
            },
          },
          required: ["secret"],
        },
        firstTx,
      );
      firstCell.set({ secret: "hello" });
      firstTx.prepareCfc();
      const firstResult = await firstTx.commit();
      expect(firstResult.ok).toBeDefined();

      const persistedId = parseLink(firstCell.getAsLink()).id!;
      await runtime1.dispose();

      const runtime2 = new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager,
        memoryVersion: "v2",
      });
      try {
        const secondTx = runtime2.edit();
        secondTx.setCfcEnforcementMode("enforce-explicit");
        const secondCell = runtime2.getCell(
          signer.did(),
          "cfc-schema-restart",
          {
            type: "object",
            properties: {
              secret: {
                type: "string",
                ifc: { classification: ["secret"] },
              },
              title: {
                type: "string",
                default: "",
              },
            },
            required: ["secret", "title"],
          },
          secondTx,
        );
        secondCell.set({ secret: "hello", title: "restarted" });
        secondTx.prepareCfc();
        const secondResult = await secondTx.commit();
        expect(secondResult.ok).toBeDefined();

        const replica = storageManager.open(signer.did())
          .replica as unknown as {
            getDocument(id: string): {
              value?: unknown;
              cfc?: { schemaHash: string };
            } | undefined;
          };
        const persisted = replica.getDocument(persistedId);
        const schemaDoc = replica.getDocument(
          `cid:${persisted!.cfc!.schemaHash}`,
        );
        expect(schemaDoc?.value).toMatchObject({
          type: "object",
          required: ["secret", "title"],
        });
      } finally {
        await runtime2.dispose();
      }
    } finally {
      await storageManager.close();
    }
  });

  it("rejects later writes when stored schemaHash documents are missing", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const seed = runtime.edit();
      const seededId = parseLink(
        runtime.getCell(
          signer.did(),
          "cfc-missing-schema-doc",
          {
            type: "object",
            properties: {
              secret: { type: "string" },
            },
          },
        ).getAsLink(),
      ).id!;
      seed.writeOrThrow({
        space: signer.did(),
        id: seededId,
        type: "application/json",
        path: [],
      }, {
        value: { secret: "seed" },
        cfc: {
          version: 1,
          schemaHash: "missing-hash",
          labelMap: {
            version: 1,
            entries: [{
              path: ["secret"],
              label: { classification: ["secret"] },
            }],
          },
        },
      });
      const seedResult = await seed.commit();
      expect(seedResult.ok).toBeDefined();

      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      const cell = runtime.getCell(
        signer.did(),
        "cfc-missing-schema-doc",
        {
          type: "object",
          properties: {
            secret: {
              type: "string",
              ifc: { classification: ["secret"] },
            },
          },
          required: ["secret"],
        },
        tx,
      );
      cell.set({ secret: "updated" });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error?.message).toContain("missing or unreadable");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects writes when requiredIntegrity is not satisfied by consumed input labels", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const seed = runtime.edit();
      const sourceId = parseLink(
        runtime.getCell(
          signer.did(),
          "cfc-input",
          {
            type: "object",
            properties: {
              secret: { type: "string" },
            },
          },
        ).getAsLink(),
      ).id!;
      seed.writeOrThrow({
        space: signer.did(),
        id: sourceId,
        type: "application/json",
        path: [],
      }, {
        value: { secret: "seed" },
        cfc: {
          version: 1,
          schemaHash: "seed-schema",
          labelMap: {
            version: 1,
            entries: [{
              path: ["secret"],
              label: { integrity: ["untrusted"] },
            }],
          },
        },
      });
      const seedResult = await seed.commit();
      expect(seedResult.ok).toBeDefined();

      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      const source = runtime.getCell(
        signer.did(),
        "cfc-input",
        {
          type: "object",
          properties: {
            secret: { type: "string" },
          },
        },
        tx,
      );
      expect(source.get()).toEqual({ secret: "seed" });
      tx.markCfcRelevant("stored-input-metadata");

      const output = runtime.getCell(
        signer.did(),
        "cfc-output",
        {
          type: "object",
          properties: {
            value: {
              type: "string",
              ifc: { requiredIntegrity: ["trusted"] },
            },
          },
        },
        tx,
      );
      output.set({ value: "result" });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error?.message).toContain("requiredIntegrity");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
