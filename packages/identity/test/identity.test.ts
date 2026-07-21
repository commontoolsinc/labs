import { assert, assertEquals } from "@std/assert";
import { Identity } from "../src/identity.ts";
import { fromPEM, pkcs8ToEd25519Raw } from "../src/ed25519/utils.ts";
import { decode } from "@commonfabric/utils/encoding";
import { mnemonicToEntropy } from "@scure/bip39";
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

Deno.test("fromEntropy reaches the same identity as the mnemonic it encodes", async () => {
  // The contract device pairing rests on: BIP39 entropy is used DIRECTLY as
  // the ed25519 seed, with no KDF between, so 32 bytes of entropy and the 24
  // words encoding them name the same identity. A pairing QR carries the
  // entropy precisely because the words do not fit. If a KDF were ever added
  // to fromMnemonic without updating fromEntropy, this fails loudly instead of
  // silently signing paired devices in under a different DID.
  const [identity, mnemonic] = await Identity.generateMnemonic();
  const entropy = mnemonicToEntropy(mnemonic, wordlist);

  assertEquals(entropy.length, 32);
  assertEquals((await Identity.fromEntropy(entropy)).did(), identity.did());
});

Deno.test("fromEntropy matches the pinned all-zero BIP39 vector", async () => {
  const identity = await Identity.fromEntropy(new Uint8Array(32));
  assertEquals(
    identity.did(),
    "did:key:z6MkiTBz1ymuepAQ4HEHYSF1H8quG5GLVVQR3djdX3mDooWp",
  );
});

Deno.test("pkcs8 helpers are reachable from the package root", async () => {
  // Exported so downstream consumers stop deep-importing ed25519/utils.ts.
  const pkcs8 = await Identity.generatePkcs8();
  const raw = pkcs8ToEd25519Raw(fromPEM(pkcs8));
  assertEquals(raw.length, 32);
  // The raw seed IS the entropy, which closes the loop: an EXISTING key can be
  // re-encoded as a pairing phrase without anyone having to re-key.
  assertEquals(
    (await Identity.fromEntropy(raw)).did(),
    (await Identity.fromPkcs8(pkcs8)).did(),
  );
});
