import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("memory-v2-comparison");
const space = signer.did();

const mulberry32 = (seed: number) => {
  let current = seed >>> 0;
  return () => {
    current |= 0;
    current = (current + 0x6d2b79f5) | 0;
    let t = Math.imul(current ^ (current >>> 15), 1 | current);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const randomInt = (random: () => number, maxExclusive: number) =>
  Math.floor(random() * maxExclusive);

const randomValue = (random: () => number, step: number) => ({
  step,
  flag: random() > 0.5,
  text: `value-${step}-${randomInt(random, 1000)}`,
  nested: {
    count: randomInt(random, 10),
    label: `nested-${randomInt(random, 100)}`,
  },
  list: Array.from(
    { length: randomInt(random, 4) + 1 },
    () => randomInt(random, 50),
  ),
});

describe("Memory v2 comparison", () => {
  it("matches v1 provider-visible behavior for a randomized basic workload", async () => {
    const v1 = StorageManager.emulate({ as: signer, memoryVersion: "v1" });
    const v2 = StorageManager.emulate({ as: signer, memoryVersion: "v2" });
    const v1Provider = v1.open(space);
    const v2Provider = v2.open(space);
    const random = mulberry32(0x5eedc0de);
    const uris = Array.from(
      { length: 6 },
      (_, index) => `of:memory-v2-compare-${index}` as const,
    );

    try {
      for (let step = 0; step < 40; step++) {
        const uri = uris[randomInt(random, uris.length)];
        const shouldDelete = random() < 0.25;
        const value = shouldDelete
          ? undefined
          : randomValue(random, step);

        const batch = [{
          uri,
          value: { value },
        }];

        expect(await v1Provider.send(batch)).toEqual({ ok: {} });
        expect(await v2Provider.send(batch)).toEqual({ ok: {} });

        for (const currentUri of uris) {
          expect(v2Provider.get(currentUri)).toEqual(v1Provider.get(currentUri));
        }
      }
    } finally {
      await v1.close();
      await v2.close();
    }
  });
});
