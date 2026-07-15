import {
  assertEquals,
  assertNotEquals,
  assertNotStrictEquals,
  assertStrictEquals,
} from "@std/assert";
import type { SchemaPathSelector } from "@commonfabric/api";
import type { MIME, URI } from "@commonfabric/memory/interface";
import { watchIdForEntry } from "../src/storage/v2.ts";
import { normalizeSyncSelector } from "../src/storage/v2-watch.ts";

Deno.test("memory v2 watch ids include branch in the stable key", () => {
  const address = {
    id: "of:watch-id-branch" as URI,
    type: "application/json" as MIME,
  };
  const selector: SchemaPathSelector = {
    path: [],
    schema: false,
  };

  assertEquals(
    watchIdForEntry(address, selector, "main"),
    watchIdForEntry(address, selector, "main"),
  );
  assertNotEquals(
    watchIdForEntry(address, selector, ""),
    watchIdForEntry(address, selector, "feature"),
  );
});

Deno.test("memory v2 selector normalization ignores unused definitions", () => {
  const selectorWith = (name: string): SchemaPathSelector => ({
    path: ["value", "title"],
    schema: {
      type: "object",
      properties: { title: { type: "string" } },
      $defs: {
        [name]: {
          type: "object",
          properties: { value: { type: "number" } },
        },
      },
    },
  });

  const left = normalizeSyncSelector(selectorWith("UnusedLeft"));
  const right = normalizeSyncSelector(selectorWith("UnusedRight"));

  assertEquals(left.schema, {
    type: "object",
    properties: { title: { type: "string" } },
  });
  assertStrictEquals(left, right);
});

Deno.test("memory v2 selector normalization ignores nested unused definitions", () => {
  const selectorWith = (
    unusedName: string,
    usedType: "string" | "number" = "string",
  ): SchemaPathSelector => ({
    path: ["nested"],
    schema: {
      type: "object",
      properties: {
        nested: {
          $ref: "#/$defs/Used",
          $defs: {
            Used: { type: usedType },
            [unusedName]: { type: "boolean" },
          },
        },
        plain: {
          type: "object",
          properties: { value: { type: "string" } },
          $defs: { [`${unusedName}Plain`]: { type: "null" } },
        },
      },
    },
  });

  const left = normalizeSyncSelector(selectorWith("UnusedLeft"));
  const right = normalizeSyncSelector(selectorWith("UnusedRight"));
  const different = normalizeSyncSelector(
    selectorWith("UnusedLeft", "number"),
  );

  assertEquals(left.schema, {
    type: "object",
    properties: {
      nested: {
        $ref: "#/$defs/Used",
        $defs: { Used: { type: "string" } },
      },
      plain: {
        $defs: {},
        type: "object",
        properties: { value: { type: "string" } },
      },
    },
  });
  assertStrictEquals(left, right);
  assertNotStrictEquals(left, different);
  assertNotEquals(left.schema, different.schema);
});

Deno.test("memory v2 selector normalization ignores inherited definition names", () => {
  const normalized = normalizeSyncSelector({
    path: [],
    schema: {
      $ref: "#/$defs/toString",
      $defs: { Present: { type: "string" } },
    },
  });

  assertEquals(normalized.schema, { $ref: "#/$defs/toString" });
});
