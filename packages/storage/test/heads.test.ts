import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { InMemorySpaceStorage } from "../src/memory.ts";
import type { Heads, SubmittedChange, TxRequest } from "../interface.ts";

function b(bytes: number[]): Uint8Array {
  return new Uint8Array(bytes);
}

function sc(bytes: number[]): SubmittedChange {
  return { bytes: b(bytes) };
}

describe("InMemorySpaceStorage heads management", () => {
  it("accepts linear changes and updates heads", async () => {
    const s = new InMemorySpaceStorage();
    await s.getOrCreateBranch("doc:abc", "main");

    const req: TxRequest = {
      reads: [{ ref: { docId: "doc:abc", branch: "main" }, heads: [] }],
      writes: [{
        ref: { docId: "doc:abc", branch: "main" },
        baseHeads: [] as Heads,
        changes: [sc([1]), sc([2])],
      }],
    };

    const r = await s.submitTx(req);
    expect(r.results[0].status).toEqual("ok");
    expect(r.results[0].applied).toEqual(2);
    const st = await s.getBranchState("doc:abc", "main");
    expect(st.heads.length).toEqual(1);
    expect(st.seqNo).toEqual(2);
  });

  it("rejects write when baseHeads mismatch", async () => {
    const s = new InMemorySpaceStorage();
    await s.getOrCreateBranch("doc:abc", "main");

    const r = await s.submitTx({
      reads: [{ ref: { docId: "doc:abc", branch: "main" }, heads: [] }],
      writes: [{
        ref: { docId: "doc:abc", branch: "main" },
        baseHeads: ["hdeadbeef"],
        changes: [sc([1])],
      }],
    });
    expect(r.results[0].status).toEqual("conflict");
  });

  it("forks heads when deps mismatch (treated as missing)", async () => {
    const s = new InMemorySpaceStorage();
    await s.getOrCreateBranch("doc:abc", "main");

    // First tx: one change
    await s.submitTx({
      reads: [{ ref: { docId: "doc:abc", branch: "main" }, heads: [] }],
      writes: [{
        ref: { docId: "doc:abc", branch: "main" },
        baseHeads: [],
        changes: [sc([1])],
      }],
    });

    const st1 = await s.getBranchState("doc:abc", "main");

    // Second tx: pretend a change with missing dep (our decoder makes deps=[])
    const r2 = await s.submitTx({
      reads: [{ ref: { docId: "doc:abc", branch: "main" }, heads: st1.heads }],
      writes: [{
        ref: { docId: "doc:abc", branch: "main" },
        baseHeads: st1.heads,
        changes: [sc([2])],
      }],
    });

    expect(r2.results[0].status).toEqual("ok");
    const st2 = await s.getBranchState("doc:abc", "main");
    expect(st2.seqNo).toEqual(2);
    expect(st2.heads.length).toEqual(1);
  });
});
