import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  docIdFromUri,
  getDocRef,
  pathFromAddress,
} from "../src/storage-new/address.ts";

describe("storage-new/address", () => {
  it("docIdFromUri encodes base64url without padding", () => {
    const id = docIdFromUri("of:hello/world");
    expect(id.startsWith("doc:"))
      .toBe(true);
    const b64url = id.slice(4);
    expect(b64url.includes("+")).toBe(false);
    expect(b64url.includes("/")).toBe(false);
    expect(b64url.includes("=")).toBe(false);
  });

  it("pathFromAddress stringifies tokens", () => {
    const path = pathFromAddress({
      path: ["a", 1 as unknown as string, "c"] as any,
    });
    expect(path).toEqual(["a", "1", "c"]);
  });

  it("getDocRef builds docId and path", () => {
    const ref = getDocRef({
      id: "of:abc" as any,
      type: "application/json" as any,
      path: ["x", "y"] as any,
    });
    expect(ref.docId.startsWith("doc:")).toBe(true);
    expect(ref.path).toEqual(["x", "y"]);
  });
});
