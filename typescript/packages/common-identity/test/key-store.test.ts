import { Identity } from "../src/identity.ts";
import { KeyStore } from "../src/key-store.ts";
import { assert } from "@std/assert";

Deno.test("KeyStore can store and recover keys", async () => {
  const store = await KeyStore.open("test-key-store-concurrent");
  await store.clear();

  const key = await Identity.generate();
  const did = key.verifier.did();
  await store.set("key", key);
  const recovered = await store.get("key");

  assert(recovered && did === recovered.verifier.did());
});
