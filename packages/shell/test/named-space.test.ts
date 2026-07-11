import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { DID } from "@commonfabric/identity";
import { prepareNamedSpace } from "../src/lib/named-space.ts";

const namedDid = "did:key:z6Mk-shell-named-space" as DID;

describe("prepareNamedSpace", () => {
  it("registers the view name and accepts the matching DID", async () => {
    const names: string[] = [];
    await prepareNamedSpace(
      { view: { spaceName: "notebook" } } as never,
      {
        resolveSpaceName: (name: string) => {
          names.push(name);
          return Promise.resolve(namedDid);
        },
      } as never,
      namedDid,
    );
    expect(names).toEqual(["notebook"]);
  });

  it("does nothing for DID-addressed views", async () => {
    let called = false;
    await prepareNamedSpace(
      { view: { spaceDid: namedDid } } as never,
      {
        resolveSpaceName: () => {
          called = true;
          return Promise.resolve(namedDid);
        },
      } as never,
      namedDid,
    );
    expect(called).toBe(false);
  });

  it("rejects inconsistent main-thread and worker derivation", async () => {
    await expect(prepareNamedSpace(
      { view: { spaceName: "notebook" } } as never,
      {
        resolveSpaceName: () => Promise.resolve("did:key:z6Mk-other" as DID),
      } as never,
      namedDid,
    )).rejects.toThrow("resolved inconsistently");
  });
});
