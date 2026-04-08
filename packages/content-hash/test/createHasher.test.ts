import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromBase64url } from "@commonfabric/utils/base64url";
import { createHasher } from "@commonfabric/content-hash";
import { FIXTURES } from "./fixtures.ts";

describe("createHasher()", () => {
  describe("one-shot action", () => {
    let i = 1;
    for (const { bytes, sha256: hashStr } of FIXTURES) {
      const hashMsg = `${hashStr.slice(0, 8)}...`;
      const hashBytes = fromBase64url(hashStr);
      const testId = i++;
      it(`produces expected string hash #${testId}: \`${hashMsg}...\``, () => {
        const hasher = createHasher();
        hasher.update(bytes);
        const got = hasher.digest("base64url");
        expect(got).toBe(hashStr);
      });
      it(`produces expected byte-array hash #${testId}}: \`${hashMsg}...\``, () => {
        const hasher = createHasher();
        hasher.update(bytes);
        const got = hasher.digest();
        expect(got).toEqual(hashBytes);
      });
    }
  });
});
