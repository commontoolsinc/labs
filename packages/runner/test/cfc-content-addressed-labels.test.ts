import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { CFC_ATOM_TYPE, CFC_CONCEPT_KIND } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";
import type { URI } from "@commonfabric/memory/interface";
import type { JSONSchema } from "../src/builder/types.ts";
import { canonicalizeCfcMetadata } from "../src/cfc/canonical.ts";
import {
  CFC_LABEL_INLINE_LIMIT,
  cfcLabelDocumentContent,
  cfcLabelDocumentHash,
  CfcLabelDocumentHashMismatchError,
  CfcLabelDocumentMalformedError,
  cfcLabelTakesReference,
  isCfcLabelReference,
  referencedCfcLabelDocumentHashes,
  registerCfcLabelDocument,
  storedLabelMapEntries,
} from "../src/cfc/label-documents.ts";
import { cfcLabelViewForDereference } from "../src/cfc/label-view-state.ts";
import type { IFCLabel } from "../src/cfc/label-view-core.ts";
import {
  readStoredCfcMetadata,
  storedCfcMetadataAppliesToPath,
  StoredCfcMetadataError,
  UnreadableCfcMetadataError,
  UnresolvableCfcLabelDocumentError,
} from "../src/cfc/metadata.ts";
import { loadStoredCfcEnvelope } from "../src/cfc/prepare.ts";
import type {
  CfcMetadata,
  LabelMapEntry,
  StoredCfcMetadata,
} from "../src/cfc/types.ts";
import { parseLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { TransactionWrapper } from "../src/storage/extended-storage-transaction.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("runner-cfc-content-addressed");
const space = signer.did();

const bytesOf = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).length;

//
// A fixture shaped like a measured store
//
// Eight entries per map, six distinct labels of three or four clauses drawn
// from seven distinct clauses, the clauses and labels sized like the ones
// measured on chat-row entities. The byte assertions below are stated
// against it, so the numbers they hold are the numbers a store of that
// shape would see.
//

const did = (n: number): string =>
  `did:key:z6Mkp${"abcdefghijklmnopqrstuvwxyz".repeat(2).slice(n, n + 42)}`;

const userClause = { type: CFC_ATOM_TYPE.User, subject: did(1) };
const spaceClause = { type: CFC_ATOM_TYPE.Space, id: did(3) };
const caveatClause = {
  type: CFC_ATOM_TYPE.Caveat,
  kind: CFC_CONCEPT_KIND.PromptInjectionRiskUnscreened,
  source: { type: CFC_ATOM_TYPE.User, subject: did(5) },
};
const orClause = {
  anyOf: [
    { type: CFC_ATOM_TYPE.User, subject: did(2) },
    { type: CFC_ATOM_TYPE.User, subject: did(4) },
  ],
};
const publicClause = "https://commonfabric.org/cfc/atom/Public/room-general";
const policyClause = {
  type: CFC_ATOM_TYPE.Policy,
  name: "standard-caveat-policy",
  hash: `fid1:${"k".repeat(43)}`,
  subject: did(7),
};
const personalClause = { type: CFC_ATOM_TYPE.PersonalSpace, owner: did(9) };

const FIXTURE_LABELS: IFCLabel[] = [
  { confidentiality: [userClause, spaceClause, caveatClause, publicClause] },
  { confidentiality: [userClause, spaceClause, orClause, publicClause] },
  { confidentiality: [userClause, caveatClause, policyClause] },
  { confidentiality: [userClause, personalClause, orClause, publicClause] },
  {
    confidentiality: [spaceClause, caveatClause, policyClause, personalClause],
  },
  { confidentiality: [userClause, spaceClause, policyClause, personalClause] },
].map((label) => ({ ...label, integrity: undefined }));

