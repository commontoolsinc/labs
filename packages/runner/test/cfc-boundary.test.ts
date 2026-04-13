import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { StorageManager } from "../src/storage/cache.deno.ts";
import * as V2Storage from "../src/storage/v2.ts";
import { raw } from "../src/module.ts";
import { storedCfcMetadataAppliesToPath } from "../src/cfc/metadata.ts";
import { Runtime } from "../src/runtime.ts";
import { parseLink } from "../src/link-utils.ts";
import {
  canonicalizeCfcMetadata,
  canonicalizePreparedDigestInput,
  canonicalizeWritePolicyInput,
  logicalPathToPointer,
} from "../src/cfc/mod.ts";
import { CFC_STRUCTURAL_PROVENANCE_SETUP_PROJECTION } from "../src/cfc/types.ts";
import type { JSONSchema, Pattern } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("runner-cfc-boundary-tests");

class SharedV2SessionFactory implements V2Storage.SessionFactory {
  constructor(private readonly server: MemoryV2Server.Server) {}

  async create(space: MemorySpace) {
    const client = await MemoryV2Client.connect({
      transport: MemoryV2Client.loopback(this.server),
    });
    const session = await client.mount(space);
    return { client, session };
  }
}

class SharedV2StorageManager extends V2Storage.StorageManager {
  constructor(options: V2Storage.Options, server: MemoryV2Server.Server) {
    super(options, new SharedV2SessionFactory(server));
  }
}

