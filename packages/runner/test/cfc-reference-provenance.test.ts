import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { cfcAtom } from "@commonfabric/api/cfc";
import type { FabricValue } from "@commonfabric/data-model";
import { linkRefPayload } from "@commonfabric/data-model/cell-rep";
import { Identity } from "@commonfabric/identity";

import { isCell } from "../src/cell.ts";
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
  getCfcReferenceProvenance,
  withCfcReferenceConfidentiality,
} from "../src/cfc/reference-provenance.ts";
import type { LabelMapEntry } from "../src/cfc/types.ts";
import { getCellOrThrow } from "../src/query-result-proxy.ts";
import { createLLMFriendlyLink } from "../src/link-types.ts";
import { Runtime } from "../src/runtime.ts";
import { diffAndUpdate } from "../src/data-updating.ts";
import { unwrapOneLevelAndBindToDoc } from "../src/pattern-binding.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
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

  it("isolates raw proofs on immutable carriers with equal encoded bytes", async () => {
    const { target, selected } = await selectedTarget();
    const acquisition = runtime.edit();
    const held = selected.withTx(acquisition).resolveAsCell();
    const privateLiteral = runtime.getImmutableCell(space, [held.getAsLink()]);
    const publicLiteral = runtime.getImmutableCell(space, [target.getAsLink()]);
    acquisition.abort();
    const privateTx = runtime.edit();
    const privateRaw = privateLiteral.withTx(privateTx)
      .getRawUntyped() as FabricValue[];
    privateTx.abort();
    const publicTx = runtime.edit();
    const publicRaw = publicLiteral.withTx(publicTx).getRawUntyped({
      frozen: false,
    }) as FabricValue[];
    publicTx.abort();
    expect(privateRaw[0]).not.toBe(publicRaw[0]);
    expect(Object.isFrozen(privateRaw)).toBe(true);
    expect(Object.isFrozen(publicRaw)).toBe(false);
    expect(getCfcReferenceProvenance(privateRaw[0])?.confidentiality)
      .toContainEqual(selection);
    expect(getCfcReferenceProvenance(publicRaw[0])?.confidentiality).not
      .toContainEqual(selection);
  });

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
