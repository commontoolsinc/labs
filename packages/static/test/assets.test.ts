import { decode } from "@commontools/utils/encoding";
import { assert } from "@std/assert";
import { TestStaticCache } from "../utils.ts";

Deno.test("get() and getText() returns static data", async () => {
  const cache = new TestStaticCache();
  const buffer = await cache.get("prompts/system.md");
  const text = await cache.getText("prompts/system.md");
  assert(decode(buffer) === text, "buffer and text match");
  assert(
    /# React Component Builder/.test(text),
    "Expected type contents",
  );
});

Deno.test("getUrl() returns asset URL", async () => {
  const cache = new TestStaticCache();
  const url = await cache.getUrl("prompts/system.md");
  assert(
    /prompts\/system.md/.test(url.toString()),
    "Expected URL path",
  );
});
