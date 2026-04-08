import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromBase64url } from "@commonfabric/utils/base64url";
import { createHasher } from "@commonfabric/content-hash";
import { createHasherDeno } from "../src/sha256-deno.ts";
import { createHasherWasm } from "../src/sha256-wasm.ts";
import { FIXTURES } from "./fixtures.ts";

const createFuncs = [
  createHasher,
  createHasherDeno,
  createHasherWasm,
] as const;

for (const createFunc of createFuncs) {
  describe(`${createFunc.name}()`, () => {
    let testId = -1;
    let oneLength = 10; // For multi-byte variety; updated pseudorandomly.

    for (const { bytes, sha256: hashStr } of FIXTURES) {
      const hashMsg = `\`${hashStr.slice(0, 8)}...\``;
      const hashBytes = fromBase64url(hashStr);
      testId++;

      describe(`for fixture #${testId}, hash ${hashMsg}`, () => {
        it("one-shot use produces expected string hash", () => {
          const hasher = createFunc();
          hasher.update(bytes);
          const got = hasher.digest("base64url");
          expect(got).toBe(hashStr);
        });

        it("one-shot use produces expected byte-array hash", () => {
          const hasher = createFunc();
          hasher.update(bytes);
          const got = hasher.digest();
          expect(got).toEqual(hashBytes);
        });

        it("byte-at-a-time use produces expected string hash", () => {
          const hasher = createFunc();
          for (let i = 0; i < bytes.length; i++) {
            hasher.update(bytes.subarray(i, i + 1));
          }
          const got = hasher.digest();
          expect(got).toEqual(hashBytes);
        });

        it("multi-byte variety use produces expected string hash", () => {
          const hasher = createFunc();
          let i = 0;
          while (i < bytes.length) {
            const someBytes = bytes.subarray(i, i + oneLength);
            hasher.update(someBytes);
            i += someBytes.length;
            oneLength = ((oneLength + 7) * 1123) % (bytes.length - i + 1) + 1;
          }
          const got = hasher.digest();
          expect(got).toEqual(hashBytes);
        });
      });
    }
  });
}
