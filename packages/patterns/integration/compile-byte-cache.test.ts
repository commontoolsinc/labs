import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { ProcessModuleByteCache } from "./compile-byte-cache.ts";

describe("ProcessModuleByteCache", () => {
  const RT = "rtv";

  it("returns stored bytes by identity and reports a full set", () => {
    const cache = new ProcessModuleByteCache();
    cache.put(RT, "a", { js: "JS_A" });
    cache.put(RT, "b", { js: "JS_B", sourceMap: "MAP_B" });

    expect(cache.get(RT, "a")).toEqual({ js: "JS_A" });
    expect(cache.get(RT, "b")).toEqual({ js: "JS_B", sourceMap: "MAP_B" });
    expect(cache.get(RT, "missing")).toBeUndefined();

    expect(cache.getCompleteSet(RT, ["a", "b"])?.size).toBe(2);
    expect(cache.getCompleteSet(RT, ["a", "missing"])).toBeUndefined();
  });

  it("scopes by runtimeVersion (a version bump misses)", () => {
    const cache = new ProcessModuleByteCache();
    cache.put("v1", "id", { js: "JS" });
    expect(cache.get("v1", "id")).toEqual({ js: "JS" });
    expect(cache.get("v2", "id")).toBeUndefined();
  });

  it("putAll loads a module set; clear empties it", () => {
    const cache = new ProcessModuleByteCache();
    cache.putAll(RT, [
      { identity: "a", js: "JS_A" },
      { identity: "b", js: "JS_B", sourceMap: "MAP_B" },
    ]);
    expect(cache.getCompleteSet(RT, ["a", "b"])?.size).toBe(2);
    cache.clear();
    expect(cache.getCompleteSet(RT, ["a", "b"])).toBeUndefined();
    expect(cache.stats().entries).toBe(0);
  });

  it("evicts oldest entries past the byte cap", () => {
    const cache = new ProcessModuleByteCache(10); // 10 chars
    cache.put(RT, "a", { js: "12345" }); // 5
    cache.put(RT, "b", { js: "67890" }); // 5 -> total 10
    cache.put(RT, "c", { js: "ABCDE" }); // 5 -> evicts "a"
    expect(cache.get(RT, "a")).toBeUndefined();
    expect(cache.get(RT, "b")).toEqual({ js: "67890" });
    expect(cache.get(RT, "c")).toEqual({ js: "ABCDE" });
  });

  it("round-trips through snapshot/restore into a fresh cache", () => {
    const a = new ProcessModuleByteCache();
    a.put(RT, "x", { js: "JS_X" });
    a.put(RT, "y", { js: "JS_Y", sourceMap: "MAP_Y" });
    a.put("v2", "z", { js: "JS_Z" });

    const serialized = JSON.parse(JSON.stringify(a.snapshot())); // survives JSON
    const b = new ProcessModuleByteCache();
    b.restore(serialized);

    expect(b.get(RT, "x")).toEqual({ js: "JS_X" });
    expect(b.get(RT, "y")).toEqual({ js: "JS_Y", sourceMap: "MAP_Y" });
    expect(b.get("v2", "z")).toEqual({ js: "JS_Z" });
    expect(b.getCompleteSet(RT, ["x", "y"])?.size).toBe(2);
  });

  it("restore skips malformed entries and tolerates junk", () => {
    const cache = new ProcessModuleByteCache();
    cache.restore([
      { key: `${RT}\0ok`, js: "GOOD" },
      { key: 42, js: "no" }, // bad key
      { key: `${RT}\0nojs` }, // missing js
      null,
      "garbage",
    ] as unknown[]);
    expect(cache.get(RT, "ok")).toEqual({ js: "GOOD" });
    expect(cache.stats().entries).toBe(1);
  });
});
