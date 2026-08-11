import { beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromBase64url } from "@commonfabric/utils/base64url";
import {
  createHasher,
  type IncrementalHasher,
} from "@commonfabric/content-hash";
import { createHasherDeno } from "@/sha256-deno.ts";
import { createHasherNoble } from "@/sha256-noble.ts";
import {
  createHasherWasm,
  createHasherWasmCollecting,
  initWasm,
} from "@/sha256-wasm.ts";
import { FIXTURES } from "./fixtures.ts";

const createFuncs = [
  createHasherDeno,
  createHasherNoble,
  createHasherWasm,
  createHasherWasmCollecting,
] as const;

beforeAll(async () => {
  if (!await initWasm()) {
    throw new Error("`sha256-wasm` not available!");
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

    describe("after `digest()`", () => {
      const alreadyDone = /`digest\(\)` already done/;

      // A small update is the interesting case: implementations that buffer
      // small writes can satisfy one without consulting the underlying hasher.
      it("throws given a small `update()`", () => {
        const hasher = createFunc();
        hasher.update(new Uint8Array([1, 2, 3]));
        hasher.digest();
        expect(() => hasher.update(new Uint8Array([4]))).toThrow(alreadyDone);
      });

      it("throws given an `update()` too large to buffer", () => {
        const hasher = createFunc();
        hasher.update(new Uint8Array([1, 2, 3]));
        hasher.digest();
        expect(() => hasher.update(new Uint8Array(4096))).toThrow(alreadyDone);
      });

      it("throws given a second `digest()`", () => {
        const hasher = createFunc();
        hasher.update(new Uint8Array([1, 2, 3]));
        hasher.digest();
        expect(() => hasher.digest()).toThrow(alreadyDone);
      });
    });

    for (const { bytes, sha256: hashStr } of FIXTURES) {
      const hashMsg = `\`${hashStr.slice(0, 8)}...\``;
      const hashBytes = fromBase64url(hashStr);
      testId++;

      describe(`for fixture #${testId}, hash ${hashMsg}`, () => {
        it("produces the expected string hash from one-shot use", () => {
          const hasher = createFunc();
          hasher.update(bytes);
          const got = hasher.digest("base64url");
          expect(got).toBe(hashStr);
        });

        it("produces the expected byte-array hash from one-shot use", () => {
          const hasher = createFunc();
          hasher.update(bytes);
          const got = hasher.digest();
          expect(got).toEqual(hashBytes);
        });

        it("produces the expected byte-array hash from byte-at-a-time use", () => {
          const hasher = createFunc();
          for (let i = 0; i < bytes.length; i++) {
            hasher.update(bytes.subarray(i, i + 1));
          }
          const got = hasher.digest();
          expect(got).toEqual(hashBytes);
        });

        it("produces the expected byte-array hash from varied multi-byte use", () => {
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

    it("produces the expected hashes from interleaved instances", () => {
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
