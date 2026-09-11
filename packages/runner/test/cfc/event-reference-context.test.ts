/** Durable event acquisitions retain their exact bindings and restrictions. */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { cfcAtom } from "@commonfabric/api/cfc";
import {
  cloneIfNecessary,
  type FabricValue,
  hashStringOf,
} from "@commonfabric/data-model";
import {
  fabricFromJsonValue,
  jsonFromFabricValue,
} from "@commonfabric/data-model/codecs";
import {
  linkRefFrom,
  linkRefPayload,
  resetModernCellRepConfig,
  setModernCellRepConfig,
} from "@commonfabric/data-model/cell-rep";
import { Identity } from "@commonfabric/identity";

import {
  restoreRuntimeEventReferences,
  serializeRuntimeEvent,
} from "../../src/cfc/event-reference-context.ts";
import { normalizeClause } from "../../src/cfc/clause.ts";
import { deriveFlowJoin } from "../../src/cfc/prepare.ts";
import {
  carryCfcReferenceProvenance,
  getCfcReferenceProvenance,
} from "../../src/cfc/reference-provenance.ts";
import { parseLink } from "../../src/link-utils.ts";
import {
  resetContentAddressedSchemasConfig,
  setContentAddressedSchemasConfig,
} from "../../src/schema-doc-config.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  writeSeedEnvelopeDoc,
} from "../cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("event-reference-context");
const space = signer.did();
const secret = normalizeClause({
  anyOf: ["event-selection", cfcAtom.space(space)],
});
const otherSecret = normalizeClause({
  anyOf: ["send-selection", cfcAtom.space(space)],
});
const roundtrip = (value: FabricValue) =>
  fabricFromJsonValue(jsonFromFabricValue(value));

describe("event-reference-context", () => {
  let storage: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storage = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      storageManager: storage,
      apiUrl: new URL("https://example.com"),
      cfcFlowLabels: "persist",
    });
  });

  afterEach(async () => {
    await storage.synced();
    await runtime.dispose({ closeStorage: false });
    await storage.close();
    resetModernCellRepConfig();
    resetContentAddressedSchemasConfig();
  });

  async function selectedReference() {
    const tx = runtime.edit();
    const target = runtime.getCell(space, "target", undefined, tx);
    target.set("public value");
    const source = runtime.getCell(space, "selected", undefined, tx);
    writeSeedEnvelopeDoc(tx, space);
    tx.writeOrThrow({ ...source.getAsNormalizedFullLink(), path: [] }, {
      value: target.getAsLink(),
      cfc: {
        version: 2,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          entries: [{
            path: [],
            origin: "link",
            observes: "followRef",
            label: { confidentiality: [secret] },
          }],
        },
      },
    });
    expect((await tx.commit()).ok).toBeDefined();
    const acquire = runtime.edit();
    const held = source.withTx(acquire).resolveAsCell();
    acquire.abort();
    return held.withTx(undefined);
  }

  for (const modern of [false, true]) {
    it(`retains send confidentiality on a cycle without other references (modern=${modern})`, async () => {
      setModernCellRepConfig(modern);
      const held = await selectedReference();
      type CyclicInput = { value: string; self?: CyclicInput };
      const input: CyclicInput = { value: "event value" };
      input.self = input;
      const send = runtime.edit();
      held.withTx(send).get();
      const event = serializeRuntimeEvent(input, send, space);
      send.abort();
      const payload = restoreRuntimeEventReferences(
        roundtrip(event.payload),
        event.runtimeReferenceContext,
      );
      const read = runtime.edit();
      try {
        const inputs = runtime.getImmutableCell(
          space,
          payload,
          undefined,
          read,
        );
        expect(inputs.key("self").key("value").get()).toBe("event value");
        expect(deriveFlowJoin(read).confidentiality).toContainEqual(secret);
      } finally {
        read.abort();
      }
    });

    for (const nested of [false, true]) {
      it(`retains acquired references through a cyclic event payload (modern=${modern}, nested=${nested})`, async () => {
        setModernCellRepConfig(modern);
        const held = await selectedReference();
        type CyclicInput = { item: typeof held; self?: CyclicInput };
        const input: CyclicInput = { item: held };
        input.self = input;
        const deliverySpace =
          (await Identity.fromPassphrase("event-cycle-destination")).did();
        const send = runtime.edit();
        const event = serializeRuntimeEvent(
          nested ? { nested: input } : input,
          send,
          deliverySpace,
        );
        send.abort();
        const payload = restoreRuntimeEventReferences(
          roundtrip(event.payload),
          event.runtimeReferenceContext,
        );
        const read = runtime.edit();
        try {
          const inputs = runtime.getImmutableCell(
            deliverySpace,
            payload,
            undefined,
            read,
          );
          const branch = nested ? inputs.key("nested") : inputs;
          expect(branch.key("self").key("item").get()).toBe("public value");
          expect(deriveFlowJoin(read).confidentiality).toContainEqual(secret);
        } finally {
          read.abort();
        }
      });
    }
  }

  it("retains selection confidentiality through a durable payload roundtrip", async () => {
    const held = await selectedReference();
    const send = runtime.edit();
    const event = serializeRuntimeEvent(
      { item: held.withTx(send) },
      send,
      space,
    );
    send.abort();
    const payload = restoreRuntimeEventReferences(
      roundtrip(event.payload),
      event.runtimeReferenceContext,
    );
    const read = runtime.edit();
    const inputs = runtime.getImmutableCell(space, payload, undefined, read);
    expect(inputs.key("item").get()).toBe("public value");
    expect(deriveFlowJoin(read).confidentiality).toContainEqual(secret);
    read.abort();
  });

  it("joins the sending attempt into local and durable reference history", async () => {
    const write = runtime.edit();
    const target = runtime.getCell(space, "send-target", undefined, write);
    const sensitive = runtime.getCell(space, "send-sensitive", {
      type: "string",
      ifc: { confidentiality: [otherSecret] },
    }, write);
    target.set("public value");
    sensitive.set("private choice");
    expect((await write.commit()).ok).toBeDefined();
    const send = runtime.edit();
    sensitive.withTx(send).get();
    const event = serializeRuntimeEvent(
      { item: target.withTx(send) },
      send,
      space,
    );
    for (
      const payload of [
        event.payload,
        restoreRuntimeEventReferences(
          roundtrip(event.payload),
          event.runtimeReferenceContext,
        ),
      ]
    ) {
      expect(
        getCfcReferenceProvenance((payload as { item: unknown }).item)
          ?.confidentiality,
      ).toContainEqual(otherSecret);
    }
    send.abort();
  });

  it("restores nested immutable acquisitions after the creating attempt aborts", async () => {
    const held = await selectedReference();
    const create = runtime.edit();
    const inner = runtime.getImmutableCell(
      space,
      { item: held.withTx(create) },
      undefined,
      create,
    );
    const outer = runtime.getImmutableCell(
      space,
      { nested: inner },
      undefined,
      create,
    );
    const event = serializeRuntimeEvent({ box: outer }, create, space);
    create.abort();
    const read = runtime.edit();
    const payload = restoreRuntimeEventReferences(
      roundtrip(event.payload),
      event.runtimeReferenceContext,
    );
    const inputs = runtime.getImmutableCell(space, payload, undefined, read);
    expect(inputs.key("box", "nested", "item").get()).toBe("public value");
    expect(deriveFlowJoin(read).confidentiality).toContainEqual(secret);
    read.abort();
  });

  it("retains scope caps independently of a widened carried schema", async () => {
    const write = runtime.edit();
    const target = runtime.getCell(
      space,
      "session-target",
      undefined,
      write,
      "session",
    );
    target.set("session value");
    const source = runtime.getCell(space, "scope-source", undefined, write);
    source.set(target);
    expect((await write.commit()).ok).toBeDefined();
    const send = runtime.edit();
    const held = source.withTx(send).asSchema({ scope: "space" }).asSchema({
      scope: "session",
    });
    const event = serializeRuntimeEvent({ item: held }, send, space);
    send.abort();
    const read = runtime.edit();
    const payload = restoreRuntimeEventReferences(
      roundtrip(event.payload),
      event.runtimeReferenceContext,
    );
    const inputs = runtime.getImmutableCell(space, payload, undefined, read);
    expect(inputs.key("item").get()).toBeUndefined();
    expect(target.withTx(read).get()).toBe("session value");
    read.abort();
  });

  it("restores shared immutable descendants reached through a subpath", async () => {
    const held = await selectedReference();
    const send = runtime.edit();
    const inner = runtime.getImmutableCell(
      space,
      { item: held },
      undefined,
      send,
    );
    const outer = runtime.getImmutableCell(
      space,
      { nested: { first: inner, second: inner } },
      undefined,
      send,
    );
    const event = serializeRuntimeEvent(
      { box: outer.key("nested") },
      send,
      space,
    );
    send.abort();
    const read = runtime.edit();
    const payload = restoreRuntimeEventReferences(
      roundtrip(event.payload),
      event.runtimeReferenceContext,
    );
    const input = runtime.getImmutableCell(space, payload, undefined, read);
    expect(input.key("box", "first", "item").get()).toBe("public value");
    expect(input.key("box", "second", "item").get()).toBe("public value");
    expect(deriveFlowJoin(read).confidentiality).toContainEqual(secret);
    read.abort();
  });

  for (const modern of [false, true]) {
    it(`retains current schema caps without transporting projection schemas (modern=${modern})`, async () => {
      setModernCellRepConfig(modern);
      setContentAddressedSchemasConfig(true);
      const write = runtime.edit();
      const target = runtime.getCell(
        space,
        "current-cap-target",
        undefined,
        write,
        "session",
      );
      target.set("session value");
      const source = runtime.getCell(
        space,
        "current-cap-source",
        undefined,
        write,
      );
      source.set(target);
      expect((await write.commit()).ok).toBeDefined();
      const send = runtime.edit();
      for (
        const schema of [
          { type: "string", scope: "space" },
          { type: "string", asCell: [{ kind: "cell", scope: "space" }] },
        ] as const
      ) {
        const held = source.withTx(send).asSchema(schema);
        expect(getCfcReferenceProvenance(held)?.scopeCaps).toBeUndefined();
        const event = serializeRuntimeEvent({ item: held }, send, space);
        // A source-only content-addressed schema cannot add a schema-document
        // dependency to admission in the destination space.
        expect(parseLink((event.payload as { item: never }).item)?.schema)
          .toEqual({ scope: "space" });
        const read = runtime.edit();
        const payload = restoreRuntimeEventReferences(
          roundtrip(event.payload),
          event.runtimeReferenceContext,
        );
        const inputs = runtime.getImmutableCell(
          space,
          payload,
          undefined,
          read,
        );
        expect(inputs.key("item").get()).toBeUndefined();
        expect(target.withTx(read).get()).toBe("session value");
        read.abort();
      }
      send.abort();
    });
  }

  it("captures the emitted ordinary binding of an acquired redirect Cell", async () => {
    const write = runtime.edit();
    const target = runtime.getCell(space, "redirect-target", undefined, write);
    target.set("public value");
    expect((await write.commit()).ok).toBeDefined();
    const send = runtime.edit();
    const redirected = runtime.getCellFromLink(
      {
        ...target.getAsNormalizedFullLink(),
        overwrite: "redirect",
      },
      undefined,
      send,
    );
    expect(getCfcReferenceProvenance(redirected)?.binding.overwrite).toBe(
      "redirect",
    );
    const event = serializeRuntimeEvent({ item: redirected }, send, space);
    send.abort();
    const payload = restoreRuntimeEventReferences(
      roundtrip(event.payload),
      event.runtimeReferenceContext,
    );
    expect(
      getCfcReferenceProvenance((payload as { item: unknown }).item)?.binding
        .overwrite,
    ).toBeUndefined();
    const read = runtime.edit();
    expect(
      runtime.getImmutableCell(space, payload, undefined, read).key("item")
        .get(),
    ).toBe("public value");
    read.abort();
  });

  it("rejects raw payload links without a private acquisition", async () => {
    const held = await selectedReference();
    const raw = roundtrip(held.getAsLink());
    const send = runtime.edit();
    expect(() => serializeRuntimeEvent({ item: raw }, send, space)).toThrow(
      "authenticated acquisition",
    );
    send.abort();
  });

  it("rejects an acquired link whose address changed during encoding", async () => {
    const held = await selectedReference();
    const original = held.getAsLink();
    const changed = carryCfcReferenceProvenance(
      original,
      linkRefFrom({
        ...linkRefPayload(original),
        path: ["substituted"],
      }),
    );
    const send = runtime.edit();
    expect(getCfcReferenceProvenance(changed)?.confidentiality)
      .toContainEqual(secret);
    expect(() => serializeRuntimeEvent({ item: changed }, send, space)).toThrow(
      "Invalid Runtime event reference context",
    );
    expect(() =>
      runtime.getImmutableCell(space, { item: changed }, undefined, send)
    )
      .toThrow("Reference acquisition is unresolved");
    send.abort();
  });

  it("rejects unproven links hidden inside an immutable value", async () => {
    const held = await selectedReference();
    const send = runtime.edit();
    const box = runtime.getImmutableCell(
      space,
      { item: roundtrip(held.getAsLink()) },
      undefined,
      send,
    );
    expect(() => serializeRuntimeEvent({ box }, send, space)).toThrow(
      "Invalid Runtime event reference context",
    );
    send.abort();
  });

  it("carries an independently acquired external address through event encoding", async () => {
    const held = await selectedReference();
    const input = runtime.acquireExternalInput(space, {
      item: roundtrip(held.getAsLink()),
    });
    const send = runtime.edit();
    const event = serializeRuntimeEvent(input, send, space);
    send.abort();
    const restored = restoreRuntimeEventReferences(
      roundtrip(event.payload),
      event.runtimeReferenceContext,
    ) as { item: unknown };
    expect(getCfcReferenceProvenance(restored.item)?.confidentiality).toEqual(
      [],
    );
    expect(getCfcReferenceProvenance(restored.item)?.binding)
      .toEqual(getCfcReferenceProvenance(held)?.binding);
  });

  it("refuses external immutable addresses with unproven nested references", async () => {
    const held = await selectedReference();
    const box = runtime.getImmutableCell(space, { item: held });
    const acquired = runtime.acquireExternalInput(space, {
      box: roundtrip(box.getAsLink()),
    });
    const send = runtime.edit();
    expect(() => serializeRuntimeEvent(acquired, send, space)).toThrow(
      "Invalid Runtime event reference context",
    );
    send.abort();
  });

  it("rejects altered payloads, binding substitutions and missing slot records", async () => {
    const held = await selectedReference();
    const send = runtime.edit();
    const event = serializeRuntimeEvent({ item: held }, send, space);
    send.abort();
    const context = cloneIfNecessary(
      fabricFromJsonValue(event.runtimeReferenceContext!),
      { frozen: false },
    ) as any;
    expect(() =>
      restoreRuntimeEventReferences(
        { changed: true },
        event.runtimeReferenceContext,
      )
    ).toThrow("Invalid Runtime event reference context");
    context.references[0].reference.binding.path = ["other"];
    expect(() =>
      restoreRuntimeEventReferences(
        roundtrip(event.payload),
        jsonFromFabricValue(context),
      )
    ).toThrow("Invalid Runtime event reference context");
    context.references = [];
    context.payloadHash = hashStringOf(event.payload);
    expect(() =>
      restoreRuntimeEventReferences(
        roundtrip(event.payload),
        jsonFromFabricValue(context),
      )
    ).toThrow("Invalid Runtime event reference context");
  });

  it("does not trust payload-owned context fields or a missing attestation", async () => {
    const held = await selectedReference();
    const send = runtime.edit();
    const event = serializeRuntimeEvent({ item: held }, send, space);
    send.abort();
    const raw = cloneIfNecessary(roundtrip(event.payload), {
      frozen: false,
    }) as Record<string, FabricValue>;
    raw.runtimeReferenceContext = event.runtimeReferenceContext;
    const payload = restoreRuntimeEventReferences(raw, undefined);
    expect(getCfcReferenceProvenance((payload as { item: unknown }).item))
      .toBeUndefined();
    const read = runtime.edit();
    expect(() =>
      runtime.getImmutableCell(space, payload, undefined, read).key("item")
        .get()
    ).toThrow("complete legacy provenance");
    read.abort();
  });

  it("rejects malformed acquisition and view records", async () => {
    const held = await selectedReference();
    const send = runtime.edit();
    const event = serializeRuntimeEvent({ item: held }, send, space);
    send.abort();
    const context = fabricFromJsonValue(event.runtimeReferenceContext!) as {
      version: number;
      payloadHash: string;
      references: Record<string, FabricValue>[];
    };
    const record = context.references[0];
    const reference = record.reference as Record<string, FabricValue>;
    const binding = reference.binding as Record<string, FabricValue>;
    const invalidRecords = [
      { ...record, path: [1] },
      { ...record, reference: null },
      { ...record, reference: { ...reference, binding: null } },
      { ...record, reference: { ...reference, confidentiality: null } },
      {
        ...record,
        reference: { ...reference, binding: { ...binding, scope: "inherit" } },
      },
      {
        ...record,
        reference: { ...reference, scopeCaps: [{ depth: -1, scope: "space" }] },
      },
      {
        ...record,
        reference: {
          ...reference,
          scopeCaps: [
            { depth: 0, scope: "any" },
            { depth: 0, scope: "session" },
          ],
        },
      },
      { ...record, viewConfidentiality: null },
      { ...record, immutableReferences: null },
      { ...record, view: { version: 2, entries: [] } },
      { ...record, view: { version: 1, entries: null } },
      ...[
        { path: [1], label: { confidentiality: [] } },
        { path: [], label: { confidentiality: null } },
        { path: [], label: { confidentiality: [], integrity: [] } },
        { path: [], label: { confidentiality: [] }, observes: "endorse" },
      ].map((entry) => ({ ...record, view: { version: 1, entries: [entry] } })),
    ];
    for (const invalid of invalidRecords) {
      expect(() =>
        restoreRuntimeEventReferences(
          roundtrip(event.payload),
          jsonFromFabricValue({ ...context, references: [invalid] }),
        )
      ).toThrow("Invalid Runtime event reference context");
    }
    for (
      const records of [
        [record, record],
        [record, { ...record, path: ["absent"] }],
      ]
    ) {
      expect(() =>
        restoreRuntimeEventReferences(
          roundtrip(event.payload),
          jsonFromFabricValue({ ...context, references: records }),
        )
      ).toThrow("Invalid Runtime event reference context");
    }
    const restored = restoreRuntimeEventReferences(
      roundtrip(event.payload),
      event.runtimeReferenceContext,
    ) as { item: FabricValue };
    expect(getCfcReferenceProvenance(restored.item)?.confidentiality)
      .toContainEqual(secret);
  });

  it("rejects immutable attestations whose source slot or target binding changed", async () => {
    const held = await selectedReference();
    const send = runtime.edit();
    const box = runtime.getImmutableCell(
      space,
      { item: held },
      undefined,
      send,
    );
    const event = serializeRuntimeEvent({ box }, send, space);
    send.abort();
    const context = fabricFromJsonValue(event.runtimeReferenceContext!) as {
      version: number;
      payloadHash: string;
      references: Record<string, FabricValue>[];
    };
    const record = context.references[0];
    const entries = record.immutableReferences as Record<string, FabricValue>[];
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    const source = entry.source as Record<string, FabricValue>;
    const reference = entry.reference as Record<string, FabricValue>;
    const binding = reference.binding as Record<string, FabricValue>;
    for (
      const invalid of [
        { ...entry, reference: null },
        { ...entry, source: null },
        { ...entry, source: { ...source, id: binding.id } },
        { ...entry, source: { ...source, path: [1] } },
        { ...entry, source: { ...source, path: ["absent"] } },
        { ...entry, source: { ...source, path: [] } },
        {
          ...entry,
          reference: { ...reference, binding: { ...binding, path: ["other"] } },
        },
      ]
    ) {
      expect(() =>
        restoreRuntimeEventReferences(
          roundtrip(event.payload),
          jsonFromFabricValue({
            ...context,
            references: [{ ...record, immutableReferences: [invalid] }],
          }),
        )
      ).toThrow("Invalid Runtime event reference context");
    }
    const read = runtime.edit();
    const restored = restoreRuntimeEventReferences(
      roundtrip(event.payload),
      event.runtimeReferenceContext,
    );
    expect(
      runtime.getImmutableCell(space, restored, undefined, read)
        .key("box", "item").get(),
    ).toBe("public value");
    expect(deriveFlowJoin(read).confidentiality).toContainEqual(secret);
    read.abort();
  });

  it("keeps primitive events free of reference metadata", () => {
    const tx = runtime.edit();
    const event = serializeRuntimeEvent({ amount: 3 }, tx, space);
    expect(event).toEqual({ payload: { amount: 3 } });
    expect(restoreRuntimeEventReferences(roundtrip(event.payload), undefined))
      .toEqual({ amount: 3 });
    tx.abort();
  });

  it("refuses an explicit relative link without acquisition evidence", () => {
    const send = runtime.edit();
    try {
      expect(() =>
        serializeRuntimeEvent({ self: linkRefFrom({ path: [] }) }, send, space)
      ).toThrow("authenticated acquisition");
    } finally {
      send.abort();
    }
  });
});
