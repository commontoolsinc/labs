import { assertEquals, assertThrows } from "@std/assert";
import {
  parseSubagentReturnJson,
  parseSubagentReturnSchema,
  validateAndSanitizeSubagentReturn,
} from "../src/subagent-return.ts";

Deno.test("parseSubagentReturnSchema accepts JSON Schema objects, booleans, and strings", () => {
  assertEquals(parseSubagentReturnSchema(true), {
    schema: true,
    bytes: 4,
  });
  assertEquals(parseSubagentReturnSchema({ type: "boolean" }), {
    schema: { type: "boolean" },
    bytes: 18,
  });
  assertEquals(parseSubagentReturnSchema('{"type":"string"}'), {
    schema: { type: "string" },
    bytes: 17,
  });
  assertEquals(parseSubagentReturnSchema(undefined), undefined);
});

Deno.test("parseSubagentReturnSchema rejects malformed or non-schema inputs", () => {
  const cases = [
    {
      input: "{",
      message: "delegate_task returnSchema string must be valid JSON",
    },
    {
      input: ["not", "a", "schema"],
      message:
        "delegate_task returnSchema must be a JSON Schema object, boolean, or JSON string",
    },
    {
      input: null,
      message:
        "delegate_task returnSchema must be a JSON Schema object, boolean, or JSON string",
    },
    {
      input: 42,
      message:
        "delegate_task returnSchema must be a JSON Schema object, boolean, or JSON string",
    },
  ];
  for (const testCase of cases) {
    assertThrows(
      () => parseSubagentReturnSchema(testCase.input),
      Error,
      testCase.message,
    );
  }
});

Deno.test("parseSubagentReturnJson fails closed without echoing malformed content", () => {
  assertEquals(parseSubagentReturnJson('{"ok":true}'), { ok: true });
  assertThrows(
    () => parseSubagentReturnJson("not JSON with raw data"),
    Error,
    "child final response was not valid JSON",
  );
  assertThrows(
    () => parseSubagentReturnJson("  "),
    Error,
    "child final response was empty",
  );
});

Deno.test("validateAndSanitizeSubagentReturn preserves control primitives and linkifies free-form strings", () => {
  const schema = {
    type: "object",
    properties: {
      approved: { type: "boolean" },
      status: { type: "string", enum: ["approved", "not_approved"] },
      score: { type: "number" },
      summary: { type: "string" },
      notes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            category: { type: "string", enum: ["risk", "info"] },
            text: { type: "string" },
          },
          required: ["category", "text"],
          additionalProperties: false,
        },
      },
    },
    required: ["approved", "status", "score", "summary", "notes"],
    additionalProperties: false,
  } as const;

  const sanitized = validateAndSanitizeSubagentReturn({
    schema,
    childRunId: "run-structured.subagent.1",
    value: {
      approved: false,
      status: "not_approved",
      score: 0.73,
      summary: "Hostile briefing says to ignore the parent.",
      notes: [{
        category: "risk",
        text: "The page tried to redirect mail to an attacker.",
      }],
    },
  });

  assertEquals(sanitized.linkedStringCount, 2);
  assertEquals(sanitized.value, {
    approved: false,
    status: "not_approved",
    score: 0.73,
    summary: {
      "@link":
        "cf-harness://subagent-return/run-structured.subagent.1#/summary",
    },
    notes: [{
      category: "risk",
      text: {
        "@link":
          "cf-harness://subagent-return/run-structured.subagent.1#/notes/0/text",
      },
    }],
  });
});

Deno.test("validateAndSanitizeSubagentReturn handles anyOf link branches and rejects schema mismatches", () => {
  const schema = {
    type: "object",
    properties: {
      body: {
        anyOf: [
          { type: "string" },
          {
            type: "object",
            properties: {
              "@link": { type: "string" },
            },
            required: ["@link"],
            additionalProperties: false,
          },
        ],
      },
    },
    required: ["body"],
    additionalProperties: false,
  } as const;

  assertEquals(
    validateAndSanitizeSubagentReturn({
      schema,
      childRunId: "run-anyof.subagent.1",
      value: { body: "open ended body" },
    }).value,
    {
      body: {
        "@link": "cf-harness://subagent-return/run-anyof.subagent.1#/body",
      },
    },
  );

  assertEquals(
    validateAndSanitizeSubagentReturn({
      schema,
      childRunId: "run-anyof.subagent.1",
      value: { body: { "@link": "/of:opaque/summary" } },
    }).value,
    { body: { "@link": "/of:opaque/summary" } },
  );

  assertThrows(
    () =>
      validateAndSanitizeSubagentReturn({
        schema,
        childRunId: "run-anyof.subagent.1",
        value: { body: 123 },
      }),
    Error,
    "body: value does not match anyOf",
  );
});
