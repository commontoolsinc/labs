// What a reference declared `unknown` projects to on a whole-object read.
//
// `unknown` is the declaration a pattern reaches for when a field holds a
// REFERENCE it tests and compares but never reads through: anything wider
// retrieves the piece instead of pointing at it. The schema generator emits
// `{type: "unknown"}` for it, and traversal deliberately does not descend.
//
// Not descending is not the same as having nothing. The projection answers
// three questions and no others: is something there, is it the same thing as
// that, and where does it point when written back.
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { areLinksSame, parseLink } from "../src/link-utils.ts";
import type { JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("unknown reference");
const space = signer.did();

const innerSchema = {
  type: "object",
  properties: { field: { type: "string" } },
  required: ["field"],
} as const satisfies JSONSchema;

const holderSchema = {
  type: "object",
  properties: {
    refs: { type: "array", items: { type: "unknown" } },
    ref: { type: "unknown" },
  },
} as JSONSchema;

describe("a reference declared `unknown`", () => {
  /** Store a link to a live document as both an array element and a property. */
  const read = (label: string, write: boolean) => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const tx = runtime.edit();
    const inner = runtime.getCell(space, `inner-${label}`, innerSchema, tx);
    if (write) inner.set({ field: "secret" });
    const outer = runtime.getCell(space, `outer-${label}`, holderSchema, tx);
    outer.set({ refs: [inner], ref: inner } as never);
    const whole = outer.get() as { refs: unknown[]; ref: unknown };
    return {
      runtime,
      storageManager,
      tx,
      inner,
      element: whole.refs[0],
      property: whole.ref,
    };
  };

  const done = async (r: ReturnType<typeof read>) => {
    await r.tx.commit();
    await r.runtime.dispose();
    await r.storageManager.close();
  };

  it("is truthy when the target holds a value", async () => {
    const r = read("present", true);
    expect(Boolean(r.element)).toBe(true);
    expect(Boolean(r.property)).toBe(true);
    await done(r);
  });

  it("is falsy when the target was never written", async () => {
    const r = read("absent", false);
    expect(Boolean(r.element)).toBe(false);
    expect(Boolean(r.property)).toBe(false);
    await done(r);
  });

  it("compares equal to the cell it points at", async () => {
    const r = read("compare", true);
    const same = (v: unknown) =>
      areLinksSame(v, r.inner, undefined, true, r.tx, r.runtime);
    expect(same(r.element)).toBe(true);
    expect(same(r.property)).toBe(true);
    await done(r);
  });

  it("exposes nothing of the target's content", async () => {
    const r = read("opaque", true);
    // Own enumerable keys: the back-to-cell annotation is a non-enumerable
    // symbol, and is not content.
    expect(Object.keys(r.element as object)).toEqual([]);
    expect((r.element as { field?: string }).field).toBeUndefined();
    expect((r.property as { field?: string }).field).toBeUndefined();
    await done(r);
  });

  it("writes back as a link to the target, not an inline copy", async () => {
    const r = read("writeback", true);
    const sink = r.runtime.getCell(space, "sink", holderSchema, r.tx);
    sink.set({ refs: [r.element], ref: r.element } as never);
    const stored = (sink.getRaw() as { refs: unknown[] }).refs[0];
    const link = parseLink(stored, sink.getAsNormalizedFullLink());
    expect(link?.id).toBe(r.inner.getAsNormalizedFullLink().id);
    await done(r);
  });
});
