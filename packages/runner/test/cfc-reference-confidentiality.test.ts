import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { cfcAtom } from "@commonfabric/api/cfc";
import { type FabricValue, hashStringOf } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";

import { normalizeClause } from "../src/cfc/clause.ts";
import { CFC_LABEL_READ_FAILED_ATOM } from "../src/cfc/observation.ts";
import { createSigilLinkFromParsedLink } from "../src/link-utils.ts";
import { deriveFlowJoin } from "../src/cfc/prepare.ts";
import type { CfcMetadata, LabelMapEntry } from "../src/cfc/types.ts";
import { Runtime } from "../src/runtime.ts";
import { sendValueToBinding } from "../src/pattern-binding.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("reference-confidentiality");
const space = signer.did();
const secret = normalizeClause({ anyOf: ["selection", cfcAtom.space(space)] });
const targetSecret = normalizeClause({
  anyOf: ["target", cfcAtom.space(space)],
});

describe("CFC reference confidentiality", () => {
  let storage: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storage = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager: storage,
      cfcFlowLabels: "persist",
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storage.close();
  });

  const seed = async (
    cause: string,
    value: FabricValue,
    entries: LabelMapEntry[] = [],
  ) => {
    const tx = runtime.edit();
    const cell = runtime.getCell(space, cause, undefined, tx);
    const link = cell.getAsNormalizedFullLink();
    writeSeedEnvelopeDoc(tx, space);
    tx.writeOrThrow({ ...link, path: [] }, {
      value,
      cfc: {
        version: 2,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: { version: 1, entries },
      },
    });
    expect((await tx.commit()).ok).toBeDefined();
    return cell.withTx(undefined);
  };

  const metadata = (cell: ReturnType<Runtime["getCell"]>): CfcMetadata => {
    const tx = runtime.edit();
    const value = tx.readOrThrow({
      ...cell.getAsNormalizedFullLink(),
      path: ["cfc"],
    });
    tx.abort();
    return value as CfcMetadata;
  };

  it("retains selection confidentiality when dereferencing a public constant", async () => {
    const target = await seed("public-target", "public constant");
    const selected = await seed("selected-reference", target.getAsLink(), [{
      path: [],
      label: { confidentiality: [secret] },
      origin: "link",
      observes: "followRef",
    }]);
    const tx = runtime.edit();
    expect(selected.withTx(tx).get()).toBe("public constant");
    expect(deriveFlowJoin(tx).confidentiality).toContainEqual(secret);
    tx.abort();
  });

  it("retains selection confidentiality through a shaped scalar read", async () => {
    const target = await seed("shaped-target", "public constant");
    const selected = await seed("shaped-reference", target.getAsLink(), [{
      path: [],
      origin: "link",
      observes: "followRef",
      label: { confidentiality: [secret] },
    }]);
    const tx = runtime.edit();
    expect(selected.withTx(tx).asSchema({ type: "string" }).get())
      .toBe("public constant");
    expect(deriveFlowJoin(tx).confidentiality).toContainEqual(secret);
    tx.abort();
  });

  it("retains acquired selection on a scope-narrowing redirect", async () => {
    const target = await seed("scoped-target", "public constant");
    const selected = await seed("scoped-reference", target.getAsLink(), [{
      path: [],
      origin: "link",
      observes: "followRef",
      label: { confidentiality: [secret] },
    }]);
    const acquire = runtime.edit();
    const held = selected.withTx(acquire).resolveAsCell();
    acquire.abort();
    const tx = runtime.edit();
    const output = runtime.getCell(space, "scoped-output", undefined, tx);
    sendValueToBinding(
      tx,
      output,
      undefined,
      output.getAsWriteRedirectLink(),
      held,
      { narrowestReadScope: "user" },
    );
    tx.prepareCfc();
    expect((await tx.commit()).error).toBeUndefined();
    expect(
      metadata(output).labelMap.entries.filter((entry) =>
        entry.origin === "link" && entry.observes === "followRef"
      ).flatMap((entry) => entry.label.confidentiality ?? []),
    )
      .toContainEqual(secret);
  });

  it("retains argument selection when an alias narrows its write scope", async () => {
    const target = await seed("argument-target", "public constant");
    const selected = await seed("argument-reference", target.getAsLink(), [{
      path: [],
      origin: "link",
      observes: "followRef",
      label: { confidentiality: [secret] },
    }]);
    const acquire = runtime.edit();
    const held = selected.withTx(acquire).resolveAsCell()
      .getAsNormalizedFullLink();
    acquire.abort();
    const tx = runtime.edit();
    const output = runtime.getCell(space, "alias-output", undefined, tx);
    sendValueToBinding(
      tx,
      output,
      held,
      { $alias: { cell: "argument", path: [] } },
      "new public",
      { narrowestReadScope: "user" },
    );
    tx.prepareCfc();
    expect((await tx.commit()).error).toBeUndefined();
    expect(
      metadata(target).labelMap.entries.filter((entry) =>
        entry.origin === "link" && entry.observes === "followRef"
      ).flatMap((entry) => entry.label.confidentiality ?? []),
    ).toContainEqual(secret);
  });

  it("retains immutable references when a transaction strengthens flow persistence", async () => {
    const target = await seed("strengthened-target", "public constant");
    const selected = await seed("strengthened-reference", target.getAsLink(), [{
      path: [],
      origin: "link",
      observes: "followRef",
      label: { confidentiality: [secret] },
    }]);
    const acquire = runtime.edit();
    const held = selected.withTx(acquire).resolveAsCell();
    acquire.abort();
    const writer = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager: storage,
      cfcFlowLabels: "off",
    });
    try {
      const tx = writer.edit();
      tx.setCfcFlowLabelsMode("persist");
      const literal = writer.getImmutableCell(
        space,
        { selected: held },
        undefined,
        tx,
      );
      const output = writer.getCell(
        space,
        "strengthened-output",
        undefined,
        tx,
      );
      output.set(literal.getAsLink({ base: output }));
      tx.prepareCfc();
      expect((await tx.commit()).error).toBeUndefined();
      expect(
        metadata(output).labelMap.entries.filter((entry) =>
          entry.origin === "link" && entry.path.at(-1) === "selected"
        ).flatMap((entry) => entry.label.confidentiality ?? []),
      ).toContainEqual(secret);
    } finally {
      await writer.dispose();
    }
  });

  it("keeps an independently acquired reference free of target content labels", async () => {
    const target = await seed("confidential-target", { item: "secret" }, [{
      path: ["item"],
      label: { confidentiality: [targetSecret] },
    }]);
    const tx = runtime.edit();
    const output = runtime.getCell(
      space,
      "public-reference-output",
      undefined,
      tx,
    );
    output.set(target.withTx(tx));
    tx.prepareCfc();
    expect((await tx.commit()).ok).toBeDefined();
    const entries = metadata(output).labelMap.entries;
    expect(entries.flatMap((entry) => entry.label.confidentiality ?? []))
      .not.toContainEqual(targetSecret);
    expect(
      entries.filter((entry) => entry.origin === "link").map((entry) =>
        entry.path
      ),
    )
      .toEqual([[]]);
    const read = runtime.edit();
    expect(output.withTx(read).key("item").get()).toBe("secret");
    expect(deriveFlowJoin(read).confidentiality).toContainEqual(targetSecret);
    read.abort();
  });

  it("keeps reference-only write work constant as target labels grow", async () => {
    const measure = async (descendants: number, declared = false) => {
      const fields = Array.from(
        { length: descendants },
        (_, index) => `item-${index}`,
      );
      const target = await seed(
        `scaling-target-${declared}-${descendants}`,
        {
          items: Object.fromEntries(fields.map((field) => [field, "private"])),
        },
        fields.map((field) => ({
          path: ["items", field],
          label: { confidentiality: [targetSecret] },
        })),
      );
      const targetLink = target.getAsNormalizedFullLink();
      const targetDigest = () => {
        const audit = runtime.edit();
        const digest = hashStringOf(
          audit.readOrThrow({ ...targetLink, path: [] }),
        );
        audit.abort();
        return digest;
      };
      const before = targetDigest();
      const tx = runtime.edit();
      const output = runtime.getCell(
        space,
        `scaling-output-${declared}-${descendants}`,
        declared
          ? { type: "object", ifc: { confidentiality: [secret] } }
          : undefined,
        tx,
      );
      output.set(target.withTx(tx));
      tx.prepareCfc();
      expect(tx.getReadActivities).toBeDefined();
      const reads = [...tx.getReadActivities!()];
      expect(reads.length).toBeGreaterThan(0);
      expect(reads.filter((read) => read.id === targetLink.id)).toEqual([]);
      expect((await tx.commit()).ok).toBeDefined();
      expect(targetDigest()).toBe(before);
      const entries = metadata(output).labelMap.entries;
      expect(
        entries.filter((entry) => entry.origin === "link").map((entry) =>
          entry.path
        ),
      )
        .toEqual([[]]);
      expect(entries.flatMap((entry) => entry.label.confidentiality ?? []))
        .not.toContainEqual(targetSecret);
      return { readCount: reads.length, entryCount: entries.length };
    };

    for (const declared of [false, true]) {
      const empty = await measure(0, declared);
      const populated = await measure(512, declared);
      expect(populated).toEqual(empty);
    }
  });

  it("persists the private selector on a reference to an unlabeled target", async () => {
    const left = await seed("left", "left");
    const right = await seed("right", "right");
    const selector = await seed("selector", true, [{
      path: [],
      label: { confidentiality: [secret] },
    }]);
    const tx = runtime.edit();
    const chosen = selector.withTx(tx).get() ? left : right;
    const output = runtime.getCell(
      space,
      "private-reference-output",
      undefined,
      tx,
    );
    output.set(chosen.withTx(tx));
    tx.prepareCfc();
    expect((await tx.commit()).ok).toBeDefined();
    expect(
      metadata(output).labelMap.entries.flatMap((entry) =>
        entry.label.confidentiality ?? []
      ),
    )
      .toContainEqual(secret);
    const read = runtime.edit();
    expect(output.withTx(read).get()).toBe("left");
    expect(deriveFlowJoin(read).confidentiality).toContainEqual(secret);
    read.abort();
  });

  it("checks strict writer fit for a selected bare reference", async () => {
    const target = await seed("fit-public-target", "public");
    const selector = await seed("fit-selector", true, [{
      path: [],
      label: { confidentiality: ["secret"] },
    }]);
    for (const path of [[], ["selected"]]) {
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-strict");
      expect(selector.withTx(tx).get()).toBe(true);
      const output = runtime.getCell(
        space,
        `fit-output-${path.length}`,
        undefined,
        tx,
      );
      const slot = path.length === 0 ? output : output.key("selected");
      slot.set(target.withTx(tx));
      tx.prepareCfc();
      expect((await tx.commit()).error?.message).toContain(
        "writer-fit confidentiality misfit",
      );
    }
  });

  it("checks held reference restrictions when forwarding a serialized carrier", async () => {
    const target = await seed("held-fit-target", "public");
    const selected = await seed("held-fit-selection", target.getAsLink(), [{
      path: [],
      origin: "link",
      observes: "followRef",
      label: { confidentiality: ["secret"] },
    }]);
    const acquire = runtime.edit();
    const held = selected.withTx(acquire).resolveAsCell().getAsLink();
    acquire.abort();
    const tx = runtime.edit();
    tx.setCfcEnforcementMode("enforce-strict");
    runtime.getCell(space, "held-fit-output", undefined, tx).set(held);
    tx.prepareCfc();
    expect((await tx.commit()).error?.message).toContain(
      "writer-fit confidentiality misfit",
    );
  });

  it("does not authenticate a raw reference because its target was just written", async () => {
    const tx = runtime.edit();
    const target = runtime.getCell(space, "raw-created-target", undefined, tx);
    target.set("public");
    const raw = createSigilLinkFromParsedLink(target.getAsNormalizedFullLink());
    runtime.getCell(space, "raw-created-output", undefined, tx).set(raw);
    tx.prepareCfc();
    expect((await tx.commit()).error?.message).toContain(
      "reference acquisition is unresolved",
    );
  });

  it("marks unresolved references admitted by diagnostics as unavailable evidence", async () => {
    await runtime.dispose();
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager: storage,
      cfcFlowLabels: "persist",
      cfcEnforcementMode: "observe",
    });
    const target = await seed("diagnostic-target", "public");
    const write = runtime.edit();
    const output = runtime.getCell(
      space,
      "diagnostic-output",
      undefined,
      write,
    );
    output.set(createSigilLinkFromParsedLink(target.getAsNormalizedFullLink()));
    write.prepareCfc();
    expect((await write.commit()).error).toBeUndefined();
    expect(
      metadata(output).labelMap.entries.flatMap((entry) =>
        entry.label.confidentiality ?? []
      ),
    ).toContain(CFC_LABEL_READ_FAILED_ATOM);
    const read = runtime.edit();
    read.setCfcEnforcementMode("enforce-strict");
    expect(output.withTx(read).get()).toBe("public");
    expect(deriveFlowJoin(read).confidentiality).toContain(
      CFC_LABEL_READ_FAILED_ATOM,
    );
    runtime.getCell(space, "diagnostic-forward", undefined, read).set(
      "observed",
    );
    read.prepareCfc();
    expect((await read.commit()).error?.message).toContain(
      "writer-fit confidentiality misfit",
    );
  });

  it("accumulates reference restrictions through multiple hops", async () => {
    const target = await seed("chain-value", "public");
    const inner = await seed("chain-inner", target.getAsLink(), [{
      path: [],
      label: { confidentiality: [targetSecret] },
      origin: "link",
      observes: "followRef",
    }]);
    const outer = await seed("chain-outer", inner.getAsLink(), [{
      path: [],
      label: { confidentiality: [secret] },
      origin: "link",
      observes: "followRef",
    }]);
    const tx = runtime.edit();
    expect(outer.withTx(tx).get()).toBe("public");
    const flow = deriveFlowJoin(tx).confidentiality;
    expect(flow).toContainEqual(secret);
    expect(flow).toContainEqual(targetSecret);
    tx.abort();
  });
});
