import { openSqlite } from "../store/db.ts";
import { getSpacesDir, isWsAuthRequired } from "../config.ts";
import { requireCapsOnRequest } from "./ucan.ts";
import type { Database } from "@db/sqlite";
import type {
  Ack,
  Authorization,
  Complete,
  Deliver,
  StorageGet,
  StorageHello,
  StorageSubscribe,
  StorageTx,
  StorageTxResult,
  TaskReturn,
  UCAN,
} from "./protocol.ts";
import { SqliteStorageReader } from "../query/sqlite_storage.ts";
import { compileSchema, IRPool } from "../query/ir.ts";
import { Evaluator, Provenance } from "../query/eval.ts";
import { SubscriptionIndex } from "../query/subs.ts";
import { ChangeProcessor } from "../query/change_processor.ts";
import { getBranchState } from "../store/heads.ts";
import { getPrepared } from "../store/prepared.ts";
import { getAutomergeBytesAtSeq, uptoSeqNo } from "../store/pit.ts";

// WebSocket v2 handler for storage: multiplexes get/subscribe/tx over a single connection.
// Deliver frames are decoupled from task/return; initial completion is signaled via Complete.
export async function handleWs(
  req: Request,
  spaceId: string,
): Promise<Response> {
  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response(
      JSON.stringify({ error: { message: "Upgrade required" } }),
      {
        status: 400,
        headers: { "content-type": "application/json" },
      },
    );
  }

  // Enforce UCAN capability on upgrade for read access to the space (opt-in via env)
  if (isWsAuthRequired()) {
    const authProbe = requireCapsOnRequest(req, [
      { can: "storage/read", with: `space:${spaceId}` },
    ]);
    if (authProbe) return authProbe;
  }

  const { socket, response } = Deno.upgradeWebSocket(req);

  // Open per-space DB
  const base = getSpacesDir();
  await Deno.mkdir(base, { recursive: true }).catch(() => {});
  const dbFile = new URL(`./${spaceId}.sqlite`, base);
  const handle = await openSqlite({ url: dbFile });
  const db = handle.db;

  const state = new SessionState(db, spaceId, socket);
  registerSession(spaceId, state);
  state.start(() => {
    unregisterSession(spaceId, state);
    handle.close().catch(() => {});
  });
  return response;
}

class SessionState {
  private closed = false;
  private activeOps = 0;
  private onCloseCb?: () => void;
  private streamId: string;
  private clientId: string | null = null;
  private sinceEpoch: number = -1;
  private sentOnSocket = new Set<string>(); // docId
  private pendingByEpoch = new Map<number, Set<string>>(); // epoch -> docIds
  private storageReader: SqliteStorageReader;
  // Query machinery per session
  private subs = new Map<
    string,
    {
      root: { ir: string; doc: string; path: string[] };
      docSet: Set<string>;
    }
  >();
  private irPool = new IRPool();
  private prov = new Provenance();
  private evaluator!: Evaluator;
  private subsIndex = new SubscriptionIndex();
  private changeProc!: ChangeProcessor;

  constructor(
    private db: Database,
    private spaceId: string,
    private socket: WebSocket,
  ) {
    this.streamId = spaceId;
    this.storageReader = new SqliteStorageReader(db);
    this.evaluator = new Evaluator(this.irPool, this.storageReader, this.prov);
    this.changeProc = new ChangeProcessor(
      this.evaluator,
      this.prov,
      this.subsIndex,
    );
  }

  start(onClose?: () => void) {
    this.onCloseCb = onClose;
    this.socket.onmessage = (ev) => this.onMessage(ev);
    this.socket.onclose = () => {
      this.closed = true;
      this.maybeClose();
    };
    this.socket.onerror = () => {
      this.closed = true;
      this.maybeClose();
    };
  }

  private decodeJSON(data: string | ArrayBufferLike | Blob): any {
    if (typeof data === "string") return JSON.parse(data);
    if (data instanceof Blob) {
      return JSON.parse(new TextDecoder().decode(data as any));
    }
    return JSON.parse(new TextDecoder().decode(data as ArrayBuffer));
  }

  private encodeJSON(v: unknown): string {
    return JSON.stringify(v);
  }

  private jobOf(invocation: any): `job:${string}` {
    // Minimal refer() placeholder: use a hash of the serialized invocation; replace with merkle-reference if desired.
    const bytes = new TextEncoder().encode(JSON.stringify(invocation));
    const digest = Array.from(bytes).reduce(
      (a, b) => ((a * 33) ^ b) >>> 0,
      5381,
    ).toString(16);
    return `job:${digest}` as const;
  }

