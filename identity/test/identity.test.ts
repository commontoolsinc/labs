import { assert } from "@std/assert";
import { Identity } from "../src/identity.ts";
import { decode } from "@commontools/utils/encoding";

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
    const identity = await Identity.fromPkcs8(pkcs8);
  } catch (e) {
    throws = true;
  }
  assert(throws, "Identity.fromPkcs8() throws with invalid pkcs8");
});
