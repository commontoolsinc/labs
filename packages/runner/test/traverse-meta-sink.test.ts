import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { type MetaRail, sinkMetaLinkedDocKeys } from "../src/traverse.ts";
import type { ScopeKeyIdentity } from "@commonfabric/memory/v2";

const space = "did:key:z6Mk-traverse-meta-sink";
const identity: ScopeKeyIdentity = {
  principal: "did:key:z6MkPrincipal",
  sessionId: "session-1",
};
const link = (id: string) => ({ "/": { "link@1": { id, space } } });

type Entry = Parameters<typeof sinkMetaLinkedDocKeys>[0];
const entry = (value: unknown): Entry =>
  ({
    address: { space, id: "of:referrer", path: [] },
    value,
  }) as unknown as Entry;

const sunk = (value: unknown, meta: MetaRail): string[] => {
  const keys: string[] = [];
  sinkMetaLinkedDocKeys(
    entry(value),
    meta,
    identity,
    (key: string, referrerKey: string) => {
      keys.push(`${key}<-${referrerKey}`);
    },
  );
  return keys;
};

describe("traverse-meta-sink", () => {
  // `sinkMetaLinkedDocKeys` is the key-only half of the metadata walk: it
  // derives each target key of one rail from the links the document already
  // carries and hands them to the sink, reading nothing. The rails differ in
  // where their links sit — a manifest of entries for `internal`, one link
  // per rail otherwise, with `cfc` holding a schema hash rather than a link.

  it("sinks every manifest entry of the internal rail", () => {
    const keys = sunk(
      {
        value: {},
        internal: [
          { link: link("of:derived-a") },
          { link: link("of:derived-b") },
          { kind: "computed" },
        ],
      },
      "internal",
    );
    expect(keys.length).toBe(2);
    expect(keys[0]).toContain("of:derived-a");
    expect(keys[0]).toContain("of:referrer");
    expect(keys[1]).toContain("of:derived-b");
  });

  it("sinks nothing for an internal rail that is not a manifest", () => {
    expect(sunk({ value: {}, internal: { link: link("of:x") } }, "internal"))
      .toEqual([]);
  });

  it("sinks a single-link rail's target", () => {
    const keys = sunk({ value: {}, result: link("of:result-doc") }, "result");
    expect(keys.length).toBe(1);
    expect(keys[0]).toContain("of:result-doc");
  });

  it("sinks the cfc rail's schema document by its hash", () => {
    const keys = sunk({ value: {}, cfc: { schemaHash: "abc123" } }, "cfc");
    expect(keys.length).toBe(1);
    expect(keys[0]).toContain("cid:abc123");
  });

  it("sinks nothing for a rail the document does not carry", () => {
    expect(sunk({ value: {} }, "argument")).toEqual([]);
    expect(sunk({ value: {}, cfc: { other: true } }, "cfc")).toEqual([]);
  });

  it("resolves a manifest link without an id against the document itself", () => {
    const keys = sunk(
      { value: {}, internal: [{ link: { "/": { "link@1": {} } } }] },
      "internal",
    );
    expect(keys.length).toBe(1);
    expect(keys[0].split("<-")[0]).toContain("of:referrer");
  });
});
