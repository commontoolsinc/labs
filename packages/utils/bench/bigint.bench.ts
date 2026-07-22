/**
 * BigInt encoding/decoding performance benchmarks.
 *
 * Measures `bigintToMinimalTwosComplement()` and
 * `bigintFromMinimalTwosComplement()` using both implementations and across the
 * full byte-length spectrum, with separate positive/negative tracks. Sizes
 * 1-127 sweep in single-byte steps so several discontinuities are visible: the
 * 8-byte fast-path boundary (both directions switch from a
 * `DataView.{set,get}BigUint64()` fast path to a per-byte fallback) and the
 * 32-byte large-negative-decoder crossover. Sizes 128, 256, 512 sample the
 * deep-fallback regime; 1008..1039 brackets 1024 to expose `partials` cost
 * (`bytes.length & 7`) at very large sizes.
 *
 * Each iteration of a benchmark function processes a fixed BATCH of values
 * pre-generated with a deterministic xorshift RNG, so JIT specialization on
 * a single repeated value can't skew the result. The reported `ns/iter` is
 * per BATCH; divide by BATCH for per-operation cost.
 *
 * Generated values lie in the upper half of each byte-size band (positive
 * v in [2^(8b-2), 2^(8b-1)-1], negative v = -p for p in the same range), so
 * encoded magnitudes are guaranteed to need exactly b bytes. The encoder's
 * sign-extension `byteLen++` branch (taken for values straddling a byte
 * boundary) is not benchmarked separately; add a third track if its cost is
 * of interest.
 *
 * Decoder inputs are produced by running the encoder over the same generated
 * bigints, so the encode and decode benchmarks for a given (size, sign)
 * exercise inverse operations on matching data.
 *
 * Run with: deno bench --no-check bench/bigint.bench.ts
 */

import {
  bigintFromMtcDirect,
  bigintToMtcDirect,
} from "../src/bigint-uint8-direct.ts";
import {
  bigintFromMtcHex,
  bigintToMtcHex,
} from "../src/bigint-uint8-hex-string.ts";

const BATCH = 64;

const BYTE_SIZES: readonly number[] = (() => {
  const set = new Set<number>();
  for (let i = 1; i <= 127; i++) set.add(i);
  set.add(128);
  set.add(256);
  set.add(512);
  for (let i = 1008; i <= 1039; i++) set.add(i);
  return [...set].sort((a, b) => a - b);
})();

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  if (s === 0) s = 0x9e3779b9; // xorshift can't start at 0
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s;
  };
}

/**
 * Build a positive bigint that requires exactly `bytes` bytes when encoded
 * as minimal two's complement. Forces bit (8*bytes - 2) so the value lies in
 * the upper half of the band, then fills the remaining magnitude bits from
 * `rng`.
 */
function makePositive(bytes: number, rng: () => number): bigint {
  const magBits = 8 * bytes - 1; // sign bit must be 0 in the canonical form
  let v = 1n << BigInt(magBits - 1);
  let bitsLeft = magBits - 1;
  let shift = 0n;
  while (bitsLeft > 0) {
    if (bitsLeft >= 32) {
      v |= BigInt(rng()) << shift;
      shift += 32n;
      bitsLeft -= 32;
    } else {
      const mask = (1 << bitsLeft) - 1;
      v |= BigInt(rng() & mask) << shift;
      bitsLeft = 0;
    }
  }
  return v;
}

function makeBatch(bytes: number, sign: 1n | -1n, seed: number): bigint[] {
  const rng = makeRng(seed);
  const out: bigint[] = [];
  for (let i = 0; i < BATCH; i++) {
    out.push(sign * makePositive(bytes, rng));
  }
  return out;
}

const IMPLS: ReadonlyArray<{
  readonly name: string;
  readonly biToMtc: (value: bigint) => Uint8Array;
  readonly biFromMtc: (bytes: Uint8Array) => bigint;
}> = [
  {
    name: "direct",
    biToMtc: bigintToMtcDirect,
    biFromMtc: bigintFromMtcDirect,
  },
  {
    name: "hex",
    biToMtc: bigintToMtcHex,
    biFromMtc: bigintFromMtcHex,
  },
];

for (const { name: implName, biToMtc, biFromMtc } of IMPLS) {
  const isBaselineImpl = implName === IMPLS[0]!.name;

  const encodeBatch = (values: bigint[]): Uint8Array[] => {
    return values.map((v) => biToMtc(v));
  };

  // Warm up both directions to avoid measuring JIT compilation in the first
  // reported bucket.
  {
    const warmSmallVals = makeBatch(8, 1n, 1);
    const warmLargeVals = makeBatch(64, -1n, 2);
    const warmSmallBytes = encodeBatch(warmSmallVals);
    const warmLargeBytes = encodeBatch(warmLargeVals);
    for (let i = 0; i < 200; i++) {
      for (const v of warmSmallVals) biToMtc(v);
      for (const v of warmLargeVals) biToMtc(v);
      for (const b of warmSmallBytes) biFromMtc(b);
      for (const b of warmLargeBytes) biFromMtc(b);
    }
  }

  for (const bytes of BYTE_SIZES) {
    const positives = makeBatch(bytes, 1n, bytes * 31 + 1);
    const negatives = makeBatch(bytes, -1n, bytes * 31 + 2);
    const positiveBytes = encodeBatch(positives);
    const negativeBytes = encodeBatch(negatives);
    // Pad the group key so Deno bench's grouped output sorts in size order.
    const groupKey = String(bytes).padStart(4, "0");
    const encodeGroup = `encode-${groupKey}B`;
    const decodeGroup = `decode-${groupKey}B`;
    const label = `${bytes}B`;

    Deno.bench({
      name: `encode positive ${label} ${implName} (${BATCH} ops)`,
      group: encodeGroup,
      baseline: isBaselineImpl,
      fn() {
        for (let i = 0; i < BATCH; i++) {
          biToMtc(positives[i]!);
        }
      },
    });

    Deno.bench({
      name: `encode negative ${label} ${implName} (${BATCH} ops)`,
      group: encodeGroup,
      fn() {
        for (let i = 0; i < BATCH; i++) {
          biToMtc(negatives[i]!);
        }
      },
    });

    Deno.bench({
      name: `decode positive ${label} ${implName} (${BATCH} ops)`,
      group: decodeGroup,
      baseline: isBaselineImpl,
      fn() {
        for (let i = 0; i < BATCH; i++) {
          biFromMtc(positiveBytes[i]!);
        }
      },
    });

    Deno.bench({
      name: `decode negative ${label} ${implName} (${BATCH} ops)`,
      group: decodeGroup,
      fn() {
        for (let i = 0; i < BATCH; i++) {
          biFromMtc(negativeBytes[i]!);
        }
      },
    });
  }
}
