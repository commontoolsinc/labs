import { beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromBase64url } from "@commonfabric/utils/base64url";
import {
  createHasher,
  type IncrementalHasher,
} from "@commonfabric/content-hash";
import { createHasherDeno } from "../src/sha256-deno.ts";
import { createHasherNoble } from "../src/sha256-noble.ts";
import {
  createHasherWasm,
  createHasherWasmCollecting,
  initWasm,
} from "../src/sha256-wasm.ts";
import { FIXTURES } from "./fixtures.ts";

const createFuncs = [
  createHasherDeno,
  createHasherNoble,
  createHasherWasm,
  createHasherWasmCollecting,
] as const;

beforeAll(async () => {
  if (!await initWasm()) {
    throw new Error("`sha256-wasm not available!");
  }
});

describe("createHasher()", () => {
  it("is one of the implementation functions", () => {
    const found = createFuncs.indexOf(createHasher);
    expect(found).not.toBe(-1);
  });
});

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

        it("byte-at-a-time use produces expected byte-array hash", () => {
          const hasher = createFunc();
          for (let i = 0; i < bytes.length; i++) {
            hasher.update(bytes.subarray(i, i + 1));
          }
          const got = hasher.digest();
          expect(got).toEqual(hashBytes);
        });

        it("multi-byte variety use produces expected byte-array hash", () => {
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

    it("can operate concurrently", () => {
      const CONCURRENT_COUNT = 10;
      let inProgress: {
        hasher: IncrementalHasher;
        bytes: Uint8Array;
        hashStr: string;
        done: boolean;
      }[] = [];

      let fixtureAt = 0;
      let chunkSize = 10;

      while (true) {
        while (inProgress.length < CONCURRENT_COUNT) {
          if (fixtureAt >= FIXTURES.length) {
            break;
          }
          inProgress.push({
            hasher: createFunc(),
            bytes: FIXTURES[fixtureAt].bytes,
            hashStr: FIXTURES[fixtureAt].sha256,
            done: false,
          });
          fixtureAt++;
        }

        if (inProgress.length === 0) {
          break;
        }

        for (const one of inProgress) {
          const chunk = one.bytes.subarray(0, chunkSize);
          one.bytes = one.bytes.subarray(chunkSize);
          one.hasher.update(chunk);
          if (one.bytes.length === 0) {
            const got = one.hasher.digest("base64url");
            expect(got).toBe(one.hashStr);
            one.done = true;
          }
        }

        // Filter out finished entries.
        inProgress = inProgress.filter((one) => !one.done);

        chunkSize = (Math.floor(chunkSize * 1.5) % 12345) + 1;
      }
    });
  });
}
