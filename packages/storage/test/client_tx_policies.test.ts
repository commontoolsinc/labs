import { assert, assertEquals } from "@std/assert";
import * as AM from "@automerge/automerge";

Deno.test({ name: "client tx: single-space enforcement" }, async () => {
  const { ClientTransaction } = await import("../src/client/tx.ts");
  const tx = new ClientTransaction();
  tx.write("space:A", "doc:x", [], (root: any) => (root.v = 1));
  let threw = false;
  try {
    tx.write("space:B", "doc:y", [], (root: any) => (root.k = true));
  } catch {
    threw = true;
  }
  assert(threw);
});

Deno.test({ name: "client tx: write-only sets allowServerMerge" }, async () => {
  const logs: any[] = [];
  const commitAdapter = async (_space: string, req: any) => {
    logs.push(req);
    return {
      txId: 1,
      committedAt: new Date().toISOString(),
      results: [],
      conflicts: [],
    };
  };
  const { ClientTransaction } = await import("../src/client/tx.ts");
  const tx = new ClientTransaction(commitAdapter);
  tx.write("space:A", "doc:x", [], (root: any) => (root.v = 1));
  await tx.commit();
  const sent = logs[0] as any;
  assertEquals(Array.isArray(sent?.writes), true);
  const w = sent.writes[0];
  assertEquals(!!w.allowServerMerge, true);
});

Deno.test(
  { name: "client tx: genesis baseHeads when no baseline" },
  async () => {
    const captures: { baseHeads: string[] }[] = [];
    const commitAdapter = async (_space: string, req: any) => {
      captures.push({ baseHeads: req.writes[0]?.baseHeads ?? [] });
      return {
        txId: 1,
        committedAt: new Date().toISOString(),
        results: [{
          ref: { docId: "doc:g", branch: "main" },
          status: "ok",
          newHeads: AM.getHeads(AM.change(AM.init(), (d: any) => (d.v = 1))),
        }],
        conflicts: [],
      } as any;
    };
    const baselineProvider = async () => null; // force no server baseline
    const { ClientTransaction } = await import("../src/client/tx.ts");
    const tx = new ClientTransaction(commitAdapter, baselineProvider);
    tx.write("space:A", "doc:g", [], (root: any) => (root.v = 1));
    await tx.commit();
    assertEquals(Array.isArray(captures[0]?.baseHeads), true);
    assertEquals(captures[0]!.baseHeads.length >= 1, true);
  },
);
