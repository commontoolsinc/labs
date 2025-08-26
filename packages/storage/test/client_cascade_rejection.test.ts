import { assertEquals } from "@std/assert";

Deno.test(
  { name: "client: dependent tx rejects if source tx rejected" },
  async () => {
    const rejections: string[] = [];
    const commitAdapterA = (_space: string, _req: any) => {
      // Simulate server reject
      return {
        txId: 1,
        committedAt: new Date().toISOString(),
        results: [{
          ref: { docId: "doc:a", branch: "main" },
          status: "rejected",
          reason: "policy",
        }],
        conflicts: [],
      } as any;
    };
    const commitAdapterB = (_space: string, _req: any) => {
      return {
        txId: 2,
        committedAt: new Date().toISOString(),
        results: [{
          ref: { docId: "doc:b", branch: "main" },
          status: "ok",
          newHeads: [],
        }],
        conflicts: [],
      } as any;
    };

    const { ClientTransaction } = await import("../src/client/tx.ts");
    const txA = new ClientTransaction(commitAdapterA, undefined, undefined, {
      onCommitted: (_tx, info) => {
        if (info.status !== "ok") rejections.push("A");
      },
    });
    // txB "reads" doc:a by calling read, then writes to doc:b; it should be invalidated
    const txB = new ClientTransaction(commitAdapterB, undefined, undefined, {
      onCommitted: (_tx, info) => {
        if (info.status !== "ok") rejections.push("B");
      },
    });
    // Stage a write in A so it actually commits and returns server result
    txA.write("space", "doc:a", [], (root: any) => (root.v = 1));
    txB.read("space", "doc:a", [], false);
    txB.write("space", "doc:b", [], (root: any) => (root.v = 1));

    const resA = await txA.commit();
    assertEquals(resA.status, "rejected");
    // Notify B that a dependency rejected
    txB.dependencyRejected("space", ["doc:a"]);
    const resB = await txB.commit();
    assertEquals(resB.status, "rejected");
  },
);