  private maybeClose() {
    if (this.closed && this.activeOps === 0) {
      try {
        this.onCloseCb?.();
      } catch {
        // ignore
      }
      this.onCloseCb = undefined;
    }
  }

  private async onMessage(ev: MessageEvent) {
    try {
      this.activeOps++;
      const msg = this.decodeJSON(ev.data);
      console.log(
        "[ws] recv",
        typeof msg === "object"
          ? msg?.invocation?.cmd ?? msg?.type
          : typeof msg,
      );
      if (msg && msg.type === "ack") {
        const ack = msg as Ack;
        this.handleAck(ack);
        return;
      }

      // Treat other messages as UCAN-wrapped invocations
      const { invocation, authorization } = msg as UCAN<
        StorageHello | StorageGet | StorageSubscribe | StorageTx
      >;
      // TODO(@storage-auth): verify UCAN and capabilities (read/write) here
      if (invocation.cmd === "/storage/hello") {
        this.handleHello(invocation as StorageHello, authorization as any);
      } else if (invocation.cmd === "/storage/get") {
        this.handleGet(invocation as StorageGet, authorization);
      } else if (invocation.cmd === "/storage/subscribe") {
        this.handleSubscribe(invocation as StorageSubscribe, authorization);
      } else if (invocation.cmd === "/storage/tx") {
        await this.handleTx(invocation as StorageTx, authorization);
      }
    } catch (e) {
      console.error("ws v2 message error", e);
    } finally {
      this.activeOps--;
      this.maybeClose();
    }
  }

  private handleAck(ack: Ack) {
    // Epoch-based ack: persist client-known for docs sent at this epoch
    const docIds = this.pendingByEpoch.get(ack.epoch) ?? new Set<string>();
    if (this.clientId && docIds.size > 0) {
      const stmt = this.db.prepare(
        `INSERT INTO client_known_docs(client_id, doc_id, epoch, updated_at)
         VALUES(:cid, :doc, :epoch, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ON CONFLICT(client_id, doc_id) DO UPDATE SET epoch = excluded.epoch, updated_at = excluded.updated_at`,
      );
      for (const docId of docIds) {
        stmt.run({ cid: this.clientId, doc: docId, epoch: ack.epoch });
      }
    }
    this.pendingByEpoch.delete(ack.epoch);
  }

  private handleHello(inv: StorageHello, _auth: Authorization<StorageHello>) {
    this.clientId = inv.args.clientId;
    this.sinceEpoch = inv.args.sinceEpoch ?? -1;
    // No reply frame; subsequent get/subscribe/tx will use this state
  }

  private evaluateQuery(
    query: Record<string, unknown> | undefined,
  ) {
    // Query schema: if missing, use False; require docId
    const spaceRootDoc = (query as any)?.docId as string;
    if (!spaceRootDoc || typeof spaceRootDoc !== "string") {
      throw new Error("subscribe/get requires query.docId");
    }
    const schema = (query as any)?.schema ?? { const: false };
    const path = (query as any)?.path ?? [];
    const ir = compileSchema(this.irPool, schema);
    const root = { ir, doc: spaceRootDoc, path };
    const docSet = new Set<string>();
    const docsToSend: string[] = [];

    this.evaluator.memo.clear();
    this.evaluator.evaluate(
      root as any,
      undefined,
      this.evaluator.newContext(),
    );
    const touches = this.collectTouchesFromRoot(root);
    for (const l of touches) docSet.add(l.doc);
    docSet.add(spaceRootDoc); // always include root doc

    // Deduplicate against socket-sent and client-known table
    const filtered = this.filterDocsClientNeeds(
      docsToSend.length > 0 ? docsToSend : Array.from(docSet),
    );
    return { root, docSet, docsToSend: filtered } as const;
  }

  private filterDocsClientNeeds(docIds: string[]): string[] {
    const out: string[] = [];
    for (const docId of docIds) {
      if (this.sentOnSocket.has(docId)) continue;
      if (this.clientId && this.sinceEpoch >= 0) {
        const row = this.db.prepare(
          `SELECT epoch FROM client_known_docs WHERE client_id = :cid AND doc_id = :doc`,
        ).get({ cid: this.clientId, doc: docId }) as
          | { epoch: number }
          | undefined;
        if (row && this.sinceEpoch >= row.epoch) {
          // Client claims sinceEpoch behind stored row; resend conservatively
          out.push(docId);
          continue;
        }
      }
      out.push(docId);
    }
    return out;
  }

