import { Identity } from "../lib/src/identity.js";
import { assert } from "./utils.js";

describe("Identity", async () => {
  it("generates mnemonics", async () => {
    let [identity, mnemonic] = await Identity.generateMnemonic();
    let did = identity.verifier().did();
    let identity2 = await Identity.fromMnemonic(mnemonic);
    assert(did, identity2.verifier().did());
  });
});