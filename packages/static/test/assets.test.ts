import { decode } from "@commonfabric/utils/encoding";
import { assert } from "@std/assert";
import { TEST_ASSET, TEST_ASSET_CONTENT, TestStaticCache } from "../utils.ts";

Deno.test("get() and getText() returns static data", async () => {
  const cache = new TestStaticCache();
  const buffer = await cache.get(TEST_ASSET);
  const text = await cache.getText(TEST_ASSET);
  assert(decode(buffer) === text, "buffer and text match");
  assert(text.includes(TEST_ASSET_CONTENT), "Expected asset contents");
});

Deno.test("getUrl() returns asset URL", async () => {
  const cache = new TestStaticCache();
  const url = await cache.getUrl(TEST_ASSET);
  assert(url.pathname.endsWith(`/${TEST_ASSET}`), "Expected URL path");
});
