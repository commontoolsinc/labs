import { assert, assertEquals } from "@std/assert";
import { schemaToTypeString } from "../src/schema-format.ts";

// Tests for schemaToTypeString - TypeScript-like schema representation

Deno.test("schemaToTypeString converts basic types", () => {
  assertEquals(schemaToTypeString({ type: "string" } as any), "string");
  assertEquals(schemaToTypeString({ type: "number" } as any), "number");
  assertEquals(schemaToTypeString({ type: "boolean" } as any), "boolean");
  assertEquals(schemaToTypeString({ type: "null" } as any), "null");
});

Deno.test("schemaToTypeString converts arrays", () => {
  const schema: any = {
    type: "array",
    items: { type: "string" },
  };
  assertEquals(schemaToTypeString(schema), "string[]");
});

Deno.test("schemaToTypeString converts objects with properties", () => {
  const schema: any = {
    type: "object",
    properties: {
      name: { type: "string" },
      age: { type: "number" },
    },
  };
  const result = schemaToTypeString(schema);
  assert(result.includes("name?:"));
  assert(result.includes("string"));
  assert(result.includes("age?:"));
  assert(result.includes("number"));
});

Deno.test("schemaToTypeString marks required fields without ?", () => {
  const schema: any = {
    type: "object",
    properties: {
      name: { type: "string" },
      age: { type: "number" },
    },
    required: ["name"],
  };
  const result = schemaToTypeString(schema);
  assert(result.includes("name:"), "required field should not have ?");
  assert(result.includes("age?:"), "optional field should have ?");
});

Deno.test("schemaToTypeString converts Stream to function syntax", () => {
  const schema: any = {
    type: "object",
    asCell: ["stream"],
    properties: {
      value: { type: "string" },
    },
  };
  const result = schemaToTypeString(schema);
  assert(result.includes("=>"), "Stream should use arrow function syntax");
  assert(result.includes("void"), "Stream should return void");
  assert(result.includes("value"), "Stream props should be included");
});

Deno.test("schemaToTypeString converts Cell to Cell<T> syntax", () => {
  const schema: any = {
    type: "object",
    asCell: ["cell"],
    properties: {
      count: { type: "number" },
    },
  };
  const result = schemaToTypeString(schema);
  assert(result.startsWith("Cell<"), "Cell should use Cell<> syntax");
  assert(result.includes("count"), "Cell contents should be included");
});

Deno.test("schemaToTypeString converts opaque cells to FactoryInput", () => {
  assertEquals(
    schemaToTypeString({
      type: "string",
      asCell: ["opaque"],
    } as any),
    "FactoryInput",
  );
});

Deno.test('schemaToTypeString formats asCell: ["stream", "cell"] as Stream<Cell<T>>', () => {
  const schema: any = {
    type: "number",
    asCell: ["stream", "cell"],
  };

  const result = schemaToTypeString(schema);
  assertEquals(result, "(Cell<number>) => void");
});

Deno.test("schemaToTypeString restores scope wrappers", () => {
  assertEquals(
    schemaToTypeString({
      type: "string",
      scope: "user",
    } as any),
    "PerUser<string>",
  );
  assertEquals(
    schemaToTypeString({
      type: "string",
      scope: "any",
    } as any),
    "PerAny<string>",
  );
  assertEquals(
    schemaToTypeString({
      type: "string",
      asCell: [{ kind: "cell", scope: "session" }],
    } as any),
    "PerSession<Cell<string>>",
  );
});

Deno.test("schemaToTypeString handles enums as union literals", () => {
  const schema: any = {
    enum: ["open", "closed", "pending"],
  };
  const result = schemaToTypeString(schema);
  assertEquals(result, '"open" | "closed" | "pending"');
});

Deno.test("schemaToTypeString resolves $ref from $defs", () => {
  const schema: any = {
    $ref: "#/$defs/MyType",
  };
  const defs: any = {
    MyType: { type: "string" },
  };
  const result = schemaToTypeString(schema, { defs });
  assertEquals(result, "string");
});

Deno.test("schemaToTypeString uses type name for large $ref definitions", () => {
  const schema: any = {
    $ref: "#/$defs/LargeType",
  };
  const defs: any = {
    LargeType: {
      type: "object",
      properties: {
        field1: { type: "string" },
        field2: { type: "number" },
        field3: { type: "boolean" },
        field4: { type: "string" },
        field5: { type: "number" },
      },
    },
  };
  const result = schemaToTypeString(schema, { defs });
  assertEquals(result, "LargeType");
});

Deno.test("schemaToTypeString skips $-prefixed properties", () => {
  const schema: any = {
    type: "object",
    properties: {
      $UI: { type: "object" },
      $TYPE: { type: "string" },
      name: { type: "string" },
    },
  };
  const result = schemaToTypeString(schema);
  assert(!result.includes("$UI"), "$UI should be skipped");
  assert(!result.includes("$TYPE"), "$TYPE should be skipped");
  assert(result.includes("name"), "regular props should be included");
});

Deno.test("schemaToTypeString handles anyOf as union", () => {
  const schema: any = {
    anyOf: [{ type: "string" }, { type: "number" }],
  };
  const result = schemaToTypeString(schema);
  assertEquals(result, "string | number");
});

Deno.test("schemaToTypeString limits recursion depth", () => {
  const deepSchema: any = {
    type: "object",
    properties: {
      a: {
        type: "object",
        properties: {
          b: {
            type: "object",
            properties: {
              c: {
                type: "object",
                properties: {
                  d: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
  };
  const result = schemaToTypeString(deepSchema, { maxDepth: 3 });
  assert(result.includes("{...}"), "Deep nesting should be abbreviated");
});

Deno.test("schemaToTypeString produces compact output for complex schema", () => {
  // This is the example from the user's request
  const schema: any = {
    type: "object",
    properties: {
      test: { type: "string" },
      count: { type: "number" },
      person: {
        type: "object",
        properties: {
          name: { type: "string" },
          email: { type: "string" },
        },
      },
      doAnAction: {
        type: "object",
        asCell: ["stream"],
        properties: {
          parameter: { type: "number" },
        },
      },
      aCell: {
        type: "object",
        asCell: ["cell"],
        properties: {
          subfield: { type: "string" },
        },
      },
    },
  };
  const result = schemaToTypeString(schema);

  // Check key features of the output
  assert(result.includes("test?:"), "should have test property");
  assert(result.includes("string"), "should have string type");
  assert(result.includes("count?:"), "should have count property");
  assert(result.includes("number"), "should have number type");
  assert(result.includes("person?:"), "should have person property");
  assert(result.includes("doAnAction?:"), "should have doAnAction property");
  assert(result.includes("=> void"), "doAnAction should be a handler");
  assert(result.includes("aCell?:"), "should have aCell property");
  assert(result.includes("Cell<"), "aCell should use Cell wrapper");
});

Deno.test("schemaToTypeString formats a first-class PatternFactory contract", () => {
  const result = schemaToTypeString({
    asFactory: {
      kind: "pattern",
      argumentSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      resultSchema: {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
      },
    },
  });

  assert(result.includes("=>"));
  assert(result.includes("query"));
  assert(result.includes("answer"));
  assert(!result.includes("extraParams"));
});