const FIXTURE_ENTRIES: LabelMapEntry[] = ([
  { path: ["messages", "*", "text"], origin: "declared", label: 0 },
  { path: ["messages", "*", "author"], origin: "declared", label: 1 },
  { path: ["messages", "*", "ts"], origin: "declared", label: 2 },
  { path: ["messages", "*", "attachments", "*"], origin: "declared", label: 3 },
  { path: ["title"], origin: "derived", label: 0 },
  { path: ["members", "*"], origin: "declared", label: 4 },
  {
    path: ["messages", "*"],
    origin: "structure",
    observes: "enumerate",
    label: 5,
  },
  { path: ["messages"], origin: "structure", observes: "enumerate", label: 1 },
] satisfies (Omit<LabelMapEntry, "label"> & { label: number })[]).map(
  (entry) => ({ ...entry, label: FIXTURE_LABELS[entry.label] }),
);

const FIXTURE_METADATA: CfcMetadata = {
  version: 1,
  schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
  labelMap: { version: 1, entries: FIXTURE_ENTRIES },
};

/** The version-2 spelling of `metadata`, with every staged document. */
const storedForm = (
  metadata: CfcMetadata,
): { stored: StoredCfcMetadata; documents: Map<string, IFCLabel> } => {
  const documents = new Map<string, IFCLabel>();
  const stored: StoredCfcMetadata = {
    version: 2,
    schemaHash: metadata.schemaHash,
    labelMap: {
      version: 1,
      entries: storedLabelMapEntries(metadata.labelMap.entries, (content) => {
        const hash = cfcLabelDocumentHash(content);
        documents.set(hash, content);
        return `cid:${hash}`;
      }),
    },
  };
  return { stored, documents };
};

//
// Runtime helpers
//

// A declared schema whose one labeled field carries three atoms long
// enough that the label exceeds the inline limit, so the persist path
// stores it by reference; `note` carries one short atom, which stays
// inline beside it.
const LONG_ATOMS = [
  "https://commonfabric.org/cfc/atom/Public/room-general-chat-alpha",
  "https://commonfabric.org/cfc/atom/Public/room-general-chat-beta",
  "https://commonfabric.org/cfc/atom/Public/room-general-chat-gamma",
];
const DECLARED_SCHEMA = {
  type: "object",
  properties: {
    secret: { type: "string", ifc: { confidentiality: LONG_ATOMS } },
    note: { type: "string", ifc: { confidentiality: ["short"] } },
  },
  required: ["secret", "note"],
} as const satisfies JSONSchema;

type Replica = {
  getDocument(
    id: string,
  ): { cfc?: StoredCfcMetadata; value?: unknown } | undefined;
};

const replicaOf = (runtime: Runtime): Replica =>
  runtime.storageManager.open(space).replica as unknown as Replica;

/**
 * One declared-schema write to `name` in a transaction whose envelope
 * version the caller chooses; resolves with the staged `cid:` ids, whether
 * the envelope was written, and the stored envelope after the commit.
 */
const declaredWrite = async (
  runtime: Runtime,
  name: string,
  value: { secret: string; note: string },
  contentAddressed: boolean,
): Promise<{
  id: string;
  cidWrites: string[];
  envelopeWritten: boolean;
  stored: StoredCfcMetadata | undefined;
}> => {
  const tx = runtime.edit();
  tx.setCfcContentAddressedLabels(contentAddressed);
  const cell = runtime.getCell(space, name, DECLARED_SCHEMA, tx);
  cell.set(value);
  tx.prepareCfc();
  const id = cell.getAsNormalizedFullLink().id;
  const details = [...tx.getWriteDetails?.(space) ?? []];
  const cidWrites = details
    .map((detail) => detail.address.id)
    .filter((docId) => docId.startsWith("cid:"));
  const envelopeWritten = details.some((detail) =>
    detail.address.id === id && detail.address.path[0] === "cfc"
  );
  expect((await tx.commit()).ok).toBeDefined();
  return {
    id,
    cidWrites,
    envelopeWritten,
    stored: replicaOf(runtime).getDocument(id)?.cfc,
  };
};

