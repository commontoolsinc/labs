import { NativeEd25519 } from "../lib/src/ed25519/native.js";
import { NobleEd25519 } from "../lib/src/ed25519/noble.js";
import { bytesEqual, assert } from "./utils.js";

const TEST_PRIVATE_KEY = new Uint8Array([
  164, 139, 54, 62, 212, 90, 86, 224,
  244, 100, 52, 236, 147, 140, 201, 29,
  151, 157, 118, 38, 122, 147, 3, 110,
  96, 21, 167, 187, 206, 106, 94, 228
]);
const TEST_DID = "did:key:z6MkjosLwWEobyT9T6RqLTdaEhFrXAZUNkRZJuUae2ukgfEa";

describe("ed25519 comparison", async () => {
  it("ed25519 is supported in this environment", async () => {
    assert(await NativeEd25519.isSupported());
  });

  it("has same results in both impls when generating from noble", async () => {
    let noble = await NobleEd25519.generate();
    let native = await NativeEd25519.generateFromRaw(noble.keypair.privateKey);
    let buffer = new Uint8Array(32).fill(10);
    let nobleSig = await noble.sign(buffer);
    let nativeSig = await native.sign(buffer);
    assert(bytesEqual(nobleSig, nativeSig));
    // Impls verify other impl's sig
    assert(await noble.verify(nativeSig, buffer))
    assert(await native.verify(nobleSig, buffer))
    // Base case that should fail
    assert(!await noble.verify(nobleSig, new Uint8Array(32).fill(1)));
    assert(!await native.verify(nativeSig, new Uint8Array(32).fill(1)));
  });
});

describe("Native ed25519", () => {
  it("derives DID key", async () => {
    let key = await NativeEd25519.generateFromRaw(TEST_PRIVATE_KEY);
    let did = await key.did();
    assert(did === TEST_DID);
  });
});

describe("Noble ed25519", () => {
  it("derives DID key", async () => {
    let key = await NobleEd25519.generateFromRaw(TEST_PRIVATE_KEY);
    let did = await key.did();
    assert(did === TEST_DID);
  });
});