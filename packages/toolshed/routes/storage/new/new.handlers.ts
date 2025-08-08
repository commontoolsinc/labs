import type { AppRouteHandler } from "@/lib/types.ts";
import { InMemorySpaceStorage } from "@commontools/storage";

const spaces = new Map<string, InMemorySpaceStorage>();

function getSpace(spaceDid: string): InMemorySpaceStorage {
  let s = spaces.get(spaceDid);
  if (!s) {
    s = new InMemorySpaceStorage();
    spaces.set(spaceDid, s);
  }
  return s;
}

export const createDoc: AppRouteHandler<typeof import("./new.routes.ts").createDoc> = async (c: any) => {
  const { space } = c.req.param();
  const { docId, branch } = await c.req.json();
  const s = getSpace(space);
  await s.getOrCreateBranch(docId, branch ?? "main");
  return c.json({ ok: true });
};

export const heads: AppRouteHandler<typeof import("./new.routes.ts").heads> = async (c: any) => {
  const { space, docId } = c.req.param();
  const branch = c.req.query("branch") ?? "main";
  const s = getSpace(space);
  const st = await s.getBranchState(docId, branch);
  return c.json({
    docId,
    branch,
    heads: [...st.heads],
    seq_no: st.seqNo,
    epoch: st.epoch,
    root_ref: st.rootRef,
  });
};

function decodeBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const tx: AppRouteHandler<typeof import("./new.routes.ts").tx> = async (c: any) => {
  const { space } = c.req.param();
  const body = await c.req.json();
  const s = getSpace(space);
  const req = {
    reads: body.reads,
    writes: body.writes.map((w: any) => ({
      ref: w.ref,
      baseHeads: w.baseHeads,
      changes: (w.changes as string[]).map((b64) => ({ bytes: decodeBase64(b64) })),
    })),
  };
  const receipt = await s.submitTx(req);
  return c.json({ ok: true, receipt });
};
