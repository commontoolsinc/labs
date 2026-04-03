import { deepEqual } from "@commontools/utils/deep-equal";

// Create test fixtures once, outside the benchmarks
const denseArray1000 = Array.from({ length: 1000 }, (_, i) => i);
const denseArray1000Copy = Array.from({ length: 1000 }, (_, i) => i);
const denseArray1000Different = Array.from(
  { length: 1000 },
  (_, i) => i === 999 ? -1 : i,
);

const denseObjectArray1000 = Array.from({ length: 1000 }, (_, i) => ({
  id: i,
  name: `item-${i}`,
}));
const denseObjectArray1000Copy = Array.from({ length: 1000 }, (_, i) => ({
  id: i,
  name: `item-${i}`,
}));

Deno.bench(
  "deepEqual - 1000-element dense number arrays (equal)",
  { group: "dense-arrays" },
  () => {
    deepEqual(denseArray1000, denseArray1000Copy);
  },
);

Deno.bench(
  "deepEqual - 1000-element dense number arrays (different at end)",
  { group: "dense-arrays" },
  () => {
    deepEqual(denseArray1000, denseArray1000Different);
  },
);

Deno.bench(
  "deepEqual - 1000-element dense object arrays (equal)",
  { group: "dense-arrays" },
  () => {
    deepEqual(denseObjectArray1000, denseObjectArray1000Copy);
  },
);

Deno.bench(
  "deepEqual - same array reference (identity check)",
  { group: "dense-arrays" },
  () => {
    deepEqual(denseArray1000, denseArray1000);
  },
);
