import { assertEquals, assertThrows } from "@std/assert";

import { assertValidPatternParams } from "../src/builder/factory-params.ts";
import { isReactiveMarker, type JSONSchema } from "../src/builder/types.ts";

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