  private sendDocsAsEpochBatch(docIds: string[]) {
    const epoch = this.storageReader.currentVersion(docIds[0]!).epoch;
    const payload: Deliver = {
      type: "deliver",
      streamId: this.streamId as any,
      epoch,
      docs: [],
    };

    const defaultBranch = "main";
    const stmts = getPrepared(this.db as any);

    const encodeB64 = (bytes: Uint8Array): string => {
      let s = "";
      for (let i = 0; i < bytes.length; i++) {
        s += String.fromCharCode(bytes[i]!);
      }
      return btoa(s);
    };

    for (const docId of docIds) {
      // Resolve branch state
      const state = getBranchState(this.db, docId, defaultBranch);
      const currentSeq = state.seqNo;
      const currentVersion = {
        epoch: state.epoch,
        branch: defaultBranch as any,
      };

      // Determine baseline epoch the client is known to have
      let baselineEpoch: number | undefined = undefined;
      if (this.clientId && this.sinceEpoch >= 0) {
        const row = this.db.prepare(
          `SELECT epoch FROM client_known_docs WHERE client_id = :cid AND doc_id = :doc`,
        ).get({ cid: this.clientId, doc: docId }) as
          | { epoch: number }
          | undefined;
        baselineEpoch = row?.epoch ?? this.sinceEpoch;
      } else if (this.clientId) {
        const row = this.db.prepare(
          `SELECT epoch FROM client_known_docs WHERE client_id = :cid AND doc_id = :doc`,
        ).get({ cid: this.clientId, doc: docId }) as
          | { epoch: number }
          | undefined;
        baselineEpoch = row?.epoch;
      }

      if (baselineEpoch == null) {
        // Unknown client state → send Automerge snapshot bytes at current tip
        const amBytes = getAutomergeBytesAtSeq(
          this.db,
          docId,
          state.branchId,
          currentSeq,
        );
        this.sentOnSocket.add(docId);
        if (!this.pendingByEpoch.has(epoch)) {
          this.pendingByEpoch.set(epoch, new Set());
        }
        this.pendingByEpoch.get(epoch)!.add(docId);
        payload.docs.push({
          docId,
          branch: currentVersion.branch,
          version: currentVersion,
          kind: "snapshot",
          body: encodeB64(amBytes),
        });
        continue;
      }

      // Known baseline → compute changes since baseline up to current tip
      const fromSeq = uptoSeqNo(this.db, docId, state.branchId, baselineEpoch);
      const toSeq = currentSeq;
      if (toSeq <= fromSeq) {
        // Nothing to send for this doc
        continue;
      }
      const rows = stmts.selectChangeBytesRange.all({
        doc_id: docId,
        branch_id: state.branchId,
        from_seq: fromSeq,
        to_seq: toSeq,
      }) as Array<{ bytes: Uint8Array }>;
      const changesB64 = rows.map((r) => encodeB64(r.bytes));
      if (changesB64.length === 0) continue;
      this.sentOnSocket.add(docId);
      if (!this.pendingByEpoch.has(epoch)) {
        this.pendingByEpoch.set(epoch, new Set());
      }
      this.pendingByEpoch.get(epoch)!.add(docId);
      payload.docs.push({
        docId,
        branch: currentVersion.branch,
        version: currentVersion,
        kind: "delta",
        body: changesB64,
      });
    }
    if (payload.docs.length > 0) this.socket.send(this.encodeJSON(payload));
  }

  private collectTouchesFromRoot(
    root: { ir: string; doc: string; path: string[] },
  ) {
    const out = new Set<{ doc: string; path: string[] }>();
    const seen = new Set<string>();
    const dfs = (k: { ir: string; doc: string; path: string[] }) => {
      const ks = `${k.ir}\u0001${k.doc}\u0001${JSON.stringify(k.path)}`;
      if (seen.has(ks)) return;
      seen.add(ks);
      const r = this.evaluator.memo.get(ks);
      if (!r) return;
      r.touches.forEach((c) => out.add(c as any));
      r.deps.forEach((child) => dfs(child as any));
    };
    dfs(root);
    return out;
  }

  private handleGet(inv: StorageGet, _auth: Authorization<StorageGet>) {
    const jobId = this.jobOf(inv);
    // One-shot evaluation and backfill
    const { docsToSend } = this.evaluateQuery(inv.args.query);
    if (docsToSend.length > 0) {
      this.sendDocsAsEpochBatch(docsToSend);
    }
    console.log("[ws] get complete");
    const complete: Complete = {
      type: "complete",
      at: {
        epoch: this.storageReader.currentVersion(
          (inv.args.query as any)?.docId ?? "",
        )?.epoch,
      },
      streamId: this.streamId as any,
      filterId: "get",
    };
    const ret: TaskReturn<StorageGet, Complete> = {
      the: "task/return",
      of: jobId,
      is: complete,
    };
    this.socket.send(this.encodeJSON(ret));
  }

