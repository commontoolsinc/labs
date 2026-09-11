import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { cfcAtom } from "@commonfabric/api/cfc";
import { cloneIfNecessary, type FabricValue } from "@commonfabric/data-model";
import {
  linkRefPayload,
  resetModernCellRepConfig,
  setModernCellRepConfig,
} from "@commonfabric/data-model/cell-rep";
import { valueFromDataUri } from "@commonfabric/data-model/codec-data-uri";
import {
  FabricError,
  FabricLink,
} from "@commonfabric/data-model/fabric-instances";
import { Identity } from "@commonfabric/identity";

import { type Cell, convertCellsToLinks, isCell } from "../src/cell.ts";
import { ifElse as runtimeIfElse } from "../src/builtins/if-else.ts";
import {
  llmDialogTestHelpers,
  llmToolExecutionHelpers,
} from "../src/builtins/llm-dialog.ts";
import { normalizeClause } from "../src/cfc/clause.ts";
import {
  mergeCfcLabelViews,
  redactCaveatSourcesForDisplay,
} from "../src/cfc/label-view-core.ts";
import { getCarriedCfcLabelView } from "../src/cfc/label-view-state.ts";
import { cfcLabelViewForCell } from "../src/cfc/label-view.ts";
import { cfcConfidentialityForObservationNode } from "../src/cfc/observation.ts";
import { deriveFlowJoin } from "../src/cfc/prepare.ts";
import {
  carryCfcReferenceProvenance,
  getCfcReferenceProvenance,
  withCfcReferenceConfidentiality,
} from "../src/cfc/reference-provenance.ts";
import {
  type LabelMapEntry,
  runtimeWritePolicyAuthorization,
} from "../src/cfc/types.ts";
import { getCellOrThrow } from "../src/query-result-proxy.ts";
import { createLLMFriendlyLink } from "../src/link-types.ts";
import { getMetaLink, parseLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import type { Pattern } from "../src/builder/types.ts";
import {
  createTrustedBuilder,
  trustExecutable,
} from "./support/trusted-builder.ts";
import { diffAndUpdate } from "../src/data-updating.ts";
import { findAndInlineDataUriLinks } from "../src/data-uri.ts";
import { unwrapOneLevelAndBindToDoc } from "../src/pattern-binding.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { createNonReactiveTransaction } from "../src/storage/extended-storage-transaction.ts";
import {
  authorizationRead,
  isAuthorizationRead,
  withAuthorizationReadBasis,
} from "../src/storage/reactivity-log.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("cfc-reference-provenance");
const space = signer.did();
const selection = normalizeClause({
  anyOf: ["selection", cfcAtom.space(space)],
});
const content = normalizeClause({ anyOf: ["content", cfcAtom.space(space)] });

describe("cfc-reference-provenance", () => {
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
    resetModernCellRepConfig();
    await storage.synced();
    await runtime.dispose();
    await storage.close();
  });

  const seed = async (
    cause: string,
    value: FabricValue,
    entries: LabelMapEntry[] = [],
    version: 1 | 2 = 2,
  ) => {
    const tx = runtime.edit();
    const cell = runtime.getCell(space, cause, undefined, tx);
    writeSeedEnvelopeDoc(tx, space);
    tx.writeOrThrow({ ...cell.getAsNormalizedFullLink(), path: [] }, {
      value,
      cfc: {
        version,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: { version: 1, entries },
      },
    });
    expect((await tx.commit()).ok).toBeDefined();
    return cell.withTx(undefined);
  };

  const selectedTarget = async () => {
    const target = await seed(
      "target",
      { public: "visible", secret: "hidden" },
      [{
        path: ["secret"],
        observes: "value",
        label: { confidentiality: [content] },
      }],
    );
    const selected = await seed("selected", target.getAsLink(), [{
      path: [],
      observes: "followRef",
      origin: "link",
      label: { confidentiality: [selection] },
    }]);
    return { target, selected };
  };

  it("requires verifier authorization and retains its reads through a sampled transaction", async () => {
    const { target, selected } = await selectedTarget();
    const tx = runtime.edit();
    const sampled = createNonReactiveTransaction(tx);
    const source = selected.getAsNormalizedFullLink();
    expect(sampled.acquireCfcReference(source)).toBeUndefined();
    expect(sampled.resolveCfcContentTarget(source, space)).toBeUndefined();
    expect(() => withAuthorizationReadBasis(authorizationRead, undefined))
      .toThrow("Authorization read has no commit revision basis");
    expect([...tx.getReadActivities!()]).toHaveLength(0);
    const pending = runtime.getCell(
      space,
      "pending-sampled-reference",
      undefined,
      sampled,
    );
    pending.set(target.withTx(sampled));
    const acquired = sampled.acquireCfcReference(
      pending.getAsNormalizedFullLink(),
      undefined,
      runtimeWritePolicyAuthorization,
    );
    expect(acquired?.binding).toMatchObject(target.getAsNormalizedFullLink());
    expect(acquired?.confidentiality).toEqual([]);
    const resolved = sampled.resolveCfcContentTarget(
      source,
      space,
      runtimeWritePolicyAuthorization,
    );
    expect(resolved?.address).toMatchObject(target.getAsNormalizedFullLink());
    expect(resolved?.value).toEqual({ public: "visible", secret: "hidden" });
    expect(
      [...tx.getReadActivities!()].some((read) =>
        isAuthorizationRead(read.meta)
      ),
    )
      .toBe(true);
    expect(deriveFlowJoin(tx).confidentiality).toEqual([]);
    const output = runtime.getCell(
      space,
      "sampled-write-author",
      undefined,
      sampled,
    );
    output.set("authored value");
    expect(sampled.getCfcValueWriteAuthor(output.getAsNormalizedFullLink()))
      .toEqual({ identity: undefined });
    tx.abort();
  });

  it("invalidates preparation when a private reference is observed afterward", async () => {
    const { selected } = await selectedTarget();
    const acquire = runtime.edit();
    const held = selected.withTx(acquire).resolveAsCell().withTx(undefined);
    acquire.abort();
    const tx = runtime.edit();
    const output = runtime.getCell(
      space,
      "late-reference-observation",
      undefined,
      tx,
    );
    output.set("value");
    const digest = tx.prepareCfc();
    expect(tx.getCfcState().prepare.status).toBe("prepared");
    tx.recordCfcReferenceObservation({
      target: held.getAsNormalizedFullLink(),
      confidentiality: [],
      purpose: "identity",
      journalIndex: tx.currentActivityIndex!()!,
    });
    expect(tx.getCfcState().prepare.status).toBe("prepared");
    held.withTx(tx).getAsLink();
    expect(tx.getCfcState().prepare.status).not.toBe("prepared");
    expect(deriveFlowJoin(tx).confidentiality).toContainEqual(selection);
    expect(tx.prepareCfc()).not.toBe(digest);
    tx.abort();
  });

  for (const useActivityClock of [false, true]) {
    for (const observeFirst of [false, true]) {
      it(`checks private reference observations against a protected write's prefix (observeFirst=${observeFirst}, useActivityClock=${useActivityClock})`, async () => {
        const { selected } = await selectedTarget();
        const acquire = runtime.edit();
        const held = selected.withTx(acquire).resolveAsCell().withTx(undefined);
        acquire.abort();
        const inner = runtime.edit();
        const tx = useActivityClock ? inner : new Proxy(inner, {
          get(target, property) {
            if (property === "currentActivityIndex") return undefined;
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        const output = runtime.getCell(space, "reference-gated-write", {
          type: "string",
          ifc: { maxConfidentiality: [] },
        }, tx);
        if (observeFirst) held.withTx(tx).getAsLink();
        output.set("result");
        if (!observeFirst) held.withTx(tx).getAsLink();
        const result = await tx.commit();
        if (observeFirst) {
          expect(result.error?.message).toContain("maxConfidentiality");
        } else {
          expect(result.error).toBeUndefined();
        }
      });
    }
  }

  describe("external input acquisition", () => {
    it("acquires an explicit address without importing the target's confidentiality", async () => {
      const { target } = await selectedTarget();
      const raw = cloneIfNecessary(target.getAsLink(), { frozen: false });
      const acquired = runtime.acquireExternalInput(space, { item: raw }) as {
        item: unknown;
      };
      expect(getCfcReferenceProvenance(raw)).toBeUndefined();
      expect(getCfcReferenceProvenance(acquired.item)?.confidentiality).toEqual(
        [],
      );

      const read = runtime.edit();
      const input = runtime.getImmutableCell(space, acquired, undefined, read);
      expect(input.key("item").key("secret").get()).toBe("hidden");
      expect(deriveFlowJoin(read).confidentiality).toContainEqual(content);
      read.abort();
    });

    it("retains an existing carrier's private selection history", async () => {
      const { selected } = await selectedTarget();
      const held = selected.resolveAsCell();
      const acquired = runtime.acquireExternalInput(space, {
        cell: held,
        link: held.getAsLink(),
      }) as { cell: unknown; link: unknown };
      for (const value of [acquired.cell, acquired.link]) {
        expect(getCfcReferenceProvenance(value)?.confidentiality)
          .toContainEqual(selection);
      }
    });

    it("acquires a missing target without probing its existence", () => {
      const acquired = runtime.acquireExternalInput(space, {
        item: { "/": { "link@1": { id: "of:missing-external-target" } } },
      }) as { item: unknown };
      expect(getCfcReferenceProvenance(acquired.item)?.binding).toEqual({
        space,
        id: "of:missing-external-target",
        scope: "space",
        path: [],
      });
    });

    it("refuses a relative external reference with no authenticated source", () => {
      expect(() =>
        runtime.acquireExternalInput(space, {
          item: { "/": { "link@1": { path: ["value"] } } },
        })
      ).toThrow("An external reference must name a document");
    });
  });

  for (const method of ["push", "addUnique"] as const) {
    it(`keeps an unchanged private prefix outside ${method} reference writes`, async () => {
      const target = await seed(`prefix-target-${method}`, "old item");
      const list = (await seed(`prefix-list-${method}`, [target.getAsLink()], [{
        path: ["0"],
        origin: "link",
        observes: "followRef",
        label: { confidentiality: [selection] },
      }])).asSchema({ type: "array", items: {} });
      const append = runtime.edit();
      list.withTx(append)[method]("new item");
      expect(
        append.getCfcState().writePolicyInputs.filter((input) =>
          input.kind === "link-write"
        ),
      ).toEqual([]);
      expect((await append.commit()).ok).toBeDefined();

      const read = runtime.edit();
      try {
        const held = list.withTx(read).key("0").resolveAsCell();
        expect(getCfcReferenceProvenance(held)?.confidentiality).toContainEqual(
          selection,
        );
        expect(list.withTx(read).key("1").get()).toBe("new item");
      } finally {
        read.abort();
      }

      const newTarget = await seed(`unproven-tail-${method}`, "unproven item");
      const unprovenTail = runtime.edit();
      list.withTx(unprovenTail)[method](
        JSON.parse(JSON.stringify(newTarget.getAsLink())),
      );
      expect((await unprovenTail.commit()).error?.message).toContain(
        "reference acquisition is unresolved",
      );

      const explicit = runtime.edit();
      const raw = JSON.parse(JSON.stringify(target.getAsLink()));
      list.withTx(explicit).set([raw, "new item"]);
      expect(
        explicit.getCfcState().writePolicyInputs.some((input) =>
          input.kind === "link-write" && input.reference === undefined
        ),
      ).toBe(true);
      expect((await explicit.commit()).error?.message).toContain(
        "reference acquisition is unresolved",
      );

      const secret = await seed(`prefix-reselection-${method}`, true, [{
        path: [],
        label: { confidentiality: [content] },
      }]);
      const reselect = runtime.edit();
      secret.withTx(reselect).get();
      const held = list.withTx(reselect).key("0").resolveAsCell();
      list.withTx(reselect).set([held, "new item"]);
      expect((await reselect.commit()).ok).toBeDefined();
      const carried = getCfcReferenceProvenance(list.key("0").resolveAsCell());
      expect(carried?.confidentiality).toContainEqual(selection);
      expect(carried?.confidentiality).toContainEqual(content);
    });

    it(`retains provenance when a handler uses ${method} twice with newly instantiated patterns`, async () => {
      const { pattern, handler } = createTrustedBuilder(runtime).commonfabric;
      const itemSchema = {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      } as const;
      const inputSchema = {
        type: "object",
        properties: {
          list: {
            type: "array",
            items: itemSchema,
            default: [],
            asCell: ["cell"],
          },
        },
        required: ["list"],
      } as const;
      const outputSchema = {
        type: "object",
        properties: {
          list: { type: "array", items: itemSchema, asCell: ["cell"] },
          add: { ...itemSchema, asCell: ["stream"] },
        },
        required: ["list", "add"],
      } as const;
      const inner = pattern(({ text }) => ({ text }), itemSchema, itemSchema);
      const add = handler(itemSchema, inputSchema, ({ text }, { list }) => {
        list[method](inner({ text }));
      });
      const outer = pattern(
        ({ list }) => ({ list, add: add({ list }) }),
        inputSchema,
        outputSchema,
      );
      const write = runtime.edit();
      const result = runtime.getCell(
        space,
        "handler-instantiated-reference",
        outputSchema,
        write,
      );
      runtime.run(write, outer, {}, result);
      expect((await write.commit()).ok).toBeDefined();
      await result.pull();
      for (const text of ["first item", "second item"]) {
        const event = runtime.edit();
        result.withTx(event).key("add").send({ text });
        expect((await event.commit()).ok).toBeDefined();
        await result.pull();
      }
      expect(result.key("list").get().get()).toEqual([
        { text: "first item" },
        { text: "second item" },
      ]);
    });
  }

  it("keeps an opaque schema handle before deeper write redirects", async () => {
    const target = await seed("opaque-deep-target", "unread");
    const legacy = await seed(
      "opaque-legacy-hop",
      target.getAsWriteRedirectLink(),
      [],
      1,
    );
    const redirect = await seed(
      "opaque-first-hop",
      legacy.getAsWriteRedirectLink(),
      [{
        path: [],
        origin: "link",
        observes: "followRef",
        label: {},
      }],
    );
    const creation = runtime.edit();
    const inputs = runtime.getImmutableCell(
      space,
      {
        branch: redirect.withTx(creation).getAsWriteRedirectLink(),
      },
      undefined,
      creation,
    );
    creation.abort();
    const read = runtime.edit();
    try {
      const projected = inputs.withTx(read).asSchema({
        type: "object",
        properties: { branch: { type: "unknown", asCell: ["opaque"] } },
      }).get({ traverseCells: true });
      const opaque: unknown = projected.branch;
      if (!isCell(opaque)) throw new Error("Expected an opaque Cell");
      expect(opaque.getAsNormalizedFullLink().id)
        .toBe(inputs.getAsNormalizedFullLink().id);
      expect(opaque.getAsNormalizedFullLink().path).toEqual([
        "branch",
      ]);
      expect(
        read.getCfcState().dereferenceTraces.some(({ source }) =>
          source.id === legacy.getAsNormalizedFullLink().id
        ),
      ).toBe(false);
      expect(() =>
        inputs.withTx(read).asSchema({
          type: "object",
          properties: { branch: { type: "string", asCell: ["readonly"] } },
        }).get({ traverseCells: true })
      ).toThrow("Reference acquisition lacks complete legacy provenance");
    } finally {
      read.abort();
    }
  });

  it("preserves selection through transaction rebinding and child projection", async () => {
    const { selected } = await selectedTarget();
    const acquire = runtime.edit();
    const resolved = selected.withTx(acquire).resolveAsCell();
    expect(getCfcReferenceProvenance(resolved)?.confidentiality).toEqual([
      selection,
    ]);
    acquire.abort();

    const tx = runtime.edit();
    const child = resolved.withTx(tx).key("public").asSchema({
      type: "string",
    });
    expect(child.get()).toBe("visible");
    expect(getCfcReferenceProvenance(child)?.confidentiality).toEqual([
      selection,
    ]);
    expect(deriveFlowJoin(tx).confidentiality).toContainEqual(selection);
    expect(deriveFlowJoin(tx).confidentiality).not.toContainEqual(content);
    tx.abort();
  });

  for (
    const [modern, lazy] of [
      [false, false],
      [false, true],
      [true, false],
      [true, true],
    ]
  ) {
    it(`retains nested references when ${lazy ? "lazy" : "eager"} schema reads box inline array objects with ${modern ? "modern" : "legacy"} links`, async () => {
      setModernCellRepConfig(modern);
      const { selected } = await selectedTarget();
      const acquisition = runtime.edit();
      const held = selected.withTx(acquisition).resolveAsCell().key("public");
      const list = runtime.getImmutableCell(
        space,
        [{ props: { label: held } }],
        undefined,
        acquisition,
      );
      acquisition.abort();

      const read = runtime.edit();
      if (lazy) read.markLazyMaterialize(true);
      const values = list.withTx(read).asSchema({
        type: "array",
        items: { type: "object", properties: { props: { type: "object" } } },
      }).get() as Array<{ props: { label: string } }>;
      expect(values[0].props.label).toBe("visible");
      expect(deriveFlowJoin(read).confidentiality).toContainEqual(selection);
      const heldItem = getCellOrThrow(values[0]);
      read.abort();
      const later = runtime.edit();
      expect(heldItem.withTx(later).key("props", "label").get()).toBe(
        "visible",
      );
      expect(deriveFlowJoin(later).confidentiality).toContainEqual(selection);
      later.abort();
    });
  }

  for (const lazy of [false, true]) {
    it(`retains inherited follow caps when ${lazy ? "lazy" : "eager"} schema reads box inline array objects`, async () => {
      const write = runtime.edit();
      const target = runtime.getCell(
        space,
        "schema-box-session",
        { type: "string" },
        write,
        "session",
      );
      target.set("session-only");
      expect((await write.commit()).ok).toBeDefined();
      const creation = runtime.edit();
      const list = runtime.getImmutableCell(
        space,
        [{ props: { label: target.withTx(creation) } }],
        undefined,
        creation,
      );
      creation.abort();
      const read = runtime.edit();
      if (lazy) read.markLazyMaterialize(true);
      const values = list.withTx(read).asSchema({ scope: "space" }).asSchema({
        type: "array",
        scope: "session",
        items: { type: "object", properties: { props: { type: "object" } } },
      }).get() as Array<{ props: { label: string } }>;
      const held = getCellOrThrow(values[0]);
      read.abort();
      const later = runtime.edit();
      expect(held.withTx(later).getAsNormalizedFullLink().scopeCaps)
        .toContainEqual({ depth: 0, scope: "space" });
      expect(
        held.withTx(later).asSchema({ scope: "session" })
          .getAsNormalizedFullLink().scopeCaps,
      )
        .toContainEqual({ depth: 0, scope: "space" });
      later.abort();
    });
  }

  it("retains nested immutable reference history through rebinding and projection", async () => {
    const { selected } = await selectedTarget();
    const acquisition = runtime.edit();
    const held = selected.withTx(acquisition).resolveAsCell().key("public");
    const literal = runtime.getImmutableCell(
      space,
      { candidates: [held.getAsLink()] },
      undefined,
      acquisition,
    );
    acquisition.abort();

    const tx = runtime.edit();
    const rebound = literal.withTx(tx).asSchema({});
    const raw = rebound.getRawUntyped() as { candidates: FabricValue[] };
    expect(getCfcReferenceProvenance(raw.candidates[0])?.confidentiality)
      .toContainEqual(selection);
    expect(getCfcReferenceProvenance(raw.candidates[0])?.confidentiality)
      .not.toContainEqual(content);
    expect(rebound.key("candidates", "0").resolveAsCell().get()).toBe(
      "visible",
    );
    const output = runtime.getCell(space, "immutable-forward", undefined, tx);
    output.set(rebound);
    const sigilOutput = runtime.getCell(
      space,
      "immutable-sigil-forward",
      undefined,
      tx,
    );
    sigilOutput.set(rebound.getAsLink());
    expect(deriveFlowJoin(tx).confidentiality).toContainEqual(selection);
    expect((await tx.commit()).ok).toBeDefined();
    const read = runtime.edit();
    const forwarded = output.withTx(read).key("candidates", "0")
      .resolveAsCell();
    expect(getCfcReferenceProvenance(forwarded)?.confidentiality)
      .toContainEqual(selection);
    expect(
      getCfcReferenceProvenance(
        sigilOutput.withTx(read).key("candidates", "0").resolveAsCell(),
      )?.confidentiality,
    )
      .toContainEqual(selection);
    read.abort();
  });

  for (const placement of ["root", "nested", "relative"] as const) {
    it(`retains immutable reference history through a ${placement} raw write`, async () => {
      const { selected } = await selectedTarget();
      const acquire = runtime.edit();
      const held = selected.withTx(acquire).resolveAsCell().key("public");
      const literal = runtime.getImmutableCell(
        space,
        { candidates: [held.getAsLink()] },
        undefined,
        acquire,
      );
      acquire.abort();

      const tx = runtime.edit();
      const output = runtime.getCell(
        space,
        `immutable-raw-${placement}`,
        undefined,
        tx,
      );
      const reference = literal.getAsLink(
        placement === "relative" ? { base: output } : undefined,
      );
      output.setRawUntyped(
        placement !== "nested" ? reference : { envelope: reference },
      );
      expect((await tx.commit()).ok).toBeDefined();

      const read = runtime.edit();
      try {
        const container = placement !== "nested"
          ? output.withTx(read)
          : output.withTx(read).key("envelope");
        const forwarded = container.key("candidates", "0").resolveAsCell();
        expect(getCfcReferenceProvenance(forwarded)?.confidentiality)
          .toContainEqual(selection);
        expect(getCfcReferenceProvenance(forwarded)?.confidentiality)
          .not.toContainEqual(content);
        expect(forwarded.get()).toBe("visible");
        expect(deriveFlowJoin(read).confidentiality).toContainEqual(selection);
      } finally {
        read.abort();
      }
    });
  }

  it("preserves existing modern links in immutable inputs and raw reads", async () => {
    setModernCellRepConfig(true);
    const { selected } = await selectedTarget();
    const tx = runtime.edit();
    const held = selected.withTx(tx).resolveAsCell().key("public");
    const original = held.getAsLink();
    expect(original).toBeInstanceOf(FabricLink);
    const literal = runtime.getImmutableCell(space, { candidate: original });
    tx.abort();
    const read = runtime.edit();
    try {
      const raw = literal.withTx(read).getRawUntyped() as {
        candidate: FabricLink;
      };
      expect(raw.candidate).toBeInstanceOf(FabricLink);
      expect(getCfcReferenceProvenance(raw.candidate)?.confidentiality)
        .toContainEqual(selection);
      expect(runtime.getCellFromLink(raw.candidate, undefined, read).get())
        .toBe("visible");
    } finally {
      read.abort();
    }
    expect(() => convertCellsToLinks({ original })).toThrow(
      "when converting cells to links",
    );
  });

  it("binds an acquired relative argument against the result cell", async () => {
    const { selected } = await selectedTarget();
    const acquire = runtime.edit();
    const argument = selected.withTx(acquire).resolveAsCell().key("public");
    acquire.abort();
    const tx = runtime.edit();
    try {
      const result = runtime.getCell(
        space,
        "relative-setup-result",
        undefined,
        tx,
      );
      runtime.setup(
        tx,
        trustExecutable(runtime, {
          argumentSchema: { type: "string" },
          resultSchema: { type: "string" },
          result: { $alias: { cell: "argument", path: [] } },
          nodes: [],
        }),
        argument.getAsLink({ base: result }),
        result,
      );
      const argumentLink = getMetaLink(result, "argument");
      expect(argumentLink).toBeDefined();
      expect(runtime.getCellFromLink(argumentLink!, undefined, tx).get()).toBe(
        "visible",
      );
      expect(deriveFlowJoin(tx).confidentiality).toContainEqual(selection);
    } finally {
      tx.abort();
    }
  });

  it("preserves native errors in precise pattern result projections", () => {
    const tx = runtime.edit();
    try {
      const result = runtime.getCell(space, "error-projection", undefined, tx);
      const failure = Object.assign(
        new Error("boom", { cause: new TypeError("source") }),
        { detail: "extra" },
      );
      runtime.setup(
        tx,
        trustExecutable(runtime, {
          argumentSchema: { type: "object", properties: {} },
          resultSchema: undefined,
          result: { failure },
          nodes: [],
        } as unknown as Pattern),
        {},
        result,
      );
      const raw = result.getRawUntyped() as { failure: FabricError };
      expect(raw.failure).toBeInstanceOf(FabricError);
      expect(raw.failure.message).toBe("boom");
      expect((raw.failure.cause as FabricError).message).toBe("source");
      expect(raw.failure.getExtra("detail")).toBe("extra");
    } finally {
      tx.abort();
    }
  });

  for (const sourceKind of ["persisted", "immutable"] as const) {
    it(`retains nested reference history when boxing a ${sourceKind} array item`, async () => {
      const { target, selected } = await selectedTarget();
      const acquire = runtime.edit();
      const held = selected.withTx(acquire).resolveAsCell().key("public");
      const source = sourceKind === "immutable"
        ? runtime.getImmutableCell(space, [{ candidate: held.getAsLink() }])
        : await seed("array-snapshot-source", [{
          candidate: target.key("public").getAsLink(),
        }], [{
          path: ["0", "candidate"],
          origin: "link",
          observes: "followRef",
          label: { confidentiality: [selection] },
        }]);
      const snapshot = source.withTx(acquire).key("0").resolveAsCell();
      expect(snapshot.getAsNormalizedFullLink().id.startsWith("data:")).toBe(
        true,
      );
      acquire.abort();
      const read = runtime.edit();
      try {
        expect(
          snapshot.withTx(read).asSchema({
            type: "object",
            properties: { candidate: { type: "string" } },
          }).get({ traverseCells: true }),
        ).toEqual({ candidate: "visible" });
        const raw = snapshot.withTx(read).getRawUntyped() as {
          candidate: FabricValue;
        };
        expect(getCfcReferenceProvenance(raw.candidate)?.confidentiality)
          .toContainEqual(selection);
        expect(
          runtime.getCellFromLink(raw.candidate as never, undefined, read)
            .get(),
        ).toBe("visible");
        expect(deriveFlowJoin(read).confidentiality).toContainEqual(selection);
      } finally {
        read.abort();
      }
    });
  }

  it("refuses incomplete nested provenance when boxing an array item", async () => {
    const { target } = await selectedTarget();
    const source = await seed(
      "legacy-array-snapshot-source",
      [{ candidate: target.getAsLink() }],
      [],
      1,
    );
    const tx = runtime.edit();
    try {
      expect(() => source.withTx(tx).key("0").resolveAsCell()).toThrow(
        "Reference acquisition lacks complete legacy provenance",
      );
    } finally {
      tx.abort();
    }
  });

  it("retains immutable branch acquisitions through ifElse", async () => {
    const { selected } = await selectedTarget();
    const acquire = runtime.edit();
    const held = selected.withTx(acquire).resolveAsCell().key("public");
    const inputs = runtime.getImmutableCell(space, {
      condition: true,
      ifTrue: { candidate: held.getAsLink() },
      ifFalse: null,
    });
    acquire.abort();
    const tx = runtime.edit();
    const parent = runtime.getCell(
      space,
      "ifelse-provenance-owner",
      undefined,
      tx,
    );
    let output: Cell<any> | undefined;
    const builtin = runtimeIfElse(
      inputs as Cell<any>,
      (_tx, result) => {
        output = result;
      },
      () => {},
      {
        inputs,
        parents: parent.entityId,
        outputSpot: parent.getAsNormalizedFullLink(),
      },
      parent,
      runtime,
    );
    builtin.action(tx);
    expect((await tx.commit()).ok).toBeDefined();
    const read = runtime.edit();
    try {
      const candidate = output!.withTx(read).key("candidate").resolveAsCell();
      expect(getCfcReferenceProvenance(candidate)?.confidentiality)
        .toContainEqual(selection);
      expect(candidate.get()).toBe("visible");
    } finally {
      read.abort();
    }
  });

  it("observes a confidentially selected ifElse condition", async () => {
    const target = await seed("ifelse-condition-target", true);
    const source = await seed(
      "ifelse-condition-selection",
      target.getAsLink(),
      [{
        path: [],
        origin: "link",
        observes: "followRef",
        label: { confidentiality: [selection] },
      }],
    );
    const acquisition = runtime.edit();
    const inputs = runtime.getImmutableCell(space, {
      condition: source.withTx(acquisition).resolveAsCell(),
      ifTrue: "yes",
      ifFalse: "no",
    });
    acquisition.abort();
    const tx = runtime.edit();
    try {
      const parent = runtime.getCell(
        space,
        "ifelse-condition-owner",
        undefined,
        tx,
      );
      const builtin = runtimeIfElse(
        inputs as Cell<any>,
        () => {},
        () => {},
        {
          inputs,
          parents: parent.entityId,
          outputSpot: parent.getAsNormalizedFullLink(),
        },
        parent,
        runtime,
      );
      builtin.action(tx);
      expect(deriveFlowJoin(tx).confidentiality).toContainEqual(selection);
    } finally {
      tx.abort();
    }
  });

  it("keeps ifElse references to inline array items live", async () => {
    const source = await seed("ifelse-inline-source", [{ text: "before" }]);
    const inputs = runtime.getImmutableCell(space, {
      condition: true,
      ifTrue: source.key("0"),
      ifFalse: null,
    });
    const tx = runtime.edit();
    const parent = runtime.getCell(space, "ifelse-inline-owner", undefined, tx);
    let output: Cell<any> | undefined;
    const builtin = runtimeIfElse(
      inputs as Cell<any>,
      (_tx, result) => {
        output = result;
      },
      () => {},
      {
        inputs,
        parents: parent.entityId,
        outputSpot: parent.getAsNormalizedFullLink(),
      },
      parent,
      runtime,
    );
    builtin.action(tx);
    expect((await tx.commit()).ok).toBeDefined();
    const update = runtime.edit();
    source.withTx(update).key("0", "text").set("after");
    expect((await update.commit()).ok).toBeDefined();
    const read = runtime.edit();
    try {
      expect(output!.withTx(read).key("text").get()).toBe("after");
    } finally {
      read.abort();
    }
  });

  it("rebases retained follow caps when boxing a nested array item", async () => {
    const init = runtime.edit();
    const target = runtime.getCellFromLink(
      {
        ...runtime.getCell(space, "snapshot-session-target")
          .getAsNormalizedFullLink(),
        scope: "session",
      },
      undefined,
      init,
    );
    target.set("session-private");
    expect((await init.commit()).ok).toBeDefined();
    const source = await seed("snapshot-capped-container", {
      groups: [{ candidate: target.getAsLink() }],
    }, [{
      path: ["groups", "0", "candidate"],
      observes: "followRef",
      origin: "link",
      label: {},
    }]);
    const tx = runtime.edit();
    try {
      const held = source.withTx(tx).key("groups", "0")
        .asSchema({
          type: "object",
          scope: "space",
          additionalProperties: true,
        })
        .asSchema({
          type: "object",
          scope: "session",
          additionalProperties: true,
        });
      const snapshot = held.resolveAsCell();
      expect(snapshot.getAsNormalizedFullLink().scopeCaps).toContainEqual({
        depth: 0,
        scope: "space",
      });
      expect(
        snapshot.asSchema({ type: "object", scope: "session" })
          .getAsNormalizedFullLink().scopeCaps,
      ).toContainEqual({ depth: 0, scope: "space" });
    } finally {
      tx.abort();
    }
  });

  it("keeps reference acquisitions on a user-scoped array snapshot", async () => {
    const { target } = await selectedTarget();
    const tx = runtime.edit();
    const source = runtime.getCellFromLink(
      {
        ...runtime.getCell(space, "snapshot-user-source")
          .getAsNormalizedFullLink(),
        scope: "user",
      },
      undefined,
      tx,
    );
    writeSeedEnvelopeDoc(tx, space);
    tx.writeOrThrow({ ...source.getAsNormalizedFullLink(), path: [] }, {
      value: [{ candidate: target.key("public").getAsLink() }],
      cfc: {
        version: 2,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          entries: [{
            path: ["0", "candidate"],
            observes: "followRef",
            origin: "link",
            label: {},
          }],
        },
      },
    });
    expect((await tx.commit()).ok).toBeDefined();
    const read = runtime.edit();
    try {
      const snapshot = source.withTx(read).key("0").resolveAsCell();
      expect(snapshot.getAsNormalizedFullLink().scope).toBe("user");
      expect(snapshot.getAsNormalizedFullLink().id.startsWith("data:")).toBe(
        true,
      );
      const raw = snapshot.getRawUntyped() as { candidate: FabricValue };
      expect(getCfcReferenceProvenance(raw.candidate)).toBeDefined();
      expect(snapshot.key("candidate").get()).toBe("visible");
    } finally {
      read.abort();
    }
  });

  it("deeply converts native errors in precise immutable inputs", () => {
    const failure = Object.assign(
      new Error("boom", { cause: new TypeError("source") }),
      { details: { code: "E_INPUT", attempt: 2 } },
    );
    const literal = runtime.getImmutableCell(space, {
      failure,
    });
    const decoded = valueFromDataUri(literal.getAsNormalizedFullLink().id) as {
      failure: FabricError;
    };
    expect(decoded.failure).toBeInstanceOf(FabricError);
    expect(decoded.failure.message).toBe("boom");
    expect(decoded.failure.cause).toBeInstanceOf(FabricError);
    expect((decoded.failure.cause as FabricError).name).toBe("TypeError");
    expect((decoded.failure.cause as FabricError).message).toBe("source");
    expect(decoded.failure.getExtra("details")).toEqual({
      code: "E_INPUT",
      attempt: 2,
    });
    const read = runtime.edit();
    try {
      const raw = literal.withTx(read).getRawUntyped() as {
        failure: FabricError;
      };
      expect(raw.failure).toBeInstanceOf(FabricError);
      expect(raw.failure.message).toBe("boom");
      expect(raw.failure.cause).toBeInstanceOf(FabricError);
      expect((raw.failure.cause as FabricError).message).toBe("source");
      expect(raw.failure.getExtra("details")).toEqual({
        code: "E_INPUT",
        attempt: 2,
      });
    } finally {
      read.abort();
    }
    expect(() => convertCellsToLinks({ failure })).toThrow(
      "when converting cells to links",
    );
  });

  it("refuses references in opaque immutable instance state", async () => {
    const { target } = await selectedTarget();
    const reference = target.getAsLink();
    const opaqueReference = new FabricLink(linkRefPayload(reference));
    const errorWithExtra = new FabricError({
      type: "Error",
      message: "boom",
      stack: undefined,
      cause: undefined,
      extras: { selected: reference },
    });
    const cyclic = new Error("cycle");
    cyclic.cause = cyclic;
    for (
      const failure of [
        new Error("boom", { cause: reference }),
        errorWithExtra,
        new Error("boom", { cause: opaqueReference }),
        cyclic,
      ]
    ) {
      expect(() => runtime.getImmutableCell(space, { failure })).toThrow(
        "References inside immutable `FabricInstance` state are unsupported",
      );
    }
  });

  it("joins matching immutable slot histories independent of merge order", async () => {
    const { target, selected } = await selectedTarget();
    const acquire = runtime.edit();
    const held = selected.withTx(acquire).resolveAsCell();
    const privateLiteral = runtime.getImmutableCell(space, [held.getAsLink()]);
    const publicLiteral = runtime.getImmutableCell(space, [target.getAsLink()]);
    acquire.abort();
    expect(privateLiteral.getAsNormalizedFullLink().id)
      .toBe(publicLiteral.getAsNormalizedFullLink().id);
    const privateView = getCarriedCfcLabelView(privateLiteral);
    const publicView = getCarriedCfcLabelView(publicLiteral);
    for (
      const views of [[publicView, privateView], [privateView, publicView]]
    ) {
      const tx = runtime.edit();
      const merged = runtime.getImmutableCell(
        space,
        [target.getAsLink()],
        undefined,
        tx,
        mergeCfcLabelViews(views),
      );
      const reference = merged.key("0").getRawUntyped();
      expect(getCfcReferenceProvenance(reference)?.confidentiality)
        .toContainEqual(selection);
      tx.abort();
    }
    for (
      const [nested, supplied] of [
        [publicLiteral, privateView],
        [privateLiteral, publicView],
      ] as const
    ) {
      const tx = runtime.edit();
      const wrapper = runtime.getImmutableCell(
        space,
        [nested.getAsLink()],
        undefined,
        tx,
        supplied,
      );
      expect(wrapper.key("0", "0", "public").get()).toBe("visible");
      expect(deriveFlowJoin(tx).confidentiality).toContainEqual(selection);
      tx.abort();
    }
  });

  for (const frozen of [false, true]) {
    it(`isolates raw proofs on immutable carriers with equal encoded bytes (frozen=${frozen})`, async () => {
      const { target, selected } = await selectedTarget();
      const acquisition = runtime.edit();
      const held = selected.withTx(acquisition).resolveAsCell();
      const privateLiteral = runtime.getImmutableCell(space, [
        held.getAsLink(),
      ]);
      const publicLiteral = runtime.getImmutableCell(space, [
        target.getAsLink(),
      ]);
      acquisition.abort();
      const privateTx = runtime.edit();
      const privateRead = privateLiteral.withTx(privateTx);
      const privateRaw = (frozen
        ? privateRead.getRawUntyped()
        : privateRead.getRawUntyped({ frozen: false })) as FabricValue[];
      privateTx.abort();
      const publicTx = runtime.edit();
      const publicRead = publicLiteral.withTx(publicTx);
      const publicRaw = (frozen
        ? publicRead.getRawUntyped()
        : publicRead.getRawUntyped({ frozen: false })) as FabricValue[];
      publicTx.abort();
      expect(privateRaw[0]).not.toBe(publicRaw[0]);
      expect(Object.isFrozen(privateRaw)).toBe(frozen);
      expect(Object.isFrozen(publicRaw)).toBe(frozen);
      expect(getCfcReferenceProvenance(privateRaw[0])?.confidentiality)
        .toContainEqual(selection);
      expect(getCfcReferenceProvenance(publicRaw[0])?.confidentiality).not
        .toContainEqual(selection);
    });
  }

  it("retains immutable creation context after its transaction aborts", async () => {
    const secret = await seed("immutable-creation-secret", "private", [{
      path: [],
      label: { confidentiality: [selection] },
    }]);
    const creation = runtime.edit();
    secret.withTx(creation).get();
    const literal = runtime.getImmutableCell(
      space,
      ["constant"],
      undefined,
      creation,
    );
    creation.abort();
    const tx = runtime.edit();
    expect(literal.withTx(tx).getRawUntyped()).toEqual(["constant"]);
    expect(deriveFlowJoin(tx).confidentiality).toContainEqual(selection);
    tx.abort();
  });

  it("keeps inherited reference history on an empty immutable value", async () => {
    const { selected } = await selectedTarget();
    const acquire = runtime.edit();
    const held = selected.withTx(acquire).resolveAsCell();
    const empty = runtime.getImmutableCell(
      space,
      [],
      undefined,
      undefined,
      getCarriedCfcLabelView(held),
    );
    acquire.abort();
    expect(getCfcReferenceProvenance(empty)?.confidentiality)
      .toContainEqual(selection);
  });

  it("does not authenticate a bare reference by wrapping it in an immutable value", async () => {
    const { target } = await selectedTarget();
    const raw = structuredClone(target.getAsLink());
    const tx = runtime.edit();
    const literal = runtime.getImmutableCell(space, [raw], undefined, tx);
    expect(() => literal.key("0").getRawUntyped()).toThrow(
      "Reference acquisition lacks complete legacy provenance",
    );
    expect(() => literal.key("0").resolveAsCell()).toThrow(
      "Reference acquisition lacks complete legacy provenance",
    );
    tx.abort();
  });

  it("refuses immutable encoding that would discard a retained reference scope cap", async () => {
    const { target } = await selectedTarget();
    const capped = target.asSchema({ scope: "space" }).asSchema({
      scope: "session",
    });
    expect(() => runtime.getImmutableCell(space, [capped.getAsLink()]))
      .toThrow("Reference acquisition scope cap cannot be widened for storage");
    expect(() => runtime.getImmutableCell(space, [target.getAsLink()]))
      .not.toThrow();
  });

  it("joins immutable reference scope caps at each depth in either merge order", async () => {
    const setup = runtime.edit();
    const user = runtime.getCell(
      space,
      "immutable-cap-user",
      undefined,
      setup,
      "user",
    );
    user.set("private user");
    const target = runtime.getCell(
      space,
      "immutable-cap-target",
      undefined,
      setup,
    );
    target.set(user);
    expect((await setup.commit()).error).toBeUndefined();
    const broad = target.withTx(undefined).asSchema({ scope: "user" })
      .asSchema({ scope: "space" });
    const narrow = target.withTx(undefined).asSchema({ scope: "space" })
      .asSchema({ scope: "space" });
    const broadLiteral = runtime.getImmutableCell(space, [
      broad.getAsLink({ includeSchema: true }),
    ]);
    const narrowLiteral = runtime.getImmutableCell(space, [
      narrow.getAsLink({ includeSchema: true }),
    ]);
    expect(broadLiteral.getAsNormalizedFullLink().id).toBe(
      narrowLiteral.getAsNormalizedFullLink().id,
    );
    const broadView = getCarriedCfcLabelView(broadLiteral);
    const narrowView = getCarriedCfcLabelView(narrowLiteral);
    for (const views of [[broadView, narrowView], [narrowView, broadView]]) {
      const tx = runtime.edit();
      const merged = runtime.getCellFromLink(
        broadLiteral.getAsNormalizedFullLink(),
        undefined,
        tx,
        mergeCfcLabelViews(views),
      );
      const raw = merged.key("0").getRawUntyped() as ReturnType<
        typeof target.getAsLink
      >;
      expect(getCfcReferenceProvenance(raw)?.scopeCaps).toEqual([
        { depth: 0, scope: "space" },
      ]);
      expect(runtime.getCellFromLink(raw, { scope: "user" }, tx).get())
        .toBeUndefined();
      expect(target.withTx(tx).asSchema({ scope: "user" }).get()).toBe(
        "private user",
      );
      tx.abort();
    }
  });

  it("retains a raw source schema's follow cap across an unconstrained link", async () => {
    const setup = runtime.edit();
    const session = runtime.getCell(
      space,
      "raw-source-schema-session",
      undefined,
      setup,
      "session",
    );
    session.set("private session");
    const bridge = runtime.getCell(
      space,
      "raw-source-schema-bridge",
      undefined,
      setup,
    );
    bridge.set(session);
    const slot = runtime.getCell(
      space,
      "raw-source-schema-slot",
      undefined,
      setup,
    );
    slot.set(bridge);
    expect((await setup.commit()).error).toBeUndefined();
    const read = runtime.edit();
    try {
      const capped = slot.withTx(read).asSchema({ scope: "space" });
      expect(capped.get()).toBeUndefined();
      const raw = capped.getRawUntyped() as ReturnType<typeof bridge.getAsLink>;
      expect(
        runtime.getCellFromLink(
          carryCfcReferenceProvenance(raw, parseLink(raw, slot)),
          { scope: "session" },
          read,
        ).get(),
      ).toBeUndefined();
      expect(slot.withTx(read).asSchema({ scope: "session" }).get()).toBe(
        "private session",
      );
    } finally {
      read.abort();
    }
  });

  for (const committed of [false, true]) {
    it(`refuses a ${committed ? "persisted" : "pending"} raw acquisition beyond its source handle's scope cap`, async () => {
      const setup = runtime.edit();
      const session = runtime.getCell(
        space,
        "raw-source-cap-session",
        undefined,
        setup,
        "session",
      );
      session.set("private session");
      const publicTarget = runtime.getCell(
        space,
        "raw-source-cap-public",
        undefined,
        setup,
      );
      publicTarget.set("public value");
      expect((await setup.commit()).error).toBeUndefined();
      const write = runtime.edit();
      const slot = runtime.getCell(
        space,
        "raw-source-cap-slot",
        undefined,
        write,
      );
      slot.set(session);
      const publicSlot = runtime.getCell(
        space,
        "raw-source-cap-public-slot",
        undefined,
        write,
      );
      publicSlot.set(publicTarget);
      if (committed) expect((await write.commit()).error).toBeUndefined();
      const read = committed ? runtime.edit() : write;
      try {
        const capped = slot.withTx(read).asSchema({ scope: "space" })
          .asSchema({ scope: "session" });
        expect(capped.get()).toBeUndefined();
        expect(() => capped.getRawUntyped()).toThrow(
          "Reference acquisition exceeds its source scope cap",
        );
        const raw = slot.withTx(read).getRawUntyped() as ReturnType<
          typeof session.getAsLink
        >;
        expect(
          runtime.getCellFromLink(
            carryCfcReferenceProvenance(raw, parseLink(raw, slot)),
            { scope: "session" },
            read,
          ).get(),
        ).toBe("private session");
        const publicRaw = publicSlot.withTx(read).asSchema({ scope: "space" })
          .asSchema({ scope: "session" }).getRawUntyped() as ReturnType<
            typeof publicTarget.getAsLink
          >;
        expect(
          runtime.getCellFromLink(
            carryCfcReferenceProvenance(
              publicRaw,
              parseLink(publicRaw, publicSlot),
            ),
            { scope: "session" },
            read,
          ).get(),
        ).toBe("public value");
      } finally {
        read.abort();
      }
    });

    it(`retains a ${committed ? "persisted" : "pending"} raw reference's scope cap through a schema override`, async () => {
      const setup = runtime.edit();
      const session = runtime.getCell(
        space,
        "raw-cap-session",
        undefined,
        setup,
        "session",
      );
      session.set("private session");
      const target = runtime.getCell(space, "raw-cap-target", undefined, setup);
      target.set(session);
      expect((await setup.commit()).error).toBeUndefined();
      const write = runtime.edit();
      const slot = runtime.getCell(space, "raw-cap-slot", undefined, write);
      const capped = target.withTx(undefined).asSchema({ scope: "space" })
        .asSchema({ scope: "space" });
      slot.set(capped);
      if (committed) expect((await write.commit()).error).toBeUndefined();
      const read = committed ? runtime.edit() : write;
      try {
        const raw = slot.withTx(read).getRawUntyped() as ReturnType<
          typeof target.getAsLink
        >;
        const held = runtime.getCellFromLink(
          carryCfcReferenceProvenance(raw, parseLink(raw, slot)),
          { scope: "session" },
          read,
        );
        expect(held.get()).toBeUndefined();
        expect(target.withTx(read).asSchema({ scope: "session" }).get()).toBe(
          "private session",
        );
      } finally {
        read.abort();
      }
    });
  }

  for (const mode of ["eager", "lazy", "compound-eager", "compound-lazy"]) {
    it(`persists a materialized handle with inherited scope caps (${mode})`, async () => {
      const target = await seed("materialized-cap-profile", { name: "Bob" });
      const setup = runtime.edit();
      const profiles = runtime.getCell(
        space,
        "materialized-cap-profiles",
        undefined,
        setup,
      );
      profiles.set([{
        profile: target.withTx(setup).asSchema({ scope: "space" }),
      }]);
      expect((await setup.commit()).ok).toBeDefined();
      const acquire = runtime.edit();
      if (mode.endsWith("lazy")) acquire.markLazyMaterialize(true);
      const projected = profiles.withTx(acquire).asSchema({
        type: "array",
        scope: "space",
        items: {
          type: "object",
          properties: {
            profile: mode.startsWith("compound")
              ? {
                anyOf: [
                  {
                    type: "object",
                    properties: { name: { type: "string" } },
                    asCell: [{ kind: "cell" }],
                  },
                  {
                    type: "object",
                    properties: { color: { type: "string" } },
                    asCell: [{ kind: "cell" }],
                  },
                ],
              }
              : {
                type: "object",
                properties: { name: { type: "string" } },
                asCell: [{ kind: "cell" }],
              },
          },
        },
      }).get();
      const held = (projected as { profile: unknown }[])[0].profile;
      expect(isCell(held)).toBe(true);
      if (!isCell(held)) throw new Error("Expected a profile Cell");
      expect(getCfcReferenceProvenance(held)?.scopeCaps).toContainEqual({
        depth: 0,
        scope: "space",
      });
      acquire.abort();
      const tx = runtime.edit();
      const output = runtime.getCell(
        space,
        "materialized-cap-output",
        undefined,
        tx,
      );
      output.set(held.withTx(tx));
      expect((await tx.commit()).ok).toBeDefined();
      const read = runtime.edit();
      expect(output.withTx(read).get()).toEqual({ name: "Bob" });
      read.abort();
      const widening = runtime.edit();
      expect(() =>
        output.withTx(widening).set(
          held.withTx(widening).asSchema({ scope: "session" }),
        )
      )
        .toThrow(
          "Reference acquisition scope cap cannot be widened for storage",
        );
      widening.abort();
    });
  }

  for (const wrapped of [false, true]) {
    it(`retains inherited scope in a resolved handle's durable schema (wrapped=${wrapped})`, async () => {
      const target = await seed("resolved-cap-target", { name: "Alice" });
      const acquire = runtime.edit();
      const source = runtime.getCellFromLink(
        {
          ...target.getAsNormalizedFullLink(),
          scopeCaps: [{ depth: 0, scope: "space" }],
        },
        {
          type: "object",
          properties: { name: { type: "string" } },
          ...(wrapped
            ? { asCell: [{ kind: "cell" as const, scope: "session" as const }] }
            : {}),
        },
        acquire,
      );
      const held = source.resolveAsCell().withTx(undefined);
      acquire.abort();
      const tx = runtime.edit();
      const output = runtime.getCell(
        space,
        "resolved-cap-output",
        undefined,
        tx,
      );
      output.set(held.withTx(tx));
      expect((await tx.commit()).ok).toBeDefined();
      const read = runtime.edit();
      expect(
        output.withTx(read).asSchema({
          type: "object",
          properties: { name: { type: "string" } },
        }).get(),
      ).toEqual({ name: "Alice" });
      read.abort();
      const widening = runtime.edit();
      expect(() =>
        output.withTx(widening).set(
          held.withTx(widening).asSchema({ scope: "session" }),
        )
      )
        .toThrow(
          "Reference acquisition scope cap cannot be widened for storage",
        );
      widening.abort();
    });
  }

  it("retains a trusted pending reference's scope cap after acquisition", async () => {
    const target = await seed("pending-cap-target", "public");
    const capped = target.asSchema({ scope: "space" }).asSchema({
      scope: "space",
    });
    const tx = runtime.edit();
    const slot = runtime.getCell(space, "pending-cap-slot", undefined, tx);
    slot.set(capped);
    const acquired = tx.acquireCfcReference(
      slot.getAsNormalizedFullLink(),
      undefined,
      runtimeWritePolicyAuthorization,
    );
    expect(acquired?.scopeCaps).toEqual([{ depth: 0, scope: "space" }]);
    tx.abort();
  });

  it("records both equality operands after their acquisition transaction ends", async () => {
    const { target, selected } = await selectedTarget();
    const acquire = runtime.edit();
    const resolved = selected.withTx(acquire).resolveAsCell();
    acquire.abort();

    const tx = runtime.edit();
    expect(target.withTx(tx).equalLinks(resolved)).toBe(true);
    expect(deriveFlowJoin(tx).confidentiality).toContainEqual(selection);
    expect(
      tx.getCfcState().referenceObservations.some((observation) =>
        observation.purpose === "identity"
      ),
    ).toBe(true);
    tx.abort();
  });

  it("joins carried reference restrictions with an additional private view", async () => {
    const { selected } = await selectedTarget();
    const acquire = runtime.edit();
    const held = selected.withTx(acquire).resolveAsCell();
    acquire.abort();
    const combined = runtime.getCellFromLink(
      held.getAsLink(),
      undefined,
      undefined,
      withCfcReferenceConfidentiality(undefined, [content]),
    );
    const confidentiality = getCfcReferenceProvenance(combined)
      ?.confidentiality;
    expect(confidentiality).toContainEqual(selection);
    expect(confidentiality).toContainEqual(content);
  });

  it("preserves a minted sigil and refuses an altered binding", async () => {
    const { selected } = await selectedTarget();
    const acquire = runtime.edit();
    const resolved = selected.withTx(acquire).resolveAsCell();
    const sigil = resolved.getAsLink();
    const normalized = resolved.getAsNormalizedFullLink();
    acquire.abort();

    const tx = runtime.edit();
    const restored = runtime.getCellFromLink(sigil, undefined, tx);
    expect(getCfcReferenceProvenance(restored)?.confidentiality).toEqual([
      selection,
    ]);
    restored.toJSON();
    expect(deriveFlowJoin(tx).confidentiality).toContainEqual(selection);
    expect(
      getCfcReferenceProvenance(runtime.getCellFromLink(normalized))
        ?.confidentiality,
    ).toEqual([selection]);
    tx.abort();

    // The carrier is mutable until it enters the canonical serializer.
    linkRefPayload(sigil).path = ["different"];
    expect(() => runtime.getCellFromLink(sigil)).toThrow(
      "Reference acquisition does not match its binding",
    );
  });

  it("keeps a query-result backpointer's reference history", async () => {
    const { selected } = await selectedTarget();
    const acquire = runtime.edit();
    const result = selected.withTx(acquire).getAsQueryResult();
    const cell = getCellOrThrow(result);
    expect(getCfcReferenceProvenance(result)?.confidentiality).toEqual([
      selection,
    ]);
    acquire.abort();

    const tx = runtime.edit();
    cell.withTx(tx).getAsLink();
    expect(deriveFlowJoin(tx).confidentiality).toContainEqual(selection);
    tx.abort();
  });

  it("retains reference history on an eagerly materialized object", async () => {
    const { selected } = await selectedTarget();
    const read = runtime.edit();
    read.markLazyMaterialize(false);
    const value = selected.withTx(read).asSchema({
      type: "object",
      properties: { public: { type: "string" } },
    }).get();
    expect(value).toEqual({ public: "visible" });
    expect(getCfcReferenceProvenance(value)?.confidentiality)
      .toContainEqual(selection);
    expect(getCfcReferenceProvenance(getCellOrThrow(value))?.confidentiality)
      .toContainEqual(selection);
    read.abort();
  });

  it("blocks narrower-scope references while materializing array elements", async () => {
    const setup = runtime.edit();
    const privateCell = runtime.getCell(
      space,
      "array-session",
      undefined,
      setup,
      "session",
    );
    privateCell.set("private session");
    expect((await setup.commit()).error).toBeUndefined();
    const array = await seed(
      "array-session-holder",
      [privateCell.getAsLink()],
      [{
        path: ["0"],
        origin: "link",
        observes: "followRef",
        label: {},
      }],
    );
    const read = runtime.edit();
    const value = array.withTx(read).asSchema({
      type: "array",
      scope: "space",
      items: { type: ["string", "undefined"], scope: "space" },
    }).get();
    expect(value).toEqual([undefined]);
    expect(
      array.withTx(read).asSchema({
        type: "array",
        items: { type: "string", scope: "session" },
      }).get(),
    ).toEqual(["private session"]);
    expect(privateCell.withTx(read).get()).toBe("private session");
    read.abort();
  });

  it("inlines an immutable error without losing its nested cause or extra fields", () => {
    const error = new FabricError({
      type: "Error",
      message: "failure",
      stack: undefined,
      cause: new FabricError({
        type: "TypeError",
        message: "source",
        stack: undefined,
        cause: undefined,
      }),
      extras: { detail: { attempt: 2 } },
    });
    const literal = runtime.getImmutableCell(space, error);
    const result = findAndInlineDataUriLinks(
      literal.getAsLink(),
      undefined,
      true,
    );
    expect(result).toBeInstanceOf(FabricError);
    expect(result.message).toBe("failure");
    expect(result.cause.message).toBe("source");
    expect(result.getExtra("detail")).toEqual({ attempt: 2 });
  });

  it("acquires a reference handle without inspecting an unavailable target", async () => {
    const unavailable = runtime.getCell(space, "unavailable");
    const selected = await seed(
      "unavailable-selection",
      unavailable.getAsLink(),
      [{
        path: [],
        observes: "followRef",
        origin: "link",
        label: { confidentiality: [selection] },
      }],
    );
    const tx = runtime.edit();
    const handle = selected.withTx(tx).asSchema({ asCell: ["cell"] }).get();
    expect(isCell(handle)).toBe(true);
    expect(getCfcReferenceProvenance(handle)?.confidentiality).toEqual([
      selection,
    ]);
    expect(
      [...tx.getReadActivities!()].some((read) =>
        read.id === unavailable.getAsNormalizedFullLink().id
      ),
    ).toBe(false);
    tx.abort();
  });

  it("does not authenticate an author-provided label view", async () => {
    const target = await seed("independent", "secret", [{
      path: [],
      label: { confidentiality: [content] },
    }]);
    expect(getCfcReferenceProvenance(target)?.confidentiality).toEqual([]);
    const forged = {
      ...target.getAsNormalizedFullLink(),
      cfcLabelView: { version: 1, entries: [] },
      reference: { confidentiality: [], acquired: true },
    };
    expect(getCfcReferenceProvenance(forged)).toBeUndefined();
  });

  it("blocks LLM serialization of public content reached through a private selection", async () => {
    const { selected } = await selectedTarget();
    const resolved = selected.resolveAsCell().key("public");
    const result = llmDialogTestHelpers.serializeForLLMObservation({
      value: resolved.get(),
      contextSpace: space,
      rootLink: resolved.getAsNormalizedFullLink(),
      labelView: cfcLabelViewForCell(resolved),
      observationMaxConfidentiality: [],
    });
    expect(result.value).toBe("[redacted: exceeds observation ceiling]");
    expect(result.observedConfidentiality).toEqual([]);
  });

  it("keeps acquired restrictions visible to serialized v1 display consumers", async () => {
    const { selected } = await selectedTarget();
    const resolved = selected.resolveAsCell().key("public");
    const display = structuredClone(
      redactCaveatSourcesForDisplay(cfcLabelViewForCell(resolved)!),
    );
    expect(display.version).toBe(1);
    expect(cfcConfidentialityForObservationNode({ labelView: display }))
      .toContainEqual(selection);
    expect(getCfcReferenceProvenance(display)).toBeUndefined();
  });

  it("preserves a stored raw reference through serialization in another transaction", async () => {
    const { selected } = await selectedTarget();
    const acquire = runtime.edit();
    const raw = selected.withTx(acquire).getRawUntyped();
    acquire.abort();
    const tx = runtime.edit();
    runtime.getCellFromLink(raw as never, undefined, tx).getAsLink();
    expect(deriveFlowJoin(tx).confidentiality).toContainEqual(selection);
    tx.abort();
  });

  for (const frozen of [false, true]) {
    it(`retains nested stored reference history in a raw read (frozen=${frozen})`, async () => {
      const { target } = await selectedTarget();
      const holder = await seed("nested-raw-holder", {
        links: [target.getAsLink()],
      }, [{
        path: ["links", "0"],
        observes: "followRef",
        origin: "link",
        label: { confidentiality: [selection] },
      }]);
      const read = runtime.edit();
      const raw = (frozen
        ? holder.withTx(read).getRawUntyped()
        : holder.withTx(read).getRawUntyped({ frozen: false })) as {
          links: FabricValue[];
        };
      expect(deriveFlowJoin(read).confidentiality).toContainEqual(selection);
      expect(deriveFlowJoin(read).confidentiality).not.toContainEqual(content);
      expect(
        read.getCfcState().dereferenceTraces.some(({ target: address }) =>
          address.id === target.getAsNormalizedFullLink().id
        ),
      ).toBe(false);
      read.abort();
      expect(Object.isFrozen(raw)).toBe(frozen);
      expect(getCfcReferenceProvenance(raw.links[0])?.confidentiality)
        .toContainEqual(selection);
      const write = runtime.edit();
      const output = runtime.getCell(
        space,
        "copied-raw-holder",
        undefined,
        write,
      );
      output.setRawUntyped(raw);
      expect((await write.commit()).ok).toBeDefined();
      expect(
        getCfcReferenceProvenance(
          output.withTx(undefined).key("links", "0").resolveAsCell(),
        )?.confidentiality,
      ).toContainEqual(selection);
    });

    it(`isolates stored raw reference acquisitions across source handles (frozen=${frozen})`, async () => {
      const { target } = await selectedTarget();
      const holder = await seed("shared-raw-holder", [target.getAsLink()], [{
        path: ["0"],
        observes: "followRef",
        origin: "link",
        label: {},
      }]);
      const selectedHolder = await seed(
        "selected-raw-holder",
        holder.getAsLink(),
        [{
          path: [],
          observes: "followRef",
          origin: "link",
          label: { confidentiality: [selection] },
        }],
      );
      const tx = runtime.edit();
      const privateHandle = selectedHolder.withTx(tx).resolveAsCell();
      const privateRaw = (frozen
        ? privateHandle.getRawUntyped()
        : privateHandle.getRawUntyped({ frozen: false })) as FabricValue[];
      const publicRaw = (frozen
        ? holder.withTx(tx).getRawUntyped()
        : holder.withTx(tx).getRawUntyped({ frozen: false })) as FabricValue[];
      tx.abort();
      expect(privateRaw[0]).not.toBe(publicRaw[0]);
      expect(getCfcReferenceProvenance(privateRaw[0])?.confidentiality)
        .toContainEqual(selection);
      expect(getCfcReferenceProvenance(publicRaw[0])?.confidentiality)
        .not.toContainEqual(selection);
    });
  }

  it("retains stored reference history when setup replaces another argument slot", async () => {
    const { selected } = await selectedTarget();
    const pattern = trustExecutable(runtime, {
      argumentSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          links: { type: "array", items: {} },
        },
      },
      resultSchema: { type: "string" },
      result: "ready",
      nodes: [],
    } as Pattern);
    const tx = runtime.edit();
    const result = runtime.getCell(space, "stored-slot-replay", undefined, tx);
    runtime.setup(tx, pattern, {
      title: "original",
      links: [selected.withTx(tx).resolveAsCell().getAsLink()],
    }, result);
    expect((await tx.commit()).ok).toBeDefined();

    const replay = runtime.edit();
    runtime.setup(
      replay,
      pattern,
      { title: "replacement" },
      result.withTx(replay),
    );
    expect((await replay.commit()).ok).toBeDefined();
    const argument = runtime.getCellFromLink(
      getMetaLink(result.withTx(undefined), "argument")!,
    );
    expect(argument.key("title").get()).toBe("replacement");
    expect(
      getCfcReferenceProvenance(argument.key("links", "0").resolveAsCell())
        ?.confidentiality,
    ).toContainEqual(selection);
  });

  it("refuses legacy acquisition history while allowing independent host addresses", async () => {
    const { target } = await selectedTarget();
    const legacy = await seed("legacy", target.getAsLink(), [], 1);
    const tx = runtime.edit();
    expect(() => legacy.withTx(tx).resolveAsCell()).toThrow(
      "Reference acquisition lacks complete legacy provenance",
    );
    expect(() => legacy.withTx(tx).getRawUntyped()).toThrow(
      "Reference acquisition lacks complete legacy provenance",
    );
    expect(() => target.withTx(tx).getAsLink()).not.toThrow();
    tx.abort();
  });

  it("keeps reference endorsements out of an LLM tool's content floor", async () => {
    const endorsement = "approved-content";
    const content = await seed("unsigned-content", "recipient");
    const reference = await seed("endorsed-reference", content.getAsLink(), [{
      path: [],
      observes: "followRef",
      origin: "link",
      label: { integrity: [endorsement] },
    }]);
    const approved = await seed("approved-content", "recipient", [{
      path: [],
      observes: "value",
      label: { integrity: [endorsement] },
    }]);
    const gate = (cell: typeof reference) =>
      llmToolExecutionHelpers.toolInputRequiredIntegrityFailure(
        runtime,
        space,
        { type: "string", ifc: { requiredIntegrity: [endorsement] } },
        {
          "@link": createLLMFriendlyLink(cell.getAsNormalizedFullLink(), space),
        },
        "",
        {},
      );
    expect(gate(reference)).toBeDefined();
    expect(gate(approved)).toBeUndefined();
  });

  it("refuses persisted references with no envelope or no per-slot completeness", async () => {
    const { target } = await selectedTarget();
    const tx = runtime.edit();
    const absent = runtime.getCell(space, "absent-envelope", undefined, tx);
    tx.writeOrThrow({ ...absent.getAsNormalizedFullLink(), path: [] }, {
      value: target.getAsLink(),
    });
    expect((await tx.commit()).ok).toBeDefined();
    expect(() => absent.withTx(undefined).resolveAsCell()).toThrow(
      "Reference acquisition lacks complete legacy provenance",
    );

    const mixed = await seed(
      "mixed-legacy",
      { legacy: target.getAsLink() },
      [],
      1,
    );
    const update = runtime.edit();
    mixed.withTx(update).key("fresh").set(target);
    expect((await update.commit()).ok).toBeDefined();
    expect(() => mixed.key("legacy").resolveAsCell()).toThrow(
      "Reference acquisition lacks complete legacy provenance",
    );
    expect(() => mixed.key("fresh").resolveAsCell()).not.toThrow();
  });

  it("persists complete provenance at each trusted raw output reference slot", async () => {
    const { target, selected } = await selectedTarget();
    const tx = runtime.edit();
    const output = runtime.getCell(space, "raw-output", undefined, tx);
    const acquired = selected.withTx(tx).resolveAsCell();
    output.setRawUntyped({
      nested: [acquired.getAsLink(), target.getAsLink()],
    });
    expect((await tx.commit()).ok).toBeDefined();
    const stored = output.withTx(undefined);
    expect(
      getCfcReferenceProvenance(stored.key("nested", "0").resolveAsCell())
        ?.confidentiality,
    )
      .toContainEqual(selection);
    expect(() => stored.key("nested", "1").resolveAsCell()).not.toThrow();
  });

  it("preserves a held argument's acquisition through alias binding", async () => {
    const { selected } = await selectedTarget();
    const acquire = runtime.edit();
    const held = selected.withTx(acquire).resolveAsCell()
      .getAsNormalizedFullLink();
    acquire.abort();
    const tx = runtime.edit();
    const output = runtime.getCell(space, "alias-output", undefined, tx);
    const bound = unwrapOneLevelAndBindToDoc(
      {
        $alias: { cell: "argument", path: ["public"] },
      },
      held,
      output,
    );
    expect(getCfcReferenceProvenance(bound)?.confidentiality).toContainEqual(
      selection,
    );
    output.set(bound);
    expect(deriveFlowJoin(tx).confidentiality).toContainEqual(selection);
    tx.abort();
  });

  for (const scope of ["space", "user", "session"] as const) {
    it(`persists the ${scope} source declaration in a scope-silent alias projection`, async () => {
      const setup = runtime.edit();
      const target = runtime.getCellFromLink(
        {
          ...runtime.getCell(space, `alias-${scope}-target`)
            .getAsNormalizedFullLink(),
          scope,
        },
        undefined,
        setup,
      );
      target.set("visible");
      const argument = runtime.getCell(
        space,
        `alias-${scope}-argument`,
        undefined,
        setup,
      );
      argument.set({ value: target });
      expect((await setup.commit()).ok).toBeDefined();

      const tx = runtime.edit();
      const output = runtime.getCell(
        space,
        `alias-${scope}-output`,
        undefined,
        tx,
      );
      const projectedArgument = argument.withTx(tx).asSchema({
        type: "object",
        properties: {
          value: { type: "string", asCell: [{ kind: "cell", scope }] },
        },
      });
      const bound = unwrapOneLevelAndBindToDoc(
        { $alias: { cell: "argument", path: ["value"] } },
        projectedArgument.getAsNormalizedFullLink(),
        output,
        { targetSchema: { type: "string" } },
      );
      output.set(bound);
      expect((await tx.commit()).ok).toBeDefined();
      const read = runtime.edit();
      expect(output.withTx(read).get()).toBe("visible");
      read.abort();
    });
  }

  it("retains alias acquisition when a transaction strengthens an off Runtime to persist", async () => {
    const argument = await seed("strengthened-alias-source", {
      value: "visible",
    });
    const offRuntime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager: storage,
      cfcFlowLabels: "off",
    });
    try {
      const tx = offRuntime.edit();
      tx.setCfcFlowLabelsMode("persist");
      const output = offRuntime.getCell(
        space,
        "strengthened-alias-output",
        undefined,
        tx,
      );
      const source = offRuntime.getCellFromLink(
        argument.getAsNormalizedFullLink(),
        {
          type: "object",
          properties: {
            value: {
              type: "string",
              asCell: [{ kind: "cell", scope: "space" }],
            },
          },
        },
        tx,
      );
      const bound = unwrapOneLevelAndBindToDoc(
        { $alias: { cell: "argument", path: ["value"] } },
        source.getAsNormalizedFullLink(),
        output,
        { targetSchema: { type: "string" } },
      );
      expect(getCfcReferenceProvenance(bound)).toBeDefined();
      output.set(bound);
      expect((await tx.commit()).ok).toBeDefined();
      const read = offRuntime.edit();
      read.setCfcFlowLabelsMode("persist");
      expect(output.withTx(read).get()).toBe("visible");
      read.abort();
    } finally {
      await offRuntime.dispose();
    }
  });

  for (const reverseCaps of [false, true]) {
    it(`retains inherited alias caps at different depths (reverse=${reverseCaps})`, async () => {
      const setup = runtime.edit();
      const secret = runtime.getCellFromLink(
        {
          ...runtime.getCell(space, "alias-inherited-session")
            .getAsNormalizedFullLink(),
          scope: "session",
        },
        undefined,
        setup,
      );
      secret.set("session-only");
      const argument = runtime.getCell(
        space,
        "alias-inherited-source",
        undefined,
        setup,
      );
      argument.set({ value: secret });
      expect((await setup.commit()).ok).toBeDefined();

      const tx = runtime.edit();
      const caps = [
        { depth: 0, scope: "user" as const },
        { depth: 1, scope: "space" as const },
      ];
      const source = runtime.getCellFromLink(
        {
          ...argument.getAsNormalizedFullLink(),
          scopeCaps: reverseCaps ? caps.reverse() : caps,
        },
        undefined,
        tx,
      );
      const output = runtime.getCell(
        space,
        "alias-inherited-output",
        undefined,
        tx,
      );
      output.set(unwrapOneLevelAndBindToDoc(
        { $alias: { cell: "argument", path: ["value"] } },
        source.getAsNormalizedFullLink(),
        output,
        { targetSchema: { type: "string" } },
      ));
      expect((await tx.commit()).ok).toBeDefined();
      const read = runtime.edit();
      expect(output.withTx(read).get()).toBeUndefined();
      expect(argument.withTx(read).key("value").get()).toBe("session-only");
      read.abort();
    });
  }

  it("uses a staged replacement's selection instead of an existing complete marker", async () => {
    const left = await seed("staged-left", "left");
    const right = await seed("staged-right", "right");
    const slot = await seed("staged-existing", left.getAsLink(), [{
      path: [],
      origin: "link",
      observes: "followRef",
      label: {},
    }]);
    const secret = await seed("staged-selection", true, [{
      path: [],
      label: { confidentiality: [selection] },
    }]);
    const tx = runtime.edit();
    secret.withTx(tx).get();
    slot.withTx(tx).set(right);
    const acquired = slot.withTx(tx).resolveAsCell().withTx(undefined);
    expect(getCfcReferenceProvenance(acquired)?.confidentiality).toContainEqual(
      selection,
    );
    tx.abort();
    const unsafe = runtime.edit();
    unsafe.writeValueOrThrow(slot.getAsNormalizedFullLink(), right.getAsLink());
    expect(() => slot.withTx(unsafe).resolveAsCell()).toThrow(
      "Reference acquisition lacks complete legacy provenance",
    );
    unsafe.abort();
  });

  it("retains a new slot's declared confidentiality without unrelated sibling policies", async () => {
    const target = (await seed("pending-schema-target", "public")).asSchema<
      string
    >({ type: "string" });
    const tx = runtime.edit();
    const output = runtime.getCell(space, "pending-schema-output", {
      type: "object",
      properties: {
        selected: { type: "string", ifc: { confidentiality: [selection] } },
        unrelated: { type: "string", ifc: { confidentiality: [content] } },
      },
    }, tx);
    output.key("selected").set(target);
    output.key("unrelated").set(target);
    const held = output.key("selected").resolveAsCell().withTx(undefined);
    expect(getCfcReferenceProvenance(held)?.confidentiality).toContainEqual(
      selection,
    );
    expect(getCfcReferenceProvenance(held)?.confidentiality).not.toContainEqual(
      content,
    );
    tx.abort();
    const later = runtime.edit();
    held.withTx(later).getAsLink();
    expect(deriveFlowJoin(later).confidentiality).toContainEqual(selection);
    later.abort();
  });

  it("retains a slot's declared confidentiality during staged replacement", async () => {
    const left = await seed("declared-left", "left");
    const right = await seed("declared-right", "right");
    const slot = await seed("declared-slot", left.getAsLink(), [{
      path: [],
      origin: "link",
      observes: "followRef",
      label: {},
    }, {
      path: [],
      origin: "declared",
      label: { confidentiality: [selection] },
    }]);
    const tx = runtime.edit();
    slot.withTx(tx).set(right);
    expect(
      getCfcReferenceProvenance(slot.withTx(tx).resolveAsCell())
        ?.confidentiality,
    )
      .toContainEqual(selection);
    tx.abort();
  });

  for (const redirect of [false, true]) {
    it(`retains new selection on a same-value ${redirect ? "redirect" : "reference"} write`, async () => {
      const target = await seed("same-value-target", "public");
      const link = redirect
        ? target.getAsWriteRedirectLink()
        : target.getAsLink();
      const slot = await seed("same-value-slot", link, [{
        path: [],
        origin: "link",
        observes: "followRef",
        label: {},
      }]);
      const secret = await seed("same-value-selection", true, [{
        path: [],
        label: { confidentiality: [selection] },
      }]);
      const tx = runtime.edit();
      secret.withTx(tx).get();
      if (redirect) {
        diffAndUpdate(
          runtime,
          tx,
          slot.getAsNormalizedFullLink(),
          target.getAsWriteRedirectLink(),
        );
      } else {
        slot.withTx(tx).set(target);
      }
      const held = slot.withTx(tx).resolveAsCell().withTx(undefined);
      tx.abort();
      const later = runtime.edit();
      held.withTx(later).getAsLink();
      expect(deriveFlowJoin(later).confidentiality).toContainEqual(selection);
      later.abort();
    });
  }

  it("retains selection from a trusted write acquired before its transaction ends", async () => {
    const { target } = await selectedTarget();
    const secret = await seed("same-attempt-secret", "selected", [{
      path: [],
      label: { confidentiality: [selection] },
    }]);
    const tx = runtime.edit();
    secret.withTx(tx).get();
    const slot = runtime.getCell(space, "same-attempt-slot", undefined, tx);
    slot.set(target);
    const acquired = slot.resolveAsCell().withTx(undefined);
    expect(getCfcReferenceProvenance(acquired)?.confidentiality).toContainEqual(
      selection,
    );
    tx.abort();
    const next = runtime.edit();
    acquired.withTx(next).getAsLink();
    expect(deriveFlowJoin(next).confidentiality).toContainEqual(selection);
    next.abort();
  });
});
