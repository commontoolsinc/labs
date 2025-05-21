import { decode } from "@commontools/utils/encoding";
import { assert } from "@std/assert";
import { getAsset, getAssetText, getAssetUrl } from "../index.ts";

Deno.test("getAsset() and getAssetText() returns static data", async () => {
  const buffer = await getAsset("es2023.d.ts");
  const text = await getAssetText("es2023.d.ts");
  assert(decode(buffer) === text, "buffer and text match");
  assert(/interface ClassDecoratorContext/.test(text), "es2023.d.ts in text");
});

Deno.test("getAssetUrl() returns URL", async () => {
  const url = await getAssetUrl("es2023.d.ts");
  assert(/es2023.d.ts/.test(url.toString()));
});