  private handleSubscribe(
    inv: StorageSubscribe,
    _auth: Authorization<StorageSubscribe>,
  ) {
    const jobId = this.jobOf(inv);
    const { root, docSet, docsToSend } = this.evaluateQuery(inv.args.query);
    this.subs.set(inv.args.consumerId, { root, docSet });
    // Register query for incremental change processing when rooted at a concrete doc
    if (root.doc) {
      this.changeProc.registerQuery({
        id: inv.args.consumerId,
        doc: root.doc,
        path: root.path,
        ir: root.ir,
      });
    }
    if (docsToSend.length === 0 && docSet.size === 1 && docSet.has(root.doc)) {
      // Force initial backfill of root doc if nothing else was touched
      this.sendDocsAsEpochBatch([root.doc]);
    } else if (docsToSend.length > 0) this.sendDocsAsEpochBatch(docsToSend);
    console.log("[ws] subscribe complete");
    const complete: Complete = {
      type: "complete",
      at: {},
      streamId: this.streamId as any,
      filterId: inv.args.consumerId,
    };
    const ret: TaskReturn<StorageSubscribe, Complete> = {
      the: "task/return",
      of: jobId,
      is: complete,
    };
    this.socket.send(this.encodeJSON(ret));
  }

  private async handleTx(
    inv: StorageTx,
    _auth: Authorization<StorageTx>,
  ) {
    const jobId = this.jobOf(inv);
    // TODO(@storage-auth): verify per-tx signature and delegation chain; enforce storage/write for space
    const { openSpaceStorage } = await import("../provider.ts");
    const spacesDir = getSpacesDir();
    const s = await openSpaceStorage(this.spaceId, { spacesDir });

    // Normalize WS tx args: decode base64 or numeric arrays to Uint8Array
    const decodeB64 = (s: string): Uint8Array => {
      const bin = atob(s);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    };
    const toBytes = (v: unknown): Uint8Array => {
      if (v instanceof Uint8Array) return v;
      if (typeof v === "string") return decodeB64(v);
      if (Array.isArray(v)) return new Uint8Array(v as number[]);
      // last resort: try to coerce objects with numeric indices
      try {
        const arr = Array.from(v as any);
        return new Uint8Array(arr as number[]);
      } catch {
        return new Uint8Array();
      }
    };
    const req = inv.args as any;
    const normalized = {
      clientTxId: req.clientTxId,
      reads: (req.reads ?? []).map((r: any) => ({
        ref: r.ref,
        heads: r.heads,
      })),
      writes: (req.writes ?? []).map((w: any) => ({
        ref: w.ref,
        baseHeads: w.baseHeads ?? [],
        changes: (w.changes ?? []).map((c: any) => ({
          bytes: toBytes(c.bytes),
        })),
        allowServerMerge: w.allowServerMerge,
      })),
    };

    const receipt = await s.submitTx(normalized as any);
    console.log("[ws] receipt", JSON.stringify(receipt));
    const epoch = receipt.txId;
    // Build a coarse delta per changed doc to drive incremental processing
    const deltas: Array<{ doc: string }> = [];
    const docsSet = new Set<string>();
    for (const r of receipt.results) {
      if (r.status === "ok") {
        deltas.push({ doc: r.ref.docId });
        // Always include changed doc for this session; query engine may narrow later
        docsSet.add(r.ref.docId);
      }
    }
    // Broadcast deltas to all sessions for this space (including this)
    for (const sess of sessionsForSpace(this.spaceId)) {
      sess.processDeltasAndMaybeDeliver(epoch, deltas, receipt.results);
    }
    // Note: individual session deliveries handled inside processDeltasAndMaybeDeliver
    const ret: TaskReturn<StorageTx, StorageTxResult> = {
      the: "task/return",
      of: jobId,
      is: receipt,
    };
    this.socket.send(this.encodeJSON(ret));
  }

