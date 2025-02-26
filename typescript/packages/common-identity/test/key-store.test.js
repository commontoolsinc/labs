import { Identity } from "../lib/src/identity.js";
import { KeyStore } from "../lib/src/key-store.js";
import { assert } from "./utils.js";

describe("KeyStore", async () => {
  it("can store and recover keys", async () => {
    let store = await KeyStore.open("test-key-store-concurrent");
    await store.clear();

    let key = await Identity.generate();
    let did = key.verifier().did();
    await store.set("key", key);
    let recovered = await store.get("key");

    assert(did === recovered.verifier().did())
  });
});