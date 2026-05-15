import { assertEquals } from "@std/assert";
import {
  buildDiffSync,
  buildFullSync,
  cacheKeyForEntity,
  toCacheEntry,
} from "../v2/server-sync.ts";

Deno.test("memory v2 session cache entries always include scope", () => {
  assertEquals(
    toCacheEntry({
      branch: "",
      id: "of:space",
      seq: 1,
      document: { value: { label: "space" } },
    }),
    {
      branch: "",
      id: "of:space",
      scope: "space",
      seq: 1,
      doc: { value: { label: "space" } },
    },
  );
  assertEquals(
    toCacheEntry({
      branch: "",
      id: "of:deleted",
      scope: "user",
      seq: 2,
      document: null,
    }),
    {
      branch: "",
      id: "of:deleted",
      scope: "user",
      seq: 2,
      deleted: true,
    },
  );
});

Deno.test("memory v2 session sync removes include scope", () => {
  const previous = new Map([
    [cacheKeyForEntity("", "of:space", "space"), {
      branch: "",
      id: "of:space",
      scope: "space" as const,
      seq: 1,
      doc: { value: {} },
    }],
    [cacheKeyForEntity("", "of:user", "user"), {
      branch: "",
      id: "of:user",
      scope: "user" as const,
      seq: 1,
      doc: { value: {} },
    }],
  ]);

  assertEquals(buildFullSync(previous, new Map(), 1, 2).removes, [{
    branch: "",
    id: "of:space",
    scope: "space",
  }, {
    branch: "",
    id: "of:user",
    scope: "user",
  }]);
  assertEquals(buildDiffSync(previous, new Map(), 1, 2).removes, [{
    branch: "",
    id: "of:space",
    scope: "space",
  }, {
    branch: "",
    id: "of:user",
    scope: "user",
  }]);
});
