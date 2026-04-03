import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { encode } from "@commonfabric/utils/encoding";
import { cf, checkStderr } from "./utils.ts";
import { Identity } from "@commonfabric/identity";

const PKCS8_KEY = `-----BEGIN PRIVATE KEY-----
MMC4CAQAwBQYDK2VwBCIEICWSvx4QOW+mogjWSsjInQaPpmjErsDBqf2ZOoK+Y4IO
-----END PRIVATE KEY-----`;
const PKCS8_KEY_DID =
  "did:key:z6MkspRA3aXp7T1GmTo92Q33EV33oJSNDzaoKkFUV5WkW9NC";

// DID from an identity derived from the passphrase "common user"
const COMMON_USER_DID =
  "did:key:z6Mkj5HyygpAVo2baUcx7kwTRoUbbBmk5egUQPHnV8arQ3SY";

describe("cli id", () => {
  it("Creates a new key", async () => {
    const { code, stdout, stderr } = await cf("id new");
    const keyBuffer = encode(stdout.join("\n"));
    await Identity.fromPkcs8(keyBuffer);
    expect(code).toBe(0);
    checkStderr(stderr);
  });

  it("Reads DID from key", async () => {
    const temp = await Deno.makeTempFile();
    await Deno.writeFile(temp, encode(PKCS8_KEY));
    const { code, stdout, stderr } = await cf(`id did ${temp}`);
    const did = stdout.join("\n");
    expect(did).toBe(PKCS8_KEY_DID);
    expect(code).toBe(0);
    checkStderr(stderr);
  });

  it("Reads DID from key", async () => {
    const { code, stdout, stderr } = await cf(`id derive "common user"`);
    const keyBuffer = encode(stdout.join("\n"));
    const identity = await Identity.fromPkcs8(keyBuffer);
    expect(identity.did()).toBe(COMMON_USER_DID);
    expect(code).toBe(0);
    checkStderr(stderr);
  });
});
