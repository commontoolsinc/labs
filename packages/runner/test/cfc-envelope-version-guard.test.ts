import {
  SEED_ENVELOPE_SCHEMA_HASH,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import { internSchema } from "@commonfabric/data-model/schema-hash";
import type { JSONSchema } from "../src/builder/types.ts";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import { parseLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import {
  readStoredCfcMetadata,
  storedCfcMetadataAppliesToPath,
  UnknownCfcMetadataVersionError,
} from "../src/cfc/metadata.ts";
import { loadStoredCfcEnvelope } from "../src/cfc/prepare.ts";

const signer = await Identity.fromPassphrase("runner-cfc-envelope-version");
const space = signer.did();

// A stored envelope whose version this build postdates cannot be treated
// as absent — that would read a labeled document as unlabeled. Every
// reader fails closed instead: the metadata reader throws, the
// applies-to-path probe reports that policy applies, and the commit path
// classifies the envelope as unreadable and rejects the write.
describe("CFC envelope version guard", () => {
  const seedWithVersion = async (
    runtime: Runtime,
    name: string,
    version: number,
  ): Promise<`${string}:${string}`> => {
    const id = parseLink(runtime.getCell(space, name).getAsLink()).id!;
    const seed = runtime.edit();
    writeSeedEnvelopeDoc(seed, space);
    seed.writeOrThrow({ space, scope: "space", id, path: [] }, {
      value: { secret: "sealed" },
      cfc: {
        version,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          entries: [{ path: [], label: { confidentiality: ["vaulted"] } }],
        },
      },
    });
    expect((await seed.commit()).ok).toBeDefined();
    return id;
  };

  it("throws from the metadata reader for a version it does not interpret", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
    });
    try {
      const id = await seedWithVersion(runtime, "version-guard-throw", 3);
      const tx = runtime.edit();
      expect(() => readStoredCfcMetadata(tx, { space, id })).toThrow(
        UnknownCfcMetadataVersionError,
      );
      tx.abort();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("reports that stored policy applies to a path it cannot interpret", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
    });
    try {
      const id = await seedWithVersion(runtime, "version-guard-applies", 3);
      const tx = runtime.edit();
      expect(
        storedCfcMetadataAppliesToPath(tx, {
          space,
          scope: "space",
          id,
          path: ["secret"],
        }),
      ).toBe(true);
      tx.abort();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects an enforcing write whose stored envelope version is unknown", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
    });
    try {
      await seedWithVersion(runtime, "version-guard-write", 3);
      const tx = runtime.edit();
      const cell = runtime.getCell(space, "version-guard-write", {
        type: "object",
        properties: {
          secret: { type: "string", ifc: { confidentiality: ["vaulted"] } },
        },
        required: ["secret"],
      }, tx);
      cell.set({ secret: "updated" });
      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error?.message).toContain(
        "not one this build interprets",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("loads an envelope whose stored root references its definition", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
    });
    try {
      // One read policy, no version distinction: a version-1 root carrying
      // `$ref: cid:` members (the trail a reference-form declared schema
      // leaves) resolves through the space, or the envelope is unreadable.
      const child = internSchema(
        {
          type: "string",
          ifc: { confidentiality: ["guarded"] },
        } as JSONSchema,
        true,
      );
      const root = internSchema(
        {
          type: "object",
          properties: { secret: { $ref: `cid:${child.taggedHashString}` } },
        } as JSONSchema,
        true,
      );
      const id = parseLink(
        runtime.getCell(space, "version-guard-refs").getAsLink(),
      ).id!;
      const seed = runtime.edit();
      for (const sah of [child, root]) {
        seed.writeOrThrow({
          space,
          scope: "space",
          id: `cid:${sah.taggedHashString}` as `${string}:${string}`,
          path: [],
        }, { value: sah.schema });
      }
      seed.writeOrThrow({ space, scope: "space", id, path: [] }, {
        value: { secret: "sealed" },
        cfc: {
          version: 1,
          schemaHash: root.taggedHashString,
          labelMap: {
            version: 1,
            entries: [{
              path: ["secret"],
              label: { confidentiality: ["guarded"] },
            }],
          },
        },
      });
      expect((await seed.commit()).ok).toBeDefined();

      const tx = runtime.edit();
      const envelope = loadStoredCfcEnvelope(tx, { space, id });
      expect(envelope.status).toBe("loaded");
      if (envelope.status !== "loaded") throw new Error("unreachable");
      const spelled = JSON.stringify(envelope.schema);
      expect(spelled).not.toContain("cid:");
      expect(spelled).toContain('"guarded"');
      tx.abort();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