  private processDeltasAndMaybeDeliver(
    epoch: number,
    deltas: Array<{ doc: string }>,
    results: StorageTxResult["results"],
  ) {
    // Only deliver if there are active subscriptions on this session
    if (this.subs.size === 0) return;
    const docsSet = new Set<string>();
    for (const r of results) if (r.status === "ok") docsSet.add(r.ref.docId);
    if (deltas.length > 0) {
      for (const d of deltas) {
        const v = this.storageReader.currentVersion(d.doc);
        const delta = {
          doc: d.doc,
          changed: new Set([JSON.stringify([])]),
          removed: new Set<string>(),
          newDoc: undefined,
          atVersion: v,
        } as any;
        const events = this.changeProc.onDelta(delta);
        console.log("[ws] delta", d.doc, "events", events.length);
        for (const ev of events) {
          if (!this.subs.has(ev.queryId)) continue;
          const sub = this.subs.get(ev.queryId)!;
          for (const docId of ev.changedDocs) {
            sub.docSet.add(docId);
            docsSet.add(docId);
          }
        }
      }
    }
    console.log("[ws] docsSet", [...docsSet]);
    if (docsSet.size === 0) return;
    const docsPayload: Deliver = {
      type: "deliver",
      streamId: this.streamId as any,
      epoch,
      docs: [],
    };

    const defaultBranch = "main";
    const stmts = getPrepared(this.db as any);
    const encodeB64 = (bytes: Uint8Array): string => {
      let s = "";
      for (let i = 0; i < bytes.length; i++) {
        s += String.fromCharCode(bytes[i]!);
      }
      return btoa(s);
    };

    for (const docId of docsSet) {
      const state = getBranchState(this.db, docId, defaultBranch);
      const tipSeq = uptoSeqNo(this.db, docId, state.branchId, epoch);
      const currentVersion = { epoch, branch: defaultBranch as any };

      // Baseline: last acknowledged epoch for this client and doc
      let baselineEpoch: number | undefined = undefined;
      if (this.clientId) {
        const row = this.db.prepare(
          `SELECT epoch FROM client_known_docs WHERE client_id = :cid AND doc_id = :doc`,
        ).get({ cid: this.clientId, doc: docId }) as
          | { epoch: number }
          | undefined;
        baselineEpoch = row?.epoch;
      }

      if (baselineEpoch == null) {
        // Unknown baseline → send Automerge snapshot bytes at this epoch
        const amBytes = getAutomergeBytesAtSeq(
          this.db,
          docId,
          state.branchId,
          tipSeq,
        );
        this.sentOnSocket.add(docId);
        if (!this.pendingByEpoch.has(epoch)) {
          this.pendingByEpoch.set(epoch, new Set());
        }
        this.pendingByEpoch.get(epoch)!.add(docId);
        docsPayload.docs.push({
          docId,
          branch: currentVersion.branch,
          version: currentVersion,
          kind: "snapshot",
          body: encodeB64(amBytes),
        });
        continue;
      }

      const fromSeq = uptoSeqNo(this.db, docId, state.branchId, baselineEpoch);
      const toSeq = tipSeq;
      if (toSeq <= fromSeq) continue;
      const rows = stmts.selectChangeBytesRange.all({
        doc_id: docId,
        branch_id: state.branchId,
        from_seq: fromSeq,
        to_seq: toSeq,
      }) as Array<{ bytes: Uint8Array }>;
      const changesB64 = rows.map((r) => encodeB64(r.bytes));
      if (changesB64.length === 0) continue;
      this.sentOnSocket.add(docId);
      if (!this.pendingByEpoch.has(epoch)) {
        this.pendingByEpoch.set(epoch, new Set());
      }
      this.pendingByEpoch.get(epoch)!.add(docId);
      docsPayload.docs.push({
        docId,
        branch: currentVersion.branch,
        version: currentVersion,
        kind: "delta",
        body: changesB64,
      });
    }
    if (docsPayload.docs.length > 0) {
      console.log("[ws] deliver", epoch, docsPayload.docs.length);
      this.socket.send(this.encodeJSON(docsPayload));
    }
  }
}

// Space-level session registry for broadcasting
const spaceToSessions = new Map<string, Set<SessionState>>();
function registerSession(spaceId: string, sess: SessionState) {
  if (!spaceToSessions.has(spaceId)) spaceToSessions.set(spaceId, new Set());
  spaceToSessions.get(spaceId)!.add(sess);
}
function unregisterSession(spaceId: string, sess: SessionState) {
  const set = spaceToSessions.get(spaceId);
  if (!set) return;
  set.delete(sess);
  if (set.size === 0) spaceToSessions.delete(spaceId);
}
function sessionsForSpace(spaceId: string): Iterable<SessionState> {
  return spaceToSessions.get(spaceId) ?? [];
}
