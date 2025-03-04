import { assert } from "@std/assert";
import { Identity } from "../src/identity.ts";

Deno.test("Identity generates mnemonics", async () => {
  const [identity, mnemonic] = await Identity.generateMnemonic();
  const did = identity.verifier().did();
  const identity2 = await Identity.fromMnemonic(mnemonic);
  assert(did, identity2.verifier().did());
});
