/**
 * What a read that obtains a reference consumes. CFC
 * `04-label-representation.md` §4.6.3 puts a standalone reference-identity
 * read — observing which reference sits at a slot, without dereferencing it —
 * on the pointer's own label alone, and never on the content-class labels at
 * that path. §8.11.4 classes a schema `ifc` annotation as a content clause, so
 * the confidentiality a reference position declares is one of the labels such
 * a read leaves alone.
 *
 * Two places in the runtime obtain a reference without dereferencing it:
 * `readMaybeLink` in `link-resolution.ts`, which mints a cell handle at an
 * `asCell` position, and the write-redirect chain walk in
 * `pattern-binding.ts`, which asks whether a redirect target holds a further
 * redirect.
 *
 * The last block states the limit of that. A confidentiality declared at a
 * reference position is stored on the referring document, so a transaction
 * that follows the reference and reads the value picks it up from there; on a
 * target document whose own label map is empty, that entry is the only place
 * it is written down. The hop read inside `resolveLinkTracingDereferences` is
 * a step of that dereference rather than a standalone observation, and is what
 * consumes the entry.
 */

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";

import { cfcAtom } from "@commonfabric/api/cfc";
import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";

import {
  SEED_ENVELOPE_SCHEMA_HASH,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import type { LabelMapEntry } from "../src/cfc/types.ts";
import { readMaybeLink, resolveLink } from "../src/link-resolution.ts";
import {
  createSigilLinkFromParsedLink,
  type NormalizedFullLink,
} from "../src/link-utils.ts";
import { findAllWriteRedirectCells } from "../src/pattern-binding.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("runner-cfc-reference-identity");
const space = signer.did();

describe("cfc-reference-identity-reads", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  const makeRuntime = () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      // Every assertion below reads the flow stamp out of the replica, so it
      // has to be persisted rather than measured.
      cfcFlowLabels: "persist",
    });
    return runtime;
  };

  // A seeded confidentiality clause naming a synthetic audience beside the
  // space these documents live in, so a transaction carrying the join can
  // still write an output document that declares no policy of its own.
  const audience = (tag: string) => ({ anyOf: [tag, cfcAtom.space(space)] });

  // The synthetic audience each clause of a join names, in the join's order.
  const tagsOf = (join: readonly unknown[] | undefined): string[] | undefined =>
    join?.map((clause) =>
      ((clause as { anyOf: unknown[] }).anyOf.find((alternative) =>
        typeof alternative === "string"
      )) as string
    );

  const contentEntry = (path: string[], tag: string): LabelMapEntry => ({
    path,
    label: { confidentiality: [audience(tag)] },
  });

  const pointerEntry = (path: string[], tag: string): LabelMapEntry => ({
    path,
    label: { confidentiality: [audience(tag)] },
    origin: "link",
  });

  // One seeding transaction: `write` installs a document with its stored label
  // map and returns its link, so a later seeded value can hold a link to an
  // earlier one.
  const seeding = (rt: Runtime) => {
    const tx = rt.edit();
    writeSeedEnvelopeDoc(tx, space);
    const write = (
      cause: string,
      value: FabricValue,
      entries: LabelMapEntry[] = [],
    ): NormalizedFullLink => {
      const link = rt.getCell(space, cause, undefined, tx)
        .getAsNormalizedFullLink();
      tx.writeOrThrow({ space, scope: "space", id: link.id, path: [] }, {
        value,
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: { version: 1, entries },
        },
      });
      return link;
    };
    const commit = async () => {
      expect((await tx.commit()).ok).toBeDefined();
    };
    return { write, commit };
  };

  type StoredDocument = {
    value?: unknown;
    cfc?: {
      labelMap?: {
        entries: { origin?: string; label: { confidentiality?: unknown[] } }[];
      };
    };
  } | undefined;

  const derivedConfidentiality = (id: string): unknown[] | undefined =>
    ((storageManager!.open(space).replica as unknown as {
      getDocument(id: string): StoredDocument;
    }).getDocument(id))?.cfc?.labelMap?.entries
      ?.find((entry) => entry.origin === "derived")?.label.confidentiality;

  // Runs `observe` in a transaction that also writes an output document, then
  // commits and returns the audiences the output's flow stamp names.
  const flowJoinOf = async (
    rt: Runtime,
    outCause: string,
    observe: (tx: IExtendedStorageTransaction) => void,
  ): Promise<string[] | undefined> => {
    const tx = rt.edit();
    observe(tx);
    const out = rt.getCell(space, outCause, undefined, tx);
    out.set({ copied: true });
    tx.prepareCfc();
    expect((await tx.commit()).ok).toBeDefined();
    return tagsOf(derivedConfidentiality(out.getAsNormalizedFullLink().id));
  };

  describe("readMaybeLink()", () => {
    // The one-step hop `schema.ts` takes to mint a cell handle at an `asCell`
    // position: it obtains the reference stored there and follows nothing.

    const seedHolder = async (rt: Runtime, entries: LabelMapEntry[]) => {
      const seed = seeding(rt);
      const holder = seed.write(
        "rir-holder",
        {
          ref: createSigilLinkFromParsedLink(
            seed.write("rir-target", "s3cr3t"),
          ),
        },
        entries,
      );
      await seed.commit();
      return holder;
    };

    it("leaves a content label at the reference position out of the flow join", async () => {
      const rt = makeRuntime();
      const holder = await seedHolder(rt, [
        contentEntry(["ref"], "declared-at-reference"),
      ]);
      const join = await flowJoinOf(rt, "rir-handle-out", (tx) => {
        expect(readMaybeLink(tx, { ...holder, path: ["ref"] }))
          .toBeDefined();
      });
      expect(join).toBeUndefined();
    });

    it("joins the pointer's own label at the reference position into the flow join", async () => {
      const rt = makeRuntime();
      const holder = await seedHolder(rt, [
        pointerEntry(["ref"], "pointer-label"),
      ]);
      const join = await flowJoinOf(rt, "rir-pointer-out", (tx) => {
        expect(readMaybeLink(tx, { ...holder, path: ["ref"] }))
          .toBeDefined();
      });
      expect(join).toEqual(["pointer-label"]);
    });
  });

  describe("findAllWriteRedirectCells()", () => {
    // The write-redirect chain walk asks whether the target of a redirect
    // holds a further redirect, which is a question about which reference
    // sits there.

    const seedChain = async (rt: Runtime, entries: LabelMapEntry[]) => {
      const seed = seeding(rt);
      const last = seed.write("rir-chain-last", 7);
      const middle = seed.write(
        "rir-chain-middle",
        createSigilLinkFromParsedLink({ ...last, overwrite: "redirect" }),
        entries,
      );
      await seed.commit();
      return { middle, last };
    };

    it("leaves a content label at a redirect target out of the flow join", async () => {
      const rt = makeRuntime();
      const { middle } = await seedChain(rt, [
        contentEntry([], "chain-content"),
      ]);
      const join = await flowJoinOf(rt, "rir-chain-out", (tx) => {
        const base = rt.getCell(space, "rir-chain-base", undefined, tx);
        findAllWriteRedirectCells(
          createSigilLinkFromParsedLink({ ...middle, overwrite: "redirect" }),
          base,
        );
      });
      expect(join).toBeUndefined();
    });

    it("joins the pointer's own label at a redirect target into the flow join", async () => {
      const rt = makeRuntime();
      const { middle } = await seedChain(rt, [
        pointerEntry([], "chain-pointer"),
      ]);
      const join = await flowJoinOf(rt, "rir-chain-pointer-out", (tx) => {
        const base = rt.getCell(space, "rir-chain-base", undefined, tx);
        findAllWriteRedirectCells(
          createSigilLinkFromParsedLink({ ...middle, overwrite: "redirect" }),
          base,
        );
      });
      expect(join).toEqual(["chain-pointer"]);
    });

    it("returns every link on the redirect chain", async () => {
      const rt = makeRuntime();
      const { middle, last } = await seedChain(rt, []);
      const tx = rt.edit();
      const base = rt.getCell(space, "rir-chain-base", undefined, tx);
      const found = findAllWriteRedirectCells(
        createSigilLinkFromParsedLink({ ...middle, overwrite: "redirect" }),
        base,
      );
      expect(found.map((link) => link.id)).toEqual([middle.id, last.id]);
      await tx.commit();
    });
  });

  describe("reading the value through a reference", () => {
    // What the classification above must not cost: the confidentiality a
    // reference position declares still reaches a transaction that
    // dereferences the reference and reads the value, on a target document
    // whose own label map is empty.

    it("joins a content label declared at the reference position into the flow join", async () => {
      const rt = makeRuntime();
      const seed = seeding(rt);
      const target = seed.write("rir-read-target", "s3cr3t");
      const holder = seed.write(
        "rir-read-holder",
        { ref: createSigilLinkFromParsedLink(target) },
        [contentEntry(["ref"], "declared-at-reference")],
      );
      await seed.commit();

      const join = await flowJoinOf(rt, "rir-read-out", (tx) => {
        const resolved = resolveLink(rt, tx, { ...holder, path: ["ref"] });
        expect(tx.readValueOrThrow(resolved)).toEqual("s3cr3t");
      });
      expect(join).toEqual(["declared-at-reference"]);
    });

    it("joins the target document's own content label into the flow join", async () => {
      const rt = makeRuntime();
      const seed = seeding(rt);
      const target = seed.write("rir-target-labeled", "s3cr3t", [
        contentEntry([], "declared-on-target"),
      ]);
      const holder = seed.write(
        "rir-holder-bare",
        { ref: createSigilLinkFromParsedLink(target) },
      );
      await seed.commit();

      const join = await flowJoinOf(rt, "rir-target-out", (tx) => {
        const resolved = resolveLink(rt, tx, { ...holder, path: ["ref"] });
        expect(tx.readValueOrThrow(resolved)).toEqual("s3cr3t");
      });
      expect(join).toEqual(["declared-on-target"]);
    });
  });
});
