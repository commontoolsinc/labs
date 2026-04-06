import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromBase64url } from "@commonfabric/utils/base64url";
import { sha256 } from "@commonfabric/content-hash";
import { FIXTURES } from "./fixtures.ts";

describe("sha256()", () => {
  let i = 1;
  for (const { bytes, sha256: hashStr } of FIXTURES) {
    const hashMsg = `${hashStr.slice(0, 8)}...`;
    const hashBytes = fromBase64url(hashStr);
    it(`produces expected byte-array hash #${i++}: \`${hashMsg}...\``, () => {
      const got = sha256(bytes);
      expect(got).toEqual(hashBytes);
    });
  }
});
