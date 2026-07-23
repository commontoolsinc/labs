import { assertEquals } from "@std/assert";
import { extractAPI } from "./openapi-extract.ts";

Deno.test("extractAPI renders tuple (prefixItems) schemas as tuple types", () => {
  // CT-1895: tuples used to render as bare "array"
  const spec = {
    openapi: "3.1.0",
    info: { title: "Tuples", version: "1.0.0" },
    paths: {
      "/things": {
        get: {
          operationId: "listThings",
          parameters: [{
            name: "range",
            in: "query",
            schema: {
              type: "array",
              prefixItems: [{ type: "integer" }, { type: "integer" }],
            },
          }],
          responses: { "200": { description: "ok" } },
        },
      },
    },
    components: {
      schemas: {
        Thing: {
          type: "object",
          properties: {
            pair: {
              type: "array",
              prefixItems: [{ type: "string" }, { type: "number" }],
            },
            rest: {
              type: "array",
              prefixItems: [{ type: "string" }],
              items: { type: "boolean" },
            },
            plain: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
  };

  const api = extractAPI(spec as Record<string, unknown>);

  const thing = api.models.find((m) => m.name === "Thing");
  assertEquals(thing?.properties["pair"].type, "[string, number]");
  assertEquals(thing?.properties["rest"].type, "[string, ...array<boolean>]");
  assertEquals(thing?.properties["plain"].type, "array<string>");

  const endpoint = api.endpoints.find((e) => e.operationId === "listThings");
  const range = endpoint?.parameters.find((p) => p.name === "range");
  assertEquals(range?.type, "[integer, integer]");
});
