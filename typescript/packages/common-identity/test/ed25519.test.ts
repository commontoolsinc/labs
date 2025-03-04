import {
  isNativeEd25519Supported,
  NativeEd25519Signer,
  NativeEd25519Verifier,
} from "../src/ed25519/native.ts";
import {
  NobleEd25519Signer,
  NobleEd25519Verifier,
} from "../src/ed25519/noble.ts";
import { assert } from "@std/assert";
import { bytesEqual } from "./utils.ts";
import { DID } from "../src/interface.ts";
import * as ed25519 from "@noble/ed25519";

type SignerImpl = NativeEd25519Signer | NobleEd25519Signer;
type VerifierImpl = NativeEd25519Verifier | NobleEd25519Verifier;
interface SignerClass {
  fromRaw(rawPrivateKey: Uint8Array): Promise<SignerImpl>;
}
interface VerifierClass {
  fromDid(did: DID): Promise<VerifierImpl>;
  fromRaw(rawPrivateKey: Uint8Array): Promise<VerifierImpl>;
}

const TEST_PRIVATE_KEY = new Uint8Array([
  164,
  139,
  54,
  62,
  212,
  90,
  86,
  224,
  244,
  100,
  52,
  236,
  147,
  140,
  201,
  29,
  151,
  157,
  118,
  38,
  122,
  147,
  3,
  110,
  96,
  21,
  167,
  187,
  206,
  106,
  94,
  228,
]);
const TEST_DID = "did:key:z6MkjosLwWEobyT9T6RqLTdaEhFrXAZUNkRZJuUae2ukgfEa";

Deno.test("ed25519 is supported in this environment", async () => {
  assert(await isNativeEd25519Supported());
});

Deno.test("has same results in both impls when generating from noble", async () => {
  // Use @noble/ed25519 directly, otherwise the private key isn't accessible.
  const privateKey = ed25519.utils.randomPrivateKey();
  const noble = await NobleEd25519Signer.fromRaw(privateKey);
  const native = await NativeEd25519Signer.fromRaw(privateKey);
  const buffer = new Uint8Array(32).fill(10);
  const nobleSig = await noble.sign(buffer);
  const nativeSig = await native.sign(buffer);
  const nobleVerifier = noble.verifier();
  const nativeVerifier = native.verifier();
  assert(bytesEqual(nobleSig, nativeSig));
  // Impls verify other impl's sig
  assert(await nobleVerifier.verify(nativeSig, buffer));
  assert(await nativeVerifier.verify(nobleSig, buffer));
  // Base case that should fail
  assert(!await nobleVerifier.verify(nobleSig, new Uint8Array(32).fill(1)));
  assert(!await nativeVerifier.verify(nativeSig, new Uint8Array(32).fill(1)));
});

// These tests are run with both Native and Noble implementations.
// Code at the start and end of the `describe` function sets this up.
testBothImpls(
  "derives DID key",
  async (Signer: SignerClass, _Verifier: VerifierClass) => {
    const signer = await Signer.fromRaw(TEST_PRIVATE_KEY);
    const verifier = signer.verifier();
    const did = verifier.did();
    assert(did === TEST_DID);
  },
);

testBothImpls(
  "derives bytes from DID key and back",
  async (
    _Signer: SignerClass,
    Verifier: VerifierClass,
  ) => {
    // @see https://w3c-ccg.github.io/did-method-key/#test-vectors
    const fixtures: DID[] = [
      "did:key:z6MkiTBz1ymuepAQ4HEHYSF1H8quG5GLVVQR3djdX3mDooWp",
      "did:key:z6MkjchhfUsD6mmvni8mCdXHw216Xrm9bQe2mBH1P5RDjVJG",
      "did:key:z6MknGc3ocHs3zdPiJbnaaqDi58NGb4pk1Sp9WxWufuXSdxf",
    ];

    for (const fixture of fixtures) {
      const verifier = await Verifier.fromDid(fixture);
      assert(verifier.did() === fixture);
    }
  },
);

// Run tests with both implentations
function testBothImpls(
  name: string,
  fn: (signer: SignerClass, verifier: VerifierClass) => void | Promise<void>,
) {
  Deno.test(`(native) ${name}`, async () => {
    return await fn(NativeEd25519Signer, NativeEd25519Verifier);
  });
  Deno.test(`(noble) ${name}`, async () => {
    return await fn(NobleEd25519Signer, NobleEd25519Verifier);
  });
}
