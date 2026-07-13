import { assertEquals, assertThrows } from "@std/assert";
import { Identity } from "@commonfabric/identity";

import { assertValidPatternParams } from "../src/builder/factory-params.ts";
import { isReactiveMarker, type JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

function symbolic(schema: JSONSchema): unknown {
  return {
    [isReactiveMarker]: true,
    export: () => ({ schema }),
  };
}

Deno.test("pattern curry accepts an optional cell schema as one symbolic value", () => {
  const roomSchema = {
    type: "object",
    properties: {
      name: { type: "string" },
      messages: {
        type: "array",
        items: { $ref: "#/$defs/ChatMessage" },
      },
    },
    required: ["name", "messages"],
  } as const satisfies JSONSchema;
  const chatMessageSchema = {
    type: "object",
    properties: { body: { type: "string" } },
    required: ["body"],
  } as const satisfies JSONSchema;
  const sourceSchema = {
    $defs: { Room: roomSchema, ChatMessage: chatMessageSchema },
    $ref: "#/$defs/Room",
    asCell: [{ kind: "cell", scope: "session" }],
  } as const satisfies JSONSchema;
  const paramsSchema = {
    type: "object",
    properties: {
      selectedRoomRef: {
        anyOf: [
          { type: "undefined" },
          { $ref: "#/$defs/Room" },
        ],
        asCell: ["cell"],
      },
    },
    required: ["selectedRoomRef"],
    $defs: { Room: roomSchema, ChatMessage: chatMessageSchema },
  } as const satisfies JSONSchema;

  assertEquals(
    assertValidPatternParams(
      { selectedRoomRef: symbolic(sourceSchema) },
      paramsSchema,
    ),
    undefined,
  );
});

Deno.test("pattern curry still rejects a symbolic schema outside the union", () => {
  const paramsSchema = {
    type: "object",
    properties: {
      value: {
        anyOf: [{ type: "undefined" }, { type: "string" }],
        asCell: ["cell"],
      },
    },
    required: ["value"],
  } as const satisfies JSONSchema;

  assertThrows(
    () =>
      assertValidPatternParams(
        {
          value: symbolic({ type: "number", asCell: ["cell"] }),
        },
        paramsSchema,
      ),
    TypeError,
    "value does not match anyOf",
  );
});

Deno.test("pattern curry accepts a source schema that is stricter than capture metadata", () => {
  const requiredIfc = {
    ownerPrincipal: { __ctCurrentPrincipal: true },
    addIntegrity: [{ kind: "represents-principal" }],
  } as const;
  const paramsSchema = {
    type: "object",
    properties: {
      elements: { ifc: requiredIfc, asCell: ["cell"] },
    },
    required: ["elements"],
  } as const satisfies JSONSchema;
  const sourceSchema = {
    type: "array",
    items: { type: "object" },
    ifc: {
      writeAuthorizedBy: {
        __ctWriterIdentityOf: {
          file: "/profile.tsx",
          path: ["mutateElements"],
        },
      },
      ...requiredIfc,
    },
    asCell: [{ kind: "cell", scope: "space" }],
  } as const satisfies JSONSchema;

  assertEquals(
    assertValidPatternParams(
      { elements: symbolic(sourceSchema) },
      paramsSchema,
    ),
    undefined,
  );
});

Deno.test("pattern curry realizes a serialized cell scope from its schema", () => {
  const paramsSchema = {
    type: "object",
    properties: {
      selected: {
        type: "string",
        asCell: [{ kind: "cell", scope: "session" }],
      },
    },
    required: ["selected"],
  } as const satisfies JSONSchema;
  const selected = {
    "/": {
      "link@1": {
        id: "of:selected",
        path: [],
        scope: "space",
        schema: { type: "string", scope: "session" },
      },
    },
  };

  assertEquals(
    assertValidPatternParams({ selected }, paramsSchema),
    undefined,
  );
});

Deno.test("pattern curry accepts a capability-shrunk stream event schema", () => {
  const expectedEvent = {
    type: "object",
    properties: {
      name: { type: "string" },
      target: {
        type: "object",
        properties: {
          name: { type: "string" },
          value: { type: "string" },
        },
      },
    },
  } as const satisfies JSONSchema;
  const sourceEvent = {
    type: "object",
    properties: {
      name: { type: "string" },
      target: {
        type: "object",
        properties: { name: { type: "string" } },
      },
    },
  } as const satisfies JSONSchema;
  const paramsSchema = {
    type: "object",
    properties: {
      onSelect: { $ref: "#/$defs/ExpectedEvent", asCell: ["stream"] },
    },
    required: ["onSelect"],
    $defs: { ExpectedEvent: expectedEvent },
  } as const satisfies JSONSchema;

  assertEquals(
    assertValidPatternParams(
      { onSelect: symbolic({ ...sourceEvent, asCell: ["stream"] }) },
      paramsSchema,
    ),
    undefined,
  );
  assertThrows(
    () =>
      assertValidPatternParams(
        { onSelect: symbolic({ ...sourceEvent, asCell: ["cell"] }) },
        paramsSchema,
      ),
    TypeError,
    "cell kind mismatch",
  );
});

Deno.test("pattern curry resolves nested refs for a capability-shrunk stream", async () => {
  const signer = await Identity.fromPassphrase(
    "factory-params-nested-stream-ref-test",
  );
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const itemSchema = {
    type: "object",
    properties: {
      title: { type: "string" },
      indent: { type: "number", default: 0 },
    },
    required: ["title", "indent"],
  } as const satisfies JSONSchema;
  const sourceEventSchema = {
    type: "object",
    properties: {
      item: {
        type: "object",
        properties: { indent: { type: "number", default: 0 } },
        required: ["indent"],
      },
    },
    required: ["item"],
  } as const satisfies JSONSchema;
  const paramsSchema = {
    type: "object",
    properties: {
      removeItem: {
        type: "object",
        properties: { item: { $ref: "#/$defs/Item" } },
        required: ["item"],
        asCell: ["stream"],
      },
    },
    required: ["removeItem"],
    $defs: { Item: itemSchema },
  } as const satisfies JSONSchema;

  try {
    const { pattern, handler } = createTrustedBuilder(runtime).commonfabric;
    pattern(
      () => {
        const removeItem = handler(
          sourceEventSchema,
          true,
          () => undefined,
        )({});
        assertEquals(
          assertValidPatternParams({ removeItem }, paramsSchema),
          undefined,
        );
        return {};
      },
      true,
      true,
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("pattern curry accepts the same rooted ref from a stricter source schema", () => {
  const item = {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
  } as const satisfies JSONSchema;
  const paramsSchema = {
    type: "object",
    properties: {
      items: {
        anyOf: [
          { type: "undefined" },
          { type: "array", items: { $ref: "#/$defs/Item" } },
        ],
      },
    },
    required: ["items"],
    $defs: { Item: item },
  } as const satisfies JSONSchema;
  const sourceSchema = {
    type: "array",
    items: { $ref: "#/$defs/Item" },
    default: [],
    $defs: { Item: item },
    asCell: ["cell"],
  } as const satisfies JSONSchema;

  assertEquals(
    assertValidPatternParams({ items: symbolic(sourceSchema) }, paramsSchema),
    undefined,
  );
});

Deno.test("pattern curry validates a symbolic Cell default when content schema is deferred", () => {
  const paramsSchema = {
    type: "object",
    properties: {
      body: {
        type: "object",
        additionalProperties: true,
        asCell: ["cell"],
      },
    },
    required: ["body"],
  } as const satisfies JSONSchema;

  assertEquals(
    assertValidPatternParams(
      {
        body: symbolic({
          default: { text: "hello" },
          asCell: ["cell"],
        }),
      },
      paramsSchema,
    ),
    undefined,
  );
});

Deno.test("pattern curry trusts an empty deferred schema only on a real Cell", async () => {
  const signer = await Identity.fromPassphrase(
    "factory-params-deferred-cell-test",
  );
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const paramsSchema = {
    type: "object",
    properties: {
      candidates: {
        type: "array",
        items: { type: "object", properties: { title: { type: "string" } } },
      },
    },
    required: ["candidates"],
  } as const satisfies JSONSchema;

  try {
    const deferredCell = runtime.getCell(
      signer.did(),
      "factory-params-deferred-cell",
      {},
    );
    assertEquals(
      assertValidPatternParams({ candidates: deferredCell }, paramsSchema),
      undefined,
    );
    assertThrows(
      () =>
        assertValidPatternParams(
          { candidates: symbolic({}) },
          paramsSchema,
        ),
      TypeError,
      "symbolic binding schema mismatch",
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});
