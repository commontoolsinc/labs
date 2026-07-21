import { assert, assertEquals } from "@std/assert";
import { Identity } from "../src/identity.ts";
import { decode } from "@commonfabric/utils/encoding";
import { entropyToMnemonic, mnemonicToEntropy } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

Deno.test("Identity generates mnemonics", async () => {
  const [identity, mnemonic] = await Identity.generateMnemonic();
  const did = identity.verifier.did();
  const identity2 = await Identity.fromMnemonic(mnemonic);
  assert(did, identity2.verifier.did());
});

Deno.test("Can generate into/read from PKCS8", async () => {
  const pkcs8 = await Identity.generatePkcs8();
  assert(/^-----BEGIN PRIVATE KEY-----/.test(decode(pkcs8)));
  assert(/-----END PRIVATE KEY-----$/.test(decode(pkcs8)));
  const identity = await Identity.fromPkcs8(pkcs8);
  assert(identity.verifier.did());
  // Change a byte, should be invalid pkcs8
  pkcs8[1] = 0;
  let throws = false;
  try {
    await Identity.fromPkcs8(pkcs8);
  } catch (_) {
    throws = true;
  }
  assert(throws, "Identity.fromPkcs8() throws with invalid pkcs8");
});

Deno.test("BIP39 entropy is the raw seed — no KDF between", async () => {
  // THE contract device pairing rests on: `fromMnemonic` maps a phrase to BIP39
  // entropy and uses those bytes DIRECTLY as the ed25519 seed, so 32 bytes of
  // entropy and the 24 words encoding them name the same identity. A pairing QR
  // carries the entropy precisely because the words do not fit.
  //
  // This test — NOT any alias — is what makes that safe to rely on. If a KDF is
  // ever introduced into fromMnemonic, this fails loudly instead of silently
  // signing paired devices in under a different DID.
  const [identity, mnemonic] = await Identity.generateMnemonic();
  const entropy = mnemonicToEntropy(mnemonic, wordlist);

  assertEquals(entropy.length, 32);
  assertEquals((await Identity.fromRaw(entropy)).did(), identity.did());
});

Deno.test("fromRaw matches the pinned all-zero BIP39 vector", async () => {
  const identity = await Identity.fromRaw(new Uint8Array(32));
  assertEquals(
    identity.did(),
    "did:key:z6MkiTBz1ymuepAQ4HEHYSF1H8quG5GLVVQR3djdX3mDooWp",
  );
});

Deno.test("toEntropy round-trips an existing key back to its seed", async () => {
  // Closes the loop the pairing flow needs: a key that was NEVER generated from
  // a phrase can still be re-encoded as one, so nobody has to re-key.
  const pkcs8 = await Identity.generatePkcs8();
  const identity = await Identity.fromPkcs8(pkcs8, { implementation: "noble" });

  const entropy = identity.toEntropy();
  assertEquals(entropy.length, 32);
  assertEquals((await Identity.fromRaw(entropy)).did(), identity.did());

  // ...and it really is valid BIP39 entropy, so the words exist.
  const mnemonic = entropyToMnemonic(entropy, wordlist);
  assertEquals(mnemonic.split(" ").length, 24);
  assertEquals((await Identity.fromMnemonic(mnemonic)).did(), identity.did());
});

Deno.test("toEntropy is asymmetric — byte order is preserved", async () => {
  // The all-zero vector is a fixed point of reversal, so a test using only it
  // would pass even if the seed were mangled on the way out.
  const entropy = new Uint8Array(Array.from({ length: 32 }, (_, i) => i));
  const identity = await Identity.fromRaw(entropy, {
    implementation: "noble",
  });
  assertEquals(identity.toEntropy(), entropy);
});
