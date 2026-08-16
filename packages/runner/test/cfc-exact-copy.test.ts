import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { parseLink } from "../src/link-utils.ts";

const signer = await Identity.fromPassphrase("runner-cfc-exact-copy");

describe("CFC exact copy claims", () => {
  const createRuntime = () => {
    const storageManager = StorageManager.emulate({
      as: signer,
    });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
    });
    return { runtime, storageManager };
  };

  const persistedEntries = (
    storageManager: ReturnType<typeof StorageManager.emulate>,
    id: string,
  ) => {
    const replica = storageManager.open(signer.did()).replica as unknown as {
      getDocument(id: string): {
        cfc?: {
          labelMap?: {
            entries: Array<{
              path: string[];
              label: {
                confidentiality?: unknown[];
                integrity?: unknown[];
              };
            }>;
          };
        };
      } | undefined;
    };
    return replica.getDocument(id)?.cfc?.labelMap?.entries ?? [];
  };

  it("preserves labels when an exact copy claim is satisfied", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      const cell = runtime.getCell(
        signer.did(),
        "cfc-exact-copy",
        {
          type: "object",
          properties: {
            emailAddress: {
              type: "string",
              ifc: { confidentiality: ["secret"] },
            },
            confirmedEmail: {
              type: "string",
              ifc: { exactCopyOf: ["emailAddress"] },
            },
          },
          required: ["emailAddress", "confirmedEmail"],
        },
        tx,
      );

      cell.set({
        emailAddress: "alice@example.com",
        confirmedEmail: "alice@example.com",
      });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.ok).toBeDefined();

      const persistedId = parseLink(cell.getAsLink()).id!;
      const replica = storageManager.open(signer.did()).replica as unknown as {
        getDocument(id: string): {
          value?: unknown;
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
      expect(persisted?.value).toEqual({
        emailAddress: "alice@example.com",
        confirmedEmail: "alice@example.com",
      });
      expect(persisted?.cfc?.labelMap?.entries).toContainEqual({
        path: ["confirmedEmail"],
        label: {
          confidentiality: ["secret"],
        },
        origin: "declared",
      });
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects an exact copy claim when the copied value changes", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      const cell = runtime.getCell(
        signer.did(),
        "cfc-exact-copy-reject",
        {
          type: "object",
          properties: {
            emailAddress: {
              type: "string",
              ifc: { confidentiality: ["secret"] },
            },
            confirmedEmail: {
              type: "string",
              ifc: { exactCopyOf: ["emailAddress"] },
            },
          },
          required: ["emailAddress", "confirmedEmail"],
        },
        tx,
      );

      cell.set({
        emailAddress: "alice@example.com",
        confirmedEmail: "not-alice@example.com",
      });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error?.message).toContain("exactCopyOf failed");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("copies an array-item label through its concrete source path", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      const cell = runtime.getCell(signer.did(), "cfc-exact-copy-item", {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "string",
              ifc: { confidentiality: ["secret"] },
            },
          },
          copy: {
            type: "string",
            ifc: { exactCopyOf: ["items", "0"] },
          },
        },
        required: ["items", "copy"],
      }, tx);
      cell.set({ items: ["classified"], copy: "classified" });
      tx.prepareCfc();
      expect((await tx.commit()).error).toBeUndefined();

      const entries = persistedEntries(
        storageManager,
        parseLink(cell.getAsLink()).id!,
      );
      expect(entries).toContainEqual({
        path: ["copy"],
        label: { confidentiality: ["secret"] },
        origin: "declared",
      });
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("honors a child label that replaces ancestor integrity", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      const cell = runtime.getCell(signer.did(), "cfc-exact-copy-shadow", {
        type: "object",
        properties: {
          source: {
            type: "object",
            ifc: { integrity: ["ancestor"] },
            properties: {
              child: { type: "string", ifc: { integrity: [] } },
            },
            required: ["child"],
          },
          copy: {
            type: "string",
            ifc: { exactCopyOf: ["source", "child"] },
          },
        },
        required: ["source", "copy"],
      }, tx);
      cell.set({ source: { child: "plain" }, copy: "plain" });
      tx.prepareCfc();
      expect((await tx.commit()).error).toBeUndefined();

      const copy = persistedEntries(
        storageManager,
        parseLink(cell.getAsLink()).id!,
      ).find((entry) => entry.path.join("/") === "copy");
      expect(copy?.label.integrity ?? []).not.toContain("ancestor");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("does not accept two different links as an exact copy", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      const first = runtime.getCell(
        signer.did(),
        "cfc-exact-copy-link-a",
        { type: "string" },
        tx,
      );
      const second = runtime.getCell(
        signer.did(),
        "cfc-exact-copy-link-b",
        { type: "string" },
        tx,
      );
      const cell = runtime.getCell(signer.did(), "cfc-exact-copy-links", {
        type: "object",
        properties: {
          source: {},
          copy: { ifc: { exactCopyOf: ["source"] } },
        },
        required: ["source", "copy"],
      }, tx);
      cell.set({
        source: first.getAsNormalizedFullLink(),
        copy: second.getAsNormalizedFullLink(),
      });
      tx.prepareCfc();
      expect(String((await tx.commit()).error?.message)).toContain(
        "exactCopyOf failed",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("does not carry from an overlapping oneOf copy branch", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      const cell = runtime.getCell(signer.did(), "cfc-exact-copy-one-of", {
        type: "object",
        properties: {
          source: {
            type: "string",
            ifc: { confidentiality: ["secret"] },
          },
          copy: {
            oneOf: [
              { type: "string", ifc: { exactCopyOf: ["source"] } },
              { type: "string" },
            ],
          },
        },
        required: ["source", "copy"],
      }, tx);
      cell.set({ source: "same", copy: "same" });
      tx.prepareCfc();
      expect((await tx.commit()).error).toBeUndefined();

      const copy = persistedEntries(
        storageManager,
        parseLink(cell.getAsLink()).id!,
      ).find((entry) => entry.path.join("/") === "copy");
      expect(copy?.label.confidentiality ?? []).not.toContain("secret");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("copies labels from an unchanged matching source", async () => {
    const { runtime, storageManager } = createRuntime();
    const schema = {
      type: "object",
      properties: {
        source: {
          anyOf: [
            {
              const: true,
              ifc: {
                confidentiality: ["secret"],
                integrity: ["verified"],
              },
            },
            { const: false },
          ],
        },
        copy: {
          type: "boolean",
          ifc: { exactCopyOf: ["source"] },
        },
      },
      required: ["source"],
    } as const;
    try {
      const firstTx = runtime.edit();
      runtime.getCell(
        signer.did(),
        "cfc-exact-copy-unchanged-source",
        schema,
        firstTx,
      ).set({ source: true });
      firstTx.prepareCfc();
      expect((await firstTx.commit()).error).toBeUndefined();

      const secondTx = runtime.edit();
      const cell = runtime.getCell(
        signer.did(),
        "cfc-exact-copy-unchanged-source",
        schema,
        secondTx,
      );
      cell.key("copy").set(true);
      secondTx.prepareCfc();
      expect((await secondTx.commit()).error).toBeUndefined();

      const copy = persistedEntries(
        storageManager,
        parseLink(cell.getAsLink()).id!,
      ).find((entry) => entry.path.join("/") === "copy");
      expect(copy?.label.confidentiality).toContain("secret");
      expect(copy?.label.integrity).toContain("verified");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