const withRuntime = async (
  body: (runtime: Runtime) => Promise<void>,
): Promise<void> => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    cfcContentAddressedLabels: true,
  });
  try {
    await body(runtime);
  } finally {
    // Disposing the runtime closes the storage manager it was built on.
    await runtime.dispose();
  }
};

/**
 * Writes a version-2 envelope for a fresh document into `tx` without
 * committing, referencing the label document `hash` names: what a reader
 * of this transaction sees is the envelope, and the document only if the
 * transaction or the replica holds it.
 */
const writeReferencingEnvelope = (
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  name: string,
  hash: string,
): string => {
  const id = parseLink(runtime.getCell(space, name).getAsLink()).id!;
  writeSeedEnvelopeDoc(tx, space);
  tx.writeOrThrow({ space, scope: "space", id, path: [] }, {
    value: { secret: "sealed" },
    cfc: {
      version: 2,
      schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
      labelMap: {
        version: 1,
        entries: [{ path: ["secret"], label: { $ref: `cid:${hash}` } }],
      },
    },
  });
  return id;
};

describe("CFC content-addressed labels", () => {
  describe("bytes per labeled entity", () => {
    it("stores the fixture's envelope in under a quarter of its inline bytes", () => {
      const { stored, documents } = storedForm(FIXTURE_METADATA);
      const inlineBytes = bytesOf(FIXTURE_METADATA);
      const referencedBytes = bytesOf(stored);
      expect(referencedBytes).toBeLessThan(inlineBytes / 4);
      // Every fixture label is well above the inline limit, so every entry
      // holds a reference, and the six distinct labels are six documents.
      expect(
        stored.labelMap.entries.every((entry) =>
          isCfcLabelReference(entry.label)
        ),
      ).toBe(true);
      expect(documents.size).toBe(6);
      // The documents, written once per space, together hold fewer bytes
      // than one inline envelope: the sharing is what the reference buys.
      const documentBytes = [...documents.values()].reduce(
        (sum, label) => sum + bytesOf(label),
        0,
      );
      expect(documentBytes).toBeLessThan(inlineBytes);
    });

    it("keeps a label under the inline limit inline beside referenced ones", () => {
      const short: IFCLabel = { confidentiality: ["short"] };
      const { stored } = storedForm({
        ...FIXTURE_METADATA,
        labelMap: {
          version: 1,
          entries: [
            { path: ["a"], label: short },
            { path: ["b"], label: FIXTURE_LABELS[0] },
          ],
        },
      });
      expect(stored.labelMap.entries[0].label).toEqual(short);
      expect(isCfcLabelReference(stored.labelMap.entries[1].label)).toBe(true);
      expect(cfcLabelTakesReference(short)).toBe(false);
      expect(cfcLabelTakesReference(FIXTURE_LABELS[0])).toBe(true);
      // The rule is the canonical JSON length against the limit, exactly.
      const atLimit: IFCLabel = {
        confidentiality: [
          "x".repeat(
            CFC_LABEL_INLINE_LIMIT - '{"confidentiality":[""]}'.length,
          ),
        ],
      };
      expect(bytesOf(atLimit)).toBe(CFC_LABEL_INLINE_LIMIT);
      expect(cfcLabelTakesReference(atLimit)).toBe(false);
      expect(cfcLabelTakesReference({
        confidentiality: [`${atLimit.confidentiality![0]}y`],
      })).toBe(true);
    });

    it("measures the limit in UTF-8 bytes, not string length", () => {
      // Thirty four-byte characters: 84 code units of JSON, 144 bytes.
      const wide: IFCLabel = { confidentiality: ["😀".repeat(30)] };
      expect(JSON.stringify(wide).length).toBeLessThan(CFC_LABEL_INLINE_LIMIT);
      expect(bytesOf(wide)).toBeGreaterThan(CFC_LABEL_INLINE_LIMIT);
      expect(cfcLabelTakesReference(wide)).toBe(true);
    });
  });

  describe("label documents", () => {
    it("hashes the canonical content, without undefined members", () => {
      const content = cfcLabelDocumentContent(FIXTURE_LABELS[0]);
      expect("integrity" in content).toBe(false);
      expect(cfcLabelDocumentHash(content)).toBe(
        cfcLabelDocumentHash({
          confidentiality: FIXTURE_LABELS[0].confidentiality,
        }),
      );
      // Alternative order inside an OR-clause canonicalizes to one document.
      const swapped: IFCLabel = {
        confidentiality: [{ anyOf: [...orClause.anyOf].reverse() }],
      };
      expect(cfcLabelDocumentHash(cfcLabelDocumentContent(swapped))).toBe(
        cfcLabelDocumentHash(
          cfcLabelDocumentContent({ confidentiality: [orClause] }),
        ),
      );
    });

    it("refuses to register content under a hash it does not produce", () => {
      const content = cfcLabelDocumentContent(FIXTURE_LABELS[0]);
      expect(() =>
        registerCfcLabelDocument(cfcLabelDocumentHash(content), {
          confidentiality: ["other"],
        })
      ).toThrow(CfcLabelDocumentHashMismatchError);
    });

    it("refuses to register content that is not label-shaped", () => {
      const malformed = { confidentiality: "secret" };
      expect(() =>
        registerCfcLabelDocument(
          cfcLabelDocumentHash(malformed as unknown as IFCLabel),
          malformed as unknown as IFCLabel,
        )
      ).toThrow(CfcLabelDocumentMalformedError);
      expect(() =>
        registerCfcLabelDocument(
          cfcLabelDocumentHash({ extra: [] } as unknown as IFCLabel),
          { extra: [] } as unknown as IFCLabel,
        )
      ).toThrow(CfcLabelDocumentMalformedError);
    });

    it("registers labels deep-frozen, so a shared entry cannot change", () => {
      const content = cfcLabelDocumentContent({
        confidentiality: [{ type: CFC_ATOM_TYPE.User, subject: did(11) }],
      });
      const registered = registerCfcLabelDocument(
        cfcLabelDocumentHash(content),
        content,
      );
      expect(Object.isFrozen(registered)).toBe(true);
      expect(Object.isFrozen(registered.confidentiality)).toBe(true);
      expect(Object.isFrozen(registered.confidentiality![0])).toBe(true);
    });

    it("lists the distinct documents a stored map references, in order", () => {
      const { stored, documents } = storedForm(FIXTURE_METADATA);
      const hashes = referencedCfcLabelDocumentHashes(stored.labelMap.entries);
      expect(hashes.length).toBe(6);
      expect(new Set(hashes)).toEqual(new Set(documents.keys()));
    });

    it("compares a version-1 and a version-2 envelope by their labels", () => {
      const resolvedFromDocuments: CfcMetadata = {
        version: 2,
        schemaHash: FIXTURE_METADATA.schemaHash,
        labelMap: {
          version: 1,
          entries: FIXTURE_ENTRIES.map((entry) => ({
            ...entry,
            label: cfcLabelDocumentContent(entry.label),
          })),
        },
      };
      expect(canonicalizeCfcMetadata(resolvedFromDocuments)).toEqual(
        canonicalizeCfcMetadata(FIXTURE_METADATA),
      );
    });
  });

  describe("persist path", () => {
    it("writes a version-2 envelope that resolves to the inline labels", async () => {
      await withRuntime(async (runtime) => {
        const { id, cidWrites, stored } = await declaredWrite(
          runtime,
          "round-trip",
          { secret: "classified", note: "n" },
          true,
        );
        expect(stored?.version).toBe(2);
        const entries = stored!.labelMap.entries;
        const referenced = entries.filter((entry) =>
          isCfcLabelReference(entry.label)
        );
        expect(referenced.length).toBeGreaterThan(0);
        for (const entry of referenced) {
          expect(cidWrites).toContain((entry.label as { $ref: string }).$ref);
        }
        // The short declared label stays inline in the same map.
        const note = entries.find((entry) =>
          entry.path.join("/") === "note" && entry.origin === "declared"
        );
        expect(note).toBeDefined();
        expect(isCfcLabelReference(note!.label)).toBe(false);

        const tx = runtime.edit();
        const resolved = readStoredCfcMetadata(tx, { space, id });
        expect(resolved?.version).toBe(2);
        for (const entry of resolved!.labelMap.entries) {
          expect(isCfcLabelReference(entry.label)).toBe(false);
        }
        const secret = resolved!.labelMap.entries.find((entry) =>
          entry.path.join("/") === "secret" && entry.origin === "declared"
        );
        expect(secret?.label.confidentiality).toEqual(LONG_ATOMS);
        tx.abort();
      });
    });

    it("stores fewer envelope bytes than the version-1 spelling of the same labels", async () => {
      await withRuntime(async (runtime) => {
        const inline = await declaredWrite(
          runtime,
          "bytes-inline",
          { secret: "classified", note: "n" },
          false,
        );
        const referenced = await declaredWrite(
          runtime,
          "bytes-referenced",
          { secret: "classified", note: "n" },
          true,
        );
        expect(inline.stored?.version).toBe(1);
        expect(referenced.stored?.version).toBe(2);
        expect(bytesOf(referenced.stored)).toBeLessThan(
          bytesOf(inline.stored),
        );
      });
    });

    it("holds still on a re-derivation of unchanged labels", async () => {
      await withRuntime(async (runtime) => {
        await declaredWrite(runtime, "idempotent", {
          secret: "classified",
          note: "n",
        }, true);
        await runtime.storageManager.synced();
        const again = await declaredWrite(runtime, "idempotent", {
          secret: "updated",
          note: "n",
        }, true);
        expect(again.envelopeWritten).toBe(false);
        expect(again.cidWrites).toEqual([]);
      });
    });

    it("rewrites a version-1 envelope in version 2 on its next persist, once", async () => {
      await withRuntime(async (runtime) => {
        const first = await declaredWrite(runtime, "migrate", {
          secret: "classified",
          note: "n",
        }, false);
        expect(first.stored?.version).toBe(1);
        await runtime.storageManager.synced();
        const second = await declaredWrite(runtime, "migrate", {
          secret: "classified",
          note: "n",
        }, true);
        expect(second.envelopeWritten).toBe(true);
        expect(second.stored?.version).toBe(2);
        await runtime.storageManager.synced();
        const third = await declaredWrite(runtime, "migrate", {
          secret: "classified",
          note: "n",
        }, true);
        expect(third.envelopeWritten).toBe(false);
      });
    });

    it("elides label documents the space's server already holds", async () => {
      await withRuntime(async (runtime) => {
        const first = await declaredWrite(runtime, "elide-a", {
          secret: "classified",
          note: "n",
        }, true);
        expect(
          first.cidWrites.some((id) =>
            id !== `cid:${first.stored!.schemaHash}`
          ),
        )
          .toBe(true);
        await runtime.storageManager.synced();
        const second = await declaredWrite(runtime, "elide-b", {
          secret: "classified",
          note: "n",
        }, true);
        expect(second.stored?.version).toBe(2);
        expect(second.cidWrites).toEqual([]);
      });
    });

    it("keeps the version-1 inline form with the flag off", async () => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      try {
        const { stored } = await declaredWrite(runtime, "flag-off", {
          secret: "classified",
          note: "n",
        }, runtime.cfcContentAddressedLabels);
        expect(runtime.cfcContentAddressedLabels).toBe(false);
        expect(stored?.version).toBe(1);
        expect(
          stored!.labelMap.entries.some((entry) =>
            isCfcLabelReference(entry.label)
          ),
        ).toBe(false);
      } finally {
        await runtime.dispose();
      }
    });

    it("delegates the flag through the transaction wrapper", async () => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      try {
        const tx = runtime.edit();
        const wrapper = new TransactionWrapper(
          tx as unknown as ConstructorParameters<typeof TransactionWrapper>[0],
          {},
        );
        expect(tx.getCfcState().contentAddressedLabels).toBe(false);
        wrapper.setCfcContentAddressedLabels(true);
        expect(tx.getCfcState().contentAddressedLabels).toBe(true);
        tx.abort();
      } finally {
        await runtime.dispose();
      }
    });
  });

  describe("fail closed", () => {
    const absentHash = cfcLabelDocumentHash({
      confidentiality: ["never-written-anywhere"],
    });

    it("throws from the metadata reader for a label document nothing backs", async () => {
      await withRuntime((runtime) => {
        const tx = runtime.edit();
        const id = writeReferencingEnvelope(runtime, tx, "absent", absentHash);
        expect(() => readStoredCfcMetadata(tx, { space, id })).toThrow(
          UnresolvableCfcLabelDocumentError,
        );
        let thrown: unknown;
        try {
          readStoredCfcMetadata(tx, { space, id });
        } catch (error) {
          thrown = error;
        }
        expect(thrown instanceof StoredCfcMetadataError).toBe(true);
        tx.abort();
        return Promise.resolve();
      });
    });

    it("reports that stored policy applies to a path whose label it cannot resolve", async () => {
      await withRuntime((runtime) => {
        const tx = runtime.edit();
        const id = writeReferencingEnvelope(
          runtime,
          tx,
          "absent-applies",
          absentHash,
        );
        expect(storedCfcMetadataAppliesToPath(tx, {
          space,
          id: id as URI,
          scope: "space",
          path: ["value", "secret"],
        })).toBe(true);
        tx.abort();
        return Promise.resolve();
      });
    });

    it("fails the dereference label view loudly instead of serving unlabeled", async () => {
      await withRuntime((runtime) => {
        const tx = runtime.edit();
        const id = writeReferencingEnvelope(
          runtime,
          tx,
          "absent-view",
          absentHash,
        );
        expect(() =>
          cfcLabelViewForDereference(
            tx,
            { space, scope: "space", id, path: [] },
            { space, scope: "space", id, path: [] },
          )
        ).toThrow(UnresolvableCfcLabelDocumentError);
        tx.abort();
        return Promise.resolve();
      });
    });

    it("classifies the envelope as unreadable on the commit path and rejects the write", async () => {
      await withRuntime(async (runtime) => {
        const tx = runtime.edit();
        const id = writeReferencingEnvelope(
          runtime,
          tx,
          "absent-write",
          absentHash,
        );
        const envelope = loadStoredCfcEnvelope(tx, { space, id });
        expect(envelope.status).toBe("unreadable");
        const cell = runtime.getCell(space, "absent-write", {
          type: "object",
          properties: {
            secret: { type: "string", ifc: { confidentiality: ["vaulted"] } },
          },
          required: ["secret"],
        }, tx);
        cell.set({ secret: "updated" });
        tx.prepareCfc();
        const result = await tx.commit();
        expect(result.error?.message).toContain("cannot be resolved");
      });
    });

    it("refuses a label document whose content does not hash to its id", async () => {
      await withRuntime((runtime) => {
        const tx = runtime.edit();
        const forgedHash = cfcLabelDocumentHash({ confidentiality: ["real"] });
        tx.writeOrThrow({
          space,
          scope: "space",
          id: `cid:${forgedHash}` as URI,
          path: [],
        }, { value: { confidentiality: ["forged"] } });
        const id = writeReferencingEnvelope(runtime, tx, "forged", forgedHash);
        expect(() => readStoredCfcMetadata(tx, { space, id })).toThrow(
          "hashes to",
        );
        tx.abort();
        return Promise.resolve();
      });
    });

    it("refuses a label document whose content is not label-shaped", async () => {
      await withRuntime((runtime) => {
        const tx = runtime.edit();
        const malformed = { confidentiality: "secret" };
        const hash = cfcLabelDocumentHash(malformed as unknown as IFCLabel);
        tx.writeOrThrow({
          space,
          scope: "space",
          id: `cid:${hash}` as URI,
          path: [],
        }, { value: malformed });
        const id = writeReferencingEnvelope(runtime, tx, "malformed", hash);
        expect(() => readStoredCfcMetadata(tx, { space, id })).toThrow(
          "does not hold a label",
        );
        tx.abort();
        return Promise.resolve();
      });
    });

    it("refuses a version-1 envelope holding a reference", async () => {
      await withRuntime((runtime) => {
        const tx = runtime.edit();
        const content: IFCLabel = { confidentiality: ["v1-referenced"] };
        const hash = cfcLabelDocumentHash(content);
        registerCfcLabelDocument(hash, content);
        const id = parseLink(runtime.getCell(space, "v1-ref").getAsLink()).id!;
        writeSeedEnvelopeDoc(tx, space);
        tx.writeOrThrow({ space, scope: "space", id, path: [] }, {
          value: { secret: "sealed" },
          cfc: {
            version: 1,
            schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
            labelMap: {
              version: 1,
              entries: [{ path: ["secret"], label: { $ref: `cid:${hash}` } }],
            },
          },
        });
        expect(() => readStoredCfcMetadata(tx, { space, id })).toThrow(
          UnreadableCfcMetadataError,
        );
        expect(storedCfcMetadataAppliesToPath(tx, {
          space,
          id: id as URI,
          scope: "space",
          path: ["value", "secret"],
        })).toBe(true);
        tx.abort();
        return Promise.resolve();
      });
    });

    it("refuses a version-2 entry that is not entry-shaped", async () => {
      await withRuntime((runtime) => {
        const tx = runtime.edit();
        const id = parseLink(runtime.getCell(space, "v2-shape").getAsLink())
          .id!;
        writeSeedEnvelopeDoc(tx, space);
        tx.writeOrThrow({ space, scope: "space", id, path: [] }, {
          value: { secret: "sealed" },
          cfc: {
            version: 2,
            schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
            labelMap: {
              version: 1,
              entries: [{ path: ["secret"], label: "not-a-label" }],
            },
          },
        });
        expect(() => readStoredCfcMetadata(tx, { space, id })).toThrow(
          UnreadableCfcMetadataError,
        );
        expect(() =>
          cfcLabelViewForDereference(
            tx,
            { space, scope: "space", id, path: [] },
            { space, scope: "space", id, path: [] },
          )
        ).toThrow(UnreadableCfcMetadataError);
        tx.abort();
        return Promise.resolve();
      });
    });

    it("refuses a reference outside the cid: namespace", async () => {
      await withRuntime((runtime) => {
        const tx = runtime.edit();
        const id = parseLink(runtime.getCell(space, "foreign").getAsLink()).id!;
        writeSeedEnvelopeDoc(tx, space);
        tx.writeOrThrow({ space, scope: "space", id, path: [] }, {
          value: { secret: "sealed" },
          cfc: {
            version: 2,
            schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
            labelMap: {
              version: 1,
              entries: [{ path: ["secret"], label: { $ref: "of:not-a-cid" } }],
            },
          },
        });
        expect(() => readStoredCfcMetadata(tx, { space, id })).toThrow(
          "outside the cid: namespace",
        );
        tx.abort();
        return Promise.resolve();
      });
    });

    it("resolves through the realm registry a document the replica does not hold", async () => {
      await withRuntime((runtime) => {
        const content: IFCLabel = {
          confidentiality: ["registered-but-never-synced"],
        };
        const hash = cfcLabelDocumentHash(content);
        registerCfcLabelDocument(hash, content);
        const tx = runtime.edit();
        const id = writeReferencingEnvelope(runtime, tx, "registry", hash);
        const resolved = readStoredCfcMetadata(tx, { space, id });
        expect(resolved?.labelMap.entries[0].label).toEqual(content);
        tx.abort();
        return Promise.resolve();
      });
    });
  });
});