describe("CFC canonicalization helpers", () => {
  it("strips the value wrapper and sorts metadata entries canonically", () => {
    const metadata = canonicalizeCfcMetadata({
      version: 1,
      schemaHash: "abc",
      labelMap: {
        version: 1,
        entries: [
          { path: ["value", "b"], label: { confidentiality: ["secret"] } },
          {
            path: ["value", "a"],
            label: { confidentiality: ["confidential"] },
          },
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

  it("allows setup to install alias-backed CFC result projections", async () => {
    const storageManager = StorageManager.emulate({
      as: signer,
      memoryVersion: "v2",
    });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      memoryVersion: "v2",
      cfcEnforcementMode: "enforce-explicit",
      trustSnapshotProvider: () => ({
        id: "trust-snapshot-setup",
        actingPrincipal: signer.did(),
      }),
    });
    try {
      const resultSchema = {
        type: "object",
        properties: {
          savedTitle: {
            type: "string",
            ifc: {
              writeAuthorizedBy: {
                __ctWriterIdentityOf: {
                  file: "/main.tsx",
                  path: ["commitTrustedSaveTitle"],
                },
              },
            },
          },
        },
        required: ["savedTitle"],
      } as const satisfies JSONSchema;
      const pattern = {
        argumentSchema: { type: "object", properties: {} } as const,
        resultSchema,
        initial: {
          internal: {
            savedTitle: "",
          },
        },
        result: {
          savedTitle: { $alias: { path: ["internal", "savedTitle"] } },
        },
        nodes: [],
      } satisfies Pattern;
      const resultCell = runtime.getCell(
        signer.did(),
        "cfc-setup-projection",
        resultSchema,
      );

      await runtime.setup(undefined, pattern, {}, resultCell);

      expect(resultCell.getSourceCell()).toBeDefined();
      expect((resultCell.getRaw() as any)?.savedTitle?.$alias?.path).toEqual([
        "internal",
        "savedTitle",
      ]);

      const replica = storageManager.open(signer.did()).replica as unknown as {
        getDocument(id: string): {
          cfc?: {
            labelMap?: {
              entries: Array<{
                path: string[];
                label: Record<string, unknown>;
              }>;
            };
          };
        } | undefined;
      };
      const persisted = replica.getDocument(
        parseLink(resultCell.getAsLink()).id!,
      );
      expect(persisted?.cfc?.labelMap?.entries).toContainEqual({
        path: ["savedTitle"],
        label: {},
      });
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("allows setup to install alias-backed CFC projections when the result cell is initially untyped", async () => {
    const storageManager = StorageManager.emulate({
      as: signer,
      memoryVersion: "v2",
    });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      memoryVersion: "v2",
      cfcEnforcementMode: "enforce-explicit",
      trustSnapshotProvider: () => ({
        id: "trust-snapshot-setup-untyped",
        actingPrincipal: signer.did(),
      }),
    });
    try {
      const resultSchema = {
        type: "object",
        properties: {
          savedTitle: {
            type: "string",
            ifc: {
              writeAuthorizedBy: {
                __ctWriterIdentityOf: {
                  file: "/main.tsx",
                  path: ["commitTrustedSaveTitle"],
                },
              },
            },
          },
        },
        required: ["savedTitle"],
      } as const satisfies JSONSchema;
      const pattern = {
        argumentSchema: { type: "object", properties: {} } as const,
        resultSchema,
        initial: {
          internal: {
            savedTitle: "",
          },
        },
        result: {
          savedTitle: { $alias: { path: ["internal", "savedTitle"] } },
        },
        nodes: [],
      } satisfies Pattern;
      const resultCell = runtime.getCell(
        signer.did(),
        "cfc-setup-projection-untyped",
        undefined,
      );

      await runtime.setup(undefined, pattern, {}, resultCell);

      expect(resultCell.getSourceCell()).toBeDefined();
      expect((resultCell.getRaw() as any)?.savedTitle?.$alias?.path).toEqual([
        "internal",
        "savedTitle",
      ]);

      const replica = storageManager.open(signer.did()).replica as unknown as {
        getDocument(id: string): {
          cfc?: {
            labelMap?: {
              entries: Array<{
                path: string[];
                label: Record<string, unknown>;
              }>;
            };
          };
        } | undefined;
      };
      const persisted = replica.getDocument(
        parseLink(resultCell.getAsLink()).id!,
      );
      expect(persisted?.cfc?.labelMap?.entries).toContainEqual({
        path: ["savedTitle"],
        label: {},
      });
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects setup constants for writeAuthorizedBy CFC outputs", async () => {
    const storageManager = StorageManager.emulate({
      as: signer,
      memoryVersion: "v2",
    });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      memoryVersion: "v2",
      cfcEnforcementMode: "enforce-explicit",
      trustSnapshotProvider: () => ({
        id: "trust-snapshot-setup",
        actingPrincipal: signer.did(),
      }),
    });
    try {
      const resultSchema = {
        type: "object",
        properties: {
          savedTitle: {
            type: "string",
            ifc: {
              writeAuthorizedBy: {
                __ctWriterIdentityOf: {
                  file: "/main.tsx",
                  path: ["commitTrustedSaveTitle"],
                },
              },
            },
          },
        },
        required: ["savedTitle"],
      } as const satisfies JSONSchema;
      const pattern = {
        argumentSchema: { type: "object", properties: {} } as const,
        resultSchema,
        result: {
          savedTitle: "not user authorized",
        },
        nodes: [],
      } satisfies Pattern;
      const resultCell = runtime.getCell(
        signer.did(),
        "cfc-setup-constant",
        resultSchema,
      );

      await expect(runtime.setup(undefined, pattern, {}, resultCell)).rejects
        .toThrow("CFC enforcement rejected commit");
      expect(resultCell.getSourceCell()).toBeUndefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects forged setup projection provenance for writeAuthorizedBy constants", async () => {
    const storageManager = StorageManager.emulate({
      as: signer,
      memoryVersion: "v2",
    });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      memoryVersion: "v2",
      cfcEnforcementMode: "enforce-explicit",
      trustSnapshotProvider: () => ({
        id: "trust-snapshot-setup-forged-projection",
        actingPrincipal: signer.did(),
      }),
    });
    try {
      const tx = runtime.edit();
      const schema = {
        type: "object",
        properties: {
          savedTitle: {
            type: "string",
            ifc: {
              writeAuthorizedBy: {
                __ctWriterIdentityOf: {
                  file: "/main.tsx",
                  path: ["commitTrustedSaveTitle"],
                },
              },
            },
          },
        },
        required: ["savedTitle"],
      } as const satisfies JSONSchema;
      const cell = runtime.getCell(
        signer.did(),
        "cfc-setup-forged-projection",
        schema,
        tx,
      );
      cell.set({ savedTitle: "not user authorized" });
      const target = cell.getAsNormalizedFullLink();
      tx.recordCfcWritePolicyInput({
        kind: "structural-provenance",
        claim: CFC_STRUCTURAL_PROVENANCE_SETUP_PROJECTION,
        target: {
          space: target.space,
          id: target.id,
          type: target.type,
          path: ["savedTitle"],
        },
        sources: [{
          space: signer.did(),
          id: "of:source",
          type: "application/json",
          path: ["internal", "savedTitle"],
        }],
      });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error?.message).toContain(
        "writeAuthorizedBy requires a trusted verified binding identity",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("does not let setup projection provenance bypass uiContract requirements", async () => {
    const storageManager = StorageManager.emulate({
      as: signer,
      memoryVersion: "v2",
    });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      memoryVersion: "v2",
      cfcEnforcementMode: "enforce-explicit",
    });
    try {
      const tx = runtime.edit();
      const schema = {
        type: "string",
        ifc: {
          uiContract: {
            helper: "UiAction",
            action: "TrustedSave",
          },
        },
      } as const satisfies JSONSchema;
      const cell = runtime.getCell(
        signer.did(),
        "cfc-setup-ui-contract-bypass",
        schema,
        tx,
      );
      cell.set("saved");
      const target = cell.getAsNormalizedFullLink();
      tx.recordCfcWritePolicyInput({
        kind: "structural-provenance",
        claim: CFC_STRUCTURAL_PROVENANCE_SETUP_PROJECTION,
        target: {
          space: target.space,
          id: target.id,
          type: target.type,
          path: [],
        },
        sources: [{
          space: signer.did(),
          id: "of:source",
          type: "application/json",
          path: ["internal", "saved"],
        }],
      });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error?.message).toContain(
        "missing trusted-event policy input",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

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

  it("does not trigger CFC prepare for read-only inspection transactions", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const seed = runtime.edit();
      const cell = runtime.getCell(
        signer.did(),
        "cfc-read-only-inspection",
        {
          type: "object",
          properties: {
            secret: {
              type: "string",
              ifc: { confidentiality: ["secret"] },
            },
          },
          required: ["secret"],
        },
        seed,
      );
      cell.set({ secret: "seed" });
      expect((await seed.commit()).ok).toBeDefined();

      const tx = runtime.readTx();
      const readCell = runtime.getCell(
        signer.did(),
        "cfc-read-only-inspection",
        {
          type: "object",
          properties: {
            secret: {
              type: "string",
              ifc: { confidentiality: ["secret"] },
            },
          },
          required: ["secret"],
        },
        tx,
      );
      expect(readCell.get()).toEqual({ secret: "seed" });

      const result = await tx.commit();
      expect(result.ok).toBeDefined();
      expect(tx.getCfcState().prepare.status).toBe("unprepared");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("allows relevant unprepared commits when enforcement is disabled", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("disabled");
      tx.markCfcRelevant("test");
      tx.writeValueOrThrow({
        space: signer.did(),
        id: "of:cfc-disabled",
        type: "application/json",
        path: [],
      }, { ok: true });

      const result = await tx.commit();
      expect(result.ok).toBeDefined();
      expect(tx.getCfcState().prepare.status).toBe("unprepared");
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

  it("rejects relevant unprepared commits in enforce-strict mode", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-strict");
      tx.markCfcRelevant("test");
      tx.writeValueOrThrow({
        space: signer.did(),
        id: "of:cfc-enforce-strict",
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

  it("invalidates prepared state when the trust snapshot changes", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      const cell = runtime.getCell(
        signer.did(),
        "cfc-trust-snapshot",
        {
          type: "object",
          properties: {
            secret: {
              type: "string",
              ifc: { confidentiality: ["secret"] },
            },
          },
          required: ["secret"],
        },
        tx,
      );
      cell.set({ secret: "value" });

      tx.setCfcTrustSnapshot({
        id: "snapshot-a",
        actingPrincipal: signer.did(),
      });
      tx.prepareCfc();
      tx.setCfcTrustSnapshot({
        id: "snapshot-b",
        actingPrincipal: signer.did(),
      });

      expect(tx.getCfcState().prepare.status).toBe("invalidated");
      const result = await tx.commit();
      expect(result.error?.message).toContain(
        "relevant transaction was not prepared",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("invalidates prepared state when the implementation identity changes", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      const cell = runtime.getCell(
        signer.did(),
        "cfc-implementation-identity",
        {
          type: "object",
          properties: {
            secret: {
              type: "string",
              ifc: { confidentiality: ["secret"] },
            },
          },
          required: ["secret"],
        },
        tx,
      );
      cell.set({ secret: "value" });

      tx.setCfcImplementationIdentity({
        kind: "builtin",
        builtinId: "builtin:a",
      });
      tx.prepareCfc();
      tx.setCfcImplementationIdentity({
        kind: "builtin",
        builtinId: "builtin:b",
      });

      expect(tx.getCfcState().prepare.status).toBe("invalidated");
      const result = await tx.commit();
      expect(result.error?.message).toContain(
        "relevant transaction was not prepared",
      );
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
      const cell = runtime.getCell(
        signer.did(),
        "cfc-prepared-success",
        {
          type: "object",
          properties: {
            count: {
              type: "number",
              ifc: { confidentiality: ["secret"] },
            },
          },
          required: ["count"],
        },
        tx,
      );
      cell.set({ count: 1 });

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
        { type: "string", ifc: { confidentiality: ["secret"] } },
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

  it("keeps unlabeled writes permissive in phase 1 even after a relevant read", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const seed = runtime.edit();
      const sourceId = parseLink(
        runtime.getCell(
          signer.did(),
          "cfc-unlabeled-permissive-source",
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
              label: { confidentiality: ["secret"] },
            }],
          },
        },
      });
      expect((await seed.commit()).ok).toBeDefined();

      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      const source = runtime.getCell(
        signer.did(),
        "cfc-unlabeled-permissive-source",
        {
          type: "object",
          properties: {
            secret: { type: "string" },
          },
        },
        tx,
      );
      expect(source.get()).toEqual({ secret: "seed" });
      expect(tx.getCfcState().relevant).toBe(true);

      const output = runtime.getCell(
        signer.did(),
        "cfc-unlabeled-permissive-target",
        {
          type: "object",
          properties: {
            value: { type: "string" },
          },
        },
        tx,
      );
      output.set({ value: "result" });

      tx.prepareCfc();
      expect((await tx.commit()).ok).toBeDefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("marks reads as CFC-relevant when stored metadata labels the consumed path", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const seededId = parseLink(
        runtime.getCell(
          signer.did(),
          "cfc-stored-read",
          {
            type: "object",
            properties: {
              secret: { type: "string" },
            },
          },
        ).getAsLink(),
      ).id!;

      const seed = runtime.edit();
      seed.writeOrThrow({
        space: signer.did(),
        id: seededId,
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
              label: { confidentiality: ["secret"] },
            }],
          },
        },
      });
      const seedResult = await seed.commit();
      expect(seedResult.ok).toBeDefined();

      const tx = runtime.edit();
      const cell = runtime.getCell(
        signer.did(),
        "cfc-stored-read",
        {
          type: "object",
          properties: {
            secret: { type: "string" },
          },
        },
        tx,
      );
      expect(cell.key("secret").get()).toEqual("seed");
      expect(tx.getCfcState().relevant).toBe(true);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("keeps source-cell traversal reads internal and out of consumed inputs", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const seed = runtime.edit();
      const targetId = "of:cfc-internal-source-traversal-target";
      seed.writeOrThrow(
        {
          space: signer.did(),
          id: targetId,
          type: "application/json",
          path: [],
        },
        {
          value: { source: "seed" },
        },
      );
      seed.writeOrThrow(
        {
          space: signer.did(),
          id: targetId,
          type: "application/json",
          path: ["cfc"],
        },
        {
          version: 1,
          schemaHash: "seed-schema",
          labelMap: {
            version: 1,
            entries: [{
              path: ["source"],
              label: { confidentiality: ["secret"] },
            }],
          },
        },
      );
      const seedResult = await seed.commit();
      expect(seedResult.ok).toBeDefined();

      const metadataTx = runtime.edit();
      const targetLink = {
        space: signer.did(),
        id: targetId,
        type: "application/json",
        path: [],
      } as const;
      expect(
        storedCfcMetadataAppliesToPath(metadataTx, targetLink),
      ).toBe(true);
      expect(
        storedCfcMetadataAppliesToPath(metadataTx, {
          ...targetLink,
          path: ["source"],
        }),
      ).toBe(true);

      const readActivities = [...(metadataTx as unknown as {
        getReadActivities(): Iterable<{ meta?: unknown }>;
      }).getReadActivities()];
      expect(readActivities).toContainEqual(
        expect.objectContaining({
          path: [],
        }),
      );

      const digestInput = (
        metadataTx as unknown as {
          buildPreparedDigestInput(): { consumedReads: unknown[] };
        }
      ).buildPreparedDigestInput();
      expect(digestInput.consumedReads).toEqual([]);
      expect(metadataTx.getCfcState().relevant).toBe(false);

      const result = await metadataTx.commit();
      expect(result.ok).toBeDefined();
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
        { type: "string", ifc: { confidentiality: ["secret"] } },
        tx,
      );
      cell.set("value");
      expect(tx.getCfcState().relevant).toBe(true);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("marks writes as CFC-relevant when stored metadata labels the target path", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const seededId = parseLink(
        runtime.getCell(
          signer.did(),
          "cfc-stored-write",
          {
            type: "object",
            properties: {
              secret: { type: "string" },
            },
          },
        ).getAsLink(),
      ).id!;

      const seed = runtime.edit();
      seed.writeOrThrow({
        space: signer.did(),
        id: seededId,
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
              label: { confidentiality: ["secret"] },
            }],
          },
        },
      });
      const seedResult = await seed.commit();
      expect(seedResult.ok).toBeDefined();

      const tx = runtime.edit();
      const cell = runtime.getCell(
        signer.did(),
        "cfc-stored-write",
        {
          type: "object",
          properties: {
            secret: { type: "string" },
          },
        },
        tx,
      );
      cell.key("secret").set("updated");
      expect(tx.getCfcState().relevant).toBe(true);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("keeps no-op attempted targets in potentialWrites for labeled paths", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const seed = runtime.edit();
      seed.setCfcEnforcementMode("enforce-explicit");
      const seededCell = runtime.getCell(
        signer.did(),
        "cfc-noop-potential-write",
        {
          type: "object",
          properties: {
            secret: {
              type: "string",
              ifc: { confidentiality: ["secret"] },
            },
          },
          required: ["secret"],
        },
        seed,
      );
      seededCell.set({ secret: "same" });
      seed.prepareCfc();
      const seedResult = await seed.commit();
      expect(seedResult.ok).toBeDefined();
      const seededId = parseLink(seededCell.getAsLink()).id!;

      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      const cell = runtime.getCell(
        signer.did(),
        "cfc-noop-potential-write",
        {
          type: "object",
          properties: {
            secret: {
              type: "string",
              ifc: { confidentiality: ["secret"] },
            },
          },
          required: ["secret"],
        },
        tx,
      );
      cell.key("secret").set("same");
      expect(tx.getCfcState().relevant).toBe(true);

      const digestInput = (
        tx as unknown as {
          buildPreparedDigestInput(): {
            potentialWrites: Array<{
              space: string;
              id: string;
              type: string;
              path: string[];
            }>;
            writes: Array<unknown>;
          };
        }
      ).buildPreparedDigestInput();
      expect(digestInput.potentialWrites).toContainEqual({
        space: signer.did(),
        id: seededId,
        type: "application/json",
        path: ["secret"],
      });
      expect(digestInput.writes).toEqual([]);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("evaluates target-side policy for no-op attempted writes", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const seed = runtime.edit();
      seed.setCfcEnforcementMode("enforce-explicit");
      const seededCell = runtime.getCell(
        signer.did(),
        "cfc-noop-policy-target",
        {
          type: "object",
          properties: {
            value: {
              type: "string",
              ifc: { confidentiality: ["secret"] },
            },
          },
          required: ["value"],
        },
        seed,
      );
      seededCell.set({ value: "same" });
      seed.prepareCfc();
      expect((await seed.commit()).ok).toBeDefined();

      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      const cell = runtime.getCell(
        signer.did(),
        "cfc-noop-policy-target",
        {
          type: "object",
          properties: {
            value: {
              type: "string",
              ifc: { writeAuthorizedBy: ["trusted-handler"] },
            },
          },
          required: ["value"],
        },
        tx,
      );
      cell.set({ value: "same" });
      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error?.message).toContain(
        "writeAuthorizedBy requires a trusted builtin identity",
      );
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
              ifc: { confidentiality: ["secret"], integrity: ["trusted"] },
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
      expect(persisted?.cfc?.labelMap?.entries).toContainEqual({
        path: ["secret"],
        label: {
          confidentiality: ["secret"],
          integrity: ["trusted"],
        },
      });

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
              ifc: { confidentiality: ["secret"], integrity: ["trusted"] },
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

  it("keeps derived read labels out of persisted label metadata", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const seed = runtime.edit();
      seed.writeOrThrow({
        space: signer.did(),
        id: "of:cfc-derived-label-source",
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
              label: { confidentiality: ["secret"] },
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
        "cfc-derived-label-source",
        {
          type: "object",
          properties: {
            secret: {
              type: "string",
              ifc: { confidentiality: ["secret"] },
            },
          },
          required: ["secret"],
        },
        tx,
      );
      source.get();

      const output = runtime.getCell(
        signer.did(),
        "cfc-derived-label-output",
        {
          type: "string",
          ifc: { confidentiality: ["public"] },
        },
        tx,
      );
      output.set("visible");

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.ok).toBeDefined();

      const persistedId = parseLink(output.getAsLink()).id!;
      const replica = storageManager.open(signer.did()).replica as unknown as {
        getDocument(id: string): {
          cfc?: {
            labelMap?: {
              entries: Array<{
                path: string[];
                label: {
                  confidentiality?: string[];
                  integrity?: string[];
                };
              }>;
            };
          };
        } | undefined;
      };
      const persisted = replica.getDocument(persistedId);
      expect(persisted?.cfc?.labelMap?.entries).toContainEqual({
        path: [],
        label: {
          confidentiality: ["public"],
        },
      });
      expect(persisted?.cfc?.labelMap?.entries).not.toContainEqual({
        path: [],
        label: {
          confidentiality: ["public", "secret"],
        },
      });
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
              ifc: { confidentiality: ["secret"] },
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
              ifc: { confidentiality: ["secret"] },
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
              ifc: { confidentiality: ["secret"] },
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
                ifc: { confidentiality: ["secret"] },
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

  it("syncs cfc schema documents into separate v2 runtime caches", async () => {
    const server = new MemoryV2Server.Server();
    const createStorageManager = () =>
      new SharedV2StorageManager({
        as: signer,
        address: new URL("memory://"),
        memoryVersion: "v2",
      }, server);
    const storageManager1 = createStorageManager();
    const runtime1 = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager: storageManager1,
      memoryVersion: "v2",
    });
    const cellSchema = {
      type: "object",
      properties: {
        secret: {
          type: "string",
          ifc: { confidentiality: ["secret"] },
        },
      },
      required: ["secret"],
    } as const satisfies JSONSchema;
    try {
      const firstTx = runtime1.edit();
      firstTx.setCfcEnforcementMode("enforce-explicit");
      const firstCell = runtime1.getCell(
        signer.did(),
        "cfc-schema-remote-sync",
        cellSchema,
        firstTx,
      );
      firstCell.set({ secret: "hello" });
      firstTx.prepareCfc();
      const firstResult = await firstTx.commit();
      expect(firstResult.ok).toBeDefined();
      await storageManager1.synced();
    } finally {
      await runtime1.dispose();
      await storageManager1.close();
    }

    const storageManager2 = createStorageManager();
    const runtime2 = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager: storageManager2,
      memoryVersion: "v2",
    });
    try {
      const secondSchema = {
        type: "object",
        properties: {
          secret: {
            type: "string",
            ifc: { confidentiality: ["secret"] },
          },
          title: { type: "string", default: "" },
        },
        required: ["secret", "title"],
      } as const satisfies JSONSchema;
      const secondCell = runtime2.getCell(
        signer.did(),
        "cfc-schema-remote-sync",
        secondSchema,
      );
      await secondCell.sync();

      const secondTx = runtime2.edit();
      secondTx.setCfcEnforcementMode("enforce-explicit");
      secondCell.withTx(secondTx).set({ secret: "hello", title: "synced" });
      secondTx.prepareCfc();
      const secondResult = await secondTx.commit();
      expect(secondResult.error).toBeUndefined();
      expect(secondResult.ok).toBeDefined();
    } finally {
      await runtime2.dispose();
      await storageManager2.close();
      await server.close();
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
              label: { confidentiality: ["secret"] },
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
              ifc: { confidentiality: ["secret"] },
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

  it("treats unrelated consumed reads as influencing every target path in phase 1", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const seed = runtime.edit();
      const trustedSourceId = parseLink(
        runtime.getCell(
          signer.did(),
          "cfc-phase1-trusted-source",
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
        id: trustedSourceId,
        type: "application/json",
        path: [],
      }, {
        value: { secret: "trusted" },
        cfc: {
          version: 1,
          schemaHash: "trusted-schema",
          labelMap: {
            version: 1,
            entries: [{
              path: ["secret"],
              label: { integrity: ["trusted"] },
            }],
          },
        },
      });
      const untrustedSourceId = parseLink(
        runtime.getCell(
          signer.did(),
          "cfc-phase1-unrelated-source",
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
        id: untrustedSourceId,
        type: "application/json",
        path: [],
      }, {
        value: { secret: "untrusted" },
        cfc: {
          version: 1,
          schemaHash: "untrusted-schema",
          labelMap: {
            version: 1,
            entries: [{
              path: ["secret"],
              label: { integrity: ["untrusted"] },
            }],
          },
        },
      });
      expect((await seed.commit()).ok).toBeDefined();

      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      const trustedSource = runtime.getCell(
        signer.did(),
        "cfc-phase1-trusted-source",
        {
          type: "object",
          properties: {
            secret: { type: "string" },
          },
        },
        tx,
      );
      const unrelatedSource = runtime.getCell(
        signer.did(),
        "cfc-phase1-unrelated-source",
        {
          type: "object",
          properties: {
            secret: { type: "string" },
          },
        },
        tx,
      );
      expect(trustedSource.get()).toEqual({ secret: "trusted" });
      expect(unrelatedSource.get()).toEqual({ secret: "untrusted" });
      tx.markCfcRelevant("stored-input-metadata");

      const output = runtime.getCell(
        signer.did(),
        "cfc-phase1-target",
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

  it("rejects writes when maxConfidentiality is not satisfied by consumed input labels", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const seed = runtime.edit();
      const sourceId = parseLink(
        runtime.getCell(
          signer.did(),
          "cfc-max-conf-input",
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
              label: { confidentiality: ["secret"] },
            }],
          },
        },
      });
      expect((await seed.commit()).ok).toBeDefined();

      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      const source = runtime.getCell(
        signer.did(),
        "cfc-max-conf-input",
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
        "cfc-max-conf-output",
        {
          type: "object",
          properties: {
            value: {
              type: "string",
              ifc: { maxConfidentiality: ["internal"] },
            },
          },
          required: ["value"],
        },
        tx,
      );
      output.set({ value: "result" });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error?.message).toContain("maxConfidentiality");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("does not let helper source-cell reads affect the prepared digest", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const setupTx = runtime.edit();
      setupTx.setCfcEnforcementMode("enforce-explicit");
      const sourceCell = runtime.getCell(
        signer.did(),
        "internal-verifier-source",
        {
          type: "object",
          properties: {
            foo: { type: "number" },
          },
        },
        setupTx,
      );
      sourceCell.set({ foo: 1 });

      const targetCell = runtime.getCell(
        signer.did(),
        "internal-verifier-target",
        {
          type: "object",
          properties: {
            bar: {
              type: "string",
              ifc: { confidentiality: ["secret"] },
            },
          },
          required: ["bar"],
        },
        setupTx,
      );
      targetCell.set({ bar: "seed" });
      targetCell.setSourceCell(sourceCell);
      setupTx.prepareCfc();
      expect((await setupTx.commit()).ok).toBeDefined();

      const tx1 = runtime.edit();
      tx1.setCfcEnforcementMode("enforce-explicit");
      const plainTarget1 = runtime.getCell(
        signer.did(),
        "internal-verifier-target",
        {
          type: "object",
          properties: {
            bar: {
              type: "string",
              ifc: { confidentiality: ["secret"] },
            },
          },
          required: ["bar"],
        },
        tx1,
      );
      plainTarget1.set({ bar: "updated" });
      tx1.prepareCfc();
      const prepared1 = tx1.getCfcState().prepare;
      const digest1 = prepared1.status === "prepared"
        ? prepared1.digest
        : undefined;

      const tx2 = runtime.edit();
      tx2.setCfcEnforcementMode("enforce-explicit");
      const plainTarget2 = runtime.getCell(
        signer.did(),
        "internal-verifier-target",
        {
          type: "object",
          properties: {
            bar: {
              type: "string",
              ifc: { confidentiality: ["secret"] },
            },
          },
          required: ["bar"],
        },
        tx2,
      );
      expect(plainTarget2.getSourceCell()).toBeDefined();
      plainTarget2.set({ bar: "updated" });
      tx2.prepareCfc();
      const prepared2 = tx2.getCfcState().prepare;
      const digest2 = prepared2.status === "prepared"
        ? prepared2.digest
        : undefined;

      expect(digest1).toBeDefined();
      expect(digest2).toBeDefined();
      expect(digest2).toBe(digest1);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("persists only concrete evidence and addIntegrity in output metadata", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const seed = runtime.edit();
      const sourceId = parseLink(
        runtime.getCell(
          signer.did(),
          "cfc-propagation-input",
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
              label: {
                confidentiality: ["secret"],
                integrity: ["source-integrity"],
              },
            }],
          },
        },
      });
      expect((await seed.commit()).ok).toBeDefined();

      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      const source = runtime.getCell(
        signer.did(),
        "cfc-propagation-input",
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
        "cfc-propagation-output",
        {
          type: "object",
          properties: {
            value: {
              type: "string",
              ifc: {
                integrity: ["target-integrity"],
                addIntegrity: ["derived-integrity"],
              },
            },
          },
          required: ["value"],
        },
        tx,
      );
      output.set({ value: "result" });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.ok).toBeDefined();

      const replica = storageManager.open(signer.did()).replica as unknown as {
        getDocument(id: string): {
          cfc?: {
            labelMap?: {
              entries: Array<{
                path: string[];
                label: {
                  confidentiality?: string[];
                  integrity?: string[];
                };
              }>;
            };
          };
        } | undefined;
      };
      const persisted = replica.getDocument(parseLink(output.getAsLink()).id!);
      expect(persisted?.cfc?.labelMap?.entries).toContainEqual({
        path: ["value"],
        label: {
          integrity: [
            "target-integrity",
            "derived-integrity",
          ],
        },
      });
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("keeps unrelated direct writes without schema policy inputs out of CFC prepare", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      tx.markCfcRelevant("direct-write-without-schema-input");
      tx.writeValueOrThrow({
        space: signer.did(),
        id: "of:cfc-missing-schema-input",
        type: "application/json",
        path: [],
      }, { secret: "value" });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.ok).toBeDefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("keeps untyped pattern result writes without CFC labels permissive", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const pattern = {
        argumentSchema: { type: "object", properties: {} } as const,
        resultSchema: undefined,
        result: { title: "Untyped" },
        nodes: [],
      } as unknown as Pattern;
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      tx.markCfcRelevant("untyped-pattern-result");

      const resultCell = runtime.getCell(
        signer.did(),
        "cfc-untyped-pattern-result",
        undefined,
        tx,
      );
      runtime.run(tx, pattern, {}, resultCell);

      runtime.prepareTxForCommit(tx);
      const result = await tx.commit();
      expect(result.ok).toBeDefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("fails closed on writeAuthorizedBy without a trusted implementation identity", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");

      const cell = runtime.getCell(
        signer.did(),
        "cfc-unsupported-trust-claim",
        {
          type: "object",
          properties: {
            value: {
              type: "string",
              ifc: { writeAuthorizedBy: ["trusted-handler"] },
            },
          },
          required: ["value"],
        },
        tx,
      );
      cell.set({ value: "secret" });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error?.message).toContain(
        "writeAuthorizedBy requires a trusted builtin identity",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("allows writeAuthorizedBy when the builtin identity matches", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      runtime.moduleRegistry.addModuleByRef(
        "trusted-handler",
        raw((inputsCell) => {
          const tx = inputsCell.tx;
          if (!tx) {
            throw new Error("missing tx");
          }
          const cell = runtime.getCell(
            signer.did(),
            "cfc-authorized-write",
            {
              type: "object",
              properties: {
                value: {
                  type: "string",
                  ifc: { writeAuthorizedBy: ["trusted-handler"] },
                },
              },
              required: ["value"],
            },
            tx,
          );
          cell.set({ value: "authorized" });
          return () => undefined;
        }),
      );

      const tx = runtime.edit();
      const resultCell = runtime.getCell(
        signer.did(),
        "cfc-authorized-write-result",
        undefined,
        tx,
      );
      runtime.runner.run(
        tx,
        runtime.moduleRegistry.getModule("trusted-handler"),
        {},
        resultCell,
      );

      const result = await tx.commit();
      expect(result.ok).toBeDefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("allows writeAuthorizedBy when a verified binding identity matches", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      tx.setCfcTrustSnapshot({
        id: "trust-snapshot-1",
        actingPrincipal: signer.did(),
      });
      tx.setCfcImplementationIdentity({
        kind: "verified",
        bundleId: "bundle-hash-1",
        sourceFile: "/main.tsx",
        bindingPath: ["localFunction"],
      });

      const cell = runtime.getCell(
        signer.did(),
        "cfc-authorized-verified-write",
        {
          type: "object",
          properties: {
            value: {
              type: "string",
              ifc: {
                writeAuthorizedBy: {
                  __ctWriterIdentityOf: {
                    file: "/main.tsx",
                    path: ["localFunction"],
                  },
                },
              },
            },
          },
          required: ["value"],
        },
        tx,
      );
      cell.set({ value: "authorized" });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.ok).toBeDefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects writeAuthorizedBy when the verified bundle identity differs", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      tx.setCfcTrustSnapshot({
        id: "trust-snapshot-1",
        actingPrincipal: signer.did(),
      });
      tx.setCfcImplementationIdentity({
        kind: "verified",
        bundleId: "bundle-hash-1",
        sourceFile: "/main.tsx",
        bindingPath: ["localFunction"],
      });

      const cell = runtime.getCell(
        signer.did(),
        "cfc-rejected-verified-bundle-write",
        {
          type: "object",
          properties: {
            value: {
              type: "string",
              ifc: {
                writeAuthorizedBy: {
                  __ctWriterIdentityOf: {
                    bundleId: "bundle-hash-2",
                    file: "/main.tsx",
                    path: ["localFunction"],
                  },
                },
              },
            },
          },
          required: ["value"],
        },
        tx,
      );
      cell.set({ value: "rejected" });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error?.message).toContain("writeAuthorizedBy failed");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("records diagnostics for unsupported trust-sensitive claims in observe mode", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("observe");

      const cell = runtime.getCell(
        signer.did(),
        "cfc-observe-unsupported-trust-claim",
        {
          type: "object",
          properties: {
            value: {
              type: "string",
              ifc: {
                projection: {
                  from: ["input", "value"],
                  path: ["value"],
                } as any,
              },
            },
          },
          required: ["value"],
        },
        tx,
      );
      cell.set({ value: "observed" });

      const result = await tx.commit();
      expect(result.ok).toBeDefined();
      expect(tx.getCfcState().diagnostics).toContain(
        "unsupported trust-sensitive claim projection at /value",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("fails closed on object-shaped collection claims in enforcing modes", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");

      const cell = runtime.getCell(
        signer.did(),
        "cfc-unsupported-collection-claim",
        {
          type: "object",
          properties: {
            value: {
              type: "array",
              items: { type: "string" },
              ifc: {
                collection: {
                  subsetOf: ["input", "items"],
                  memberIntegrity: "preserved",
                } as any,
              },
            },
          },
          required: ["value"],
        },
        tx,
      );
      cell.set({ value: ["observed"] });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error?.message).toContain(
        "unsupported trust-sensitive claim collection",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
