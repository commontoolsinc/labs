import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { isDeepFrozen } from "@commonfabric/data-model/deep-freeze";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { URI } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("v2-transaction");
const space = signer.did();
const type = "application/json" as const;

/** The list shape a search index or an autocomplete list has. */
const list = (length: number) =>
  Array.from({ length }, (_, index) => ({
    label: `entry-${index}`,
    nested: { id: `id-${index}` },
  }));

/**
 * Writes a list of `length` records to one document, reads the whole list
 * back, and reports both what came back and how many property descriptors the
 * read took.
 *
 * A descriptor is the only thing that answers whether a property holds data or
 * an accessor, which is the question the fabric membership check asks of every
 * own property of every record it walks. So the count is how the membership
 * walk announces itself: a total that tracks the length of the list is that
 * walk running over the whole value.
 */
const wholeListRead = async (
  length: number,
): Promise<{ value: unknown; descriptors: number }> => {
  const storage = StorageManager.emulate({ as: signer });
  try {
    const tx = storage.edit();
    const id: URI = `of:v2-transaction-whole-list-${length}`;
    expect(tx.write({ space, id, type, path: [] }, { value: list(length) }).ok)
      .toBeTruthy();

    const descriptorOf = Object.getOwnPropertyDescriptor;
    let descriptors = 0;
    Object.getOwnPropertyDescriptor = ((
      ...args: Parameters<typeof Object.getOwnPropertyDescriptor>
    ) => {
      descriptors++;
      return descriptorOf(...args);
    }) as typeof Object.getOwnPropertyDescriptor;

    let read;
    try {
      read = tx.read({ space, id, type, path: ["value"] });
    } finally {
      Object.getOwnPropertyDescriptor = descriptorOf;
    }

    expect(read.ok).toBeTruthy();
    return { value: read.ok!.value, descriptors };
  } finally {
    await storage.close();
  }
};

describe("v2-transaction", () => {
  describe("read()", () => {
    it("takes the same number of property descriptors for a long list as for a short one", async () => {
      const short = await wholeListRead(20);
      const long = await wholeListRead(200);

      expect((short.value as unknown[]).length).toBe(20);
      expect((long.value as unknown[]).length).toBe(200);

      // What the read hands back is a value the write path already converted
      // to fabric form, so nothing about it has to be established a second
      // time. Both bounds are needed: the equality alone would hold for two
      // counts that each grew with their own list, and the bound alone would
      // hold for a count that grew slowly.
      expect(long.descriptors).toBe(short.descriptors);
      expect(long.descriptors).toBeLessThan(20);
    });

    it("returns a deep-frozen value", async () => {
      // The read owes its caller a value that later writes cannot change
      // under it. That is what the count above must not be bought with.
      const { value } = await wholeListRead(20);

      expect(isDeepFrozen(value)).toBe(true);
    });
  });
});
