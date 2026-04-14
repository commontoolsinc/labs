/**
 * Benchmarks comparing the three SHA-256 implementations across all fixtures
 * and three call styles:
 *
 * * `sha256()` -- all-at-once function.
 * * `createHasher()` one-shot -- a single `update()` then `digest()`.
 * * `createHasher()` multi-byte variety -- many `update()` calls with
 *   pseudo-randomly varying chunk sizes (mirrors the unit test of the same
 *   name).
 *
 * Benchmarks are grouped by implementation (`sha256Deno`, `sha256Noble`,
 * `sha256Wasm`).
 */

import { createHasherDeno, sha256Deno } from "../src/sha256-deno.ts";
import { createHasherNoble, sha256Noble } from "../src/sha256-noble.ts";
import { createHasherWasm, initWasm, sha256Wasm } from "../src/sha256-wasm.ts";
import type { IncrementalHasher, Sha256Fn } from "../src/interface.ts";
import { FIXTURES } from "../test/fixtures.ts";

await initWasm();

type CreateHasherFn = () => IncrementalHasher;

interface Impl {
  name: string;
  sha256: Sha256Fn;
  createHasher: CreateHasherFn;
}

const IMPLS: readonly Impl[] = [
  { name: "sha256Deno", sha256: sha256Deno, createHasher: createHasherDeno },
  { name: "sha256Noble", sha256: sha256Noble, createHasher: createHasherNoble },
  { name: "sha256Wasm", sha256: sha256Wasm, createHasher: createHasherWasm },
];

/**
 * Incremental hashing with varying chunk sizes, matching the "multi-byte
 * variety" unit test.
 */
function hashMultiVariety(
  createHasher: CreateHasherFn,
  bytes: Uint8Array,
  startingChunk: number,
): Uint8Array {
  const hasher = createHasher();
  let oneLength = startingChunk;
  let i = 0;
  while (i < bytes.length) {
    const someBytes = bytes.subarray(i, i + oneLength);
    hasher.update(someBytes);
    i += someBytes.length;
    oneLength = ((oneLength + 7) * 1123) % (bytes.length - i + 1) + 1;
  }
  return hasher.digest();
}

for (const impl of IMPLS) {
  let fixtureId = 0;
  for (const { bytes } of FIXTURES) {
    const id = fixtureId++;
    const sizeLabel = `${bytes.length}B`;
    const fixtureLabel = `#${String(id).padStart(2, "0")} (${sizeLabel})`;

    Deno.bench({
      name: `${fixtureLabel} sha256()`,
      group: impl.name,
      fn: () => {
        impl.sha256(bytes);
      },
    });

    Deno.bench({
      name: `${fixtureLabel} createHasher() one-shot`,
      group: impl.name,
      fn: () => {
        const hasher = impl.createHasher();
        hasher.update(bytes);
        hasher.digest();
      },
    });

    Deno.bench({
      name: `${fixtureLabel} createHasher() multi-variety`,
      group: impl.name,
      fn: () => {
        hashMultiVariety(impl.createHasher, bytes, 10);
      },
    });
  }
}
