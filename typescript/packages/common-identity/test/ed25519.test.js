import { NativeEd25519Signer, NativeEd25519Verifier, isNativeEd25519Supported } from "../lib/src/ed25519/native.js";
import { NobleEd25519Signer, NobleEd25519Verifier } from "../lib/src/ed25519/noble.js";
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
    assert(await isNativeEd25519Supported());
  });

  it("has same results in both impls when generating from noble", async () => {
    let noble = await NobleEd25519Signer.generate();
    let native = await NativeEd25519Signer.fromRaw(noble.keypair.privateKey);
    let buffer = new Uint8Array(32).fill(10);
    let nobleSig = await noble.sign(buffer);
    let nativeSig = await native.sign(buffer);
    let nobleVerifier = noble.verifier();
    let nativeVerifier = native.verifier();
    assert(bytesEqual(nobleSig, nativeSig));
    // Impls verify other impl's sig
    assert(await nobleVerifier.verify(nativeSig, buffer))
    assert(await nativeVerifier.verify(nobleSig, buffer))
    // Base case that should fail
    assert(!await nobleVerifier.verify(nobleSig, new Uint8Array(32).fill(1)));
    assert(!await nativeVerifier.verify(nativeSig, new Uint8Array(32).fill(1)));
  });
});

// These tests are run with both Native and Noble implementations.
// Code at the start and end of the `describe` function sets this up.
describe("ed25519", () => {
  let innerIt = globalThis.it;
  const tests = []; 
  const it = (name, fn) => tests.push({ name, fn });

  it("derives DID key", async (Signer) => {
    let signer = await Signer.fromRaw(TEST_PRIVATE_KEY);
    let verifier = signer.verifier();
    let did = await verifier.did();
    assert(did === TEST_DID);
  });

  it("derives bytes from DID key and back", async (Signer, Verifier) => {
    // @see https://w3c-ccg.github.io/did-method-key/#test-vectors
    const fixtures = [
      'did:key:z6MkiTBz1ymuepAQ4HEHYSF1H8quG5GLVVQR3djdX3mDooWp',
      'did:key:z6MkjchhfUsD6mmvni8mCdXHw216Xrm9bQe2mBH1P5RDjVJG',
      'did:key:z6MknGc3ocHs3zdPiJbnaaqDi58NGb4pk1Sp9WxWufuXSdxf',
    ];

    for (let fixture of fixtures) {
      let verifier = await Verifier.fromDid(fixture);
      assert(await verifier.did() === fixture);
    }
  });

  // Run all tests with both implentations
  for (let { name, fn } of tests) {
    innerIt(`(native) ${name}`, async () => {
      return await fn(NativeEd25519Signer, NativeEd25519Verifier); 
    });
    innerIt(`(noble) ${name}`, async () => {
      return await fn(NobleEd25519Signer, NobleEd25519Verifier); 
    });
  }
});