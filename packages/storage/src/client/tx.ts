import * as AM from "@automerge/automerge";
import { createGenesisDoc } from "../store/genesis.ts";
import { getAtPathWithPrefix as utilGetAtPathWithPrefix } from "./path.ts";
import type { TxReceipt } from "../types.ts";

export type TxStatus = "open" | "aborted" | "committed";

type CommitAdapterReq = {
  clientTxId?: string;
  reads: ReadonlyArray<
    { ref: { docId: string; branch: string }; heads: readonly string[] }
  >;
  writes: Array<{
    ref: { docId: string; branch: string };
    baseHeads: readonly string[];
    changes: ReadonlyArray<{ bytes: Uint8Array }>;
    allowServerMerge?: boolean;
  }>;
};

type CommitAdapter = (
  space: string,
  req: CommitAdapterReq,
) => Promise<TxReceipt>;

type BaselineProvider = (
  space: string,
  docId: string,
) => Promise<AM.Doc<any> | null>;

type OverlayFns = {
  applyPending?: (
    space: string,
    docId: string,
    id: string,
    json: unknown,
    baseHeads?: string[],
  ) => void;
  clearPending?: (space: string, docId: string, id: string) => void;
  promotePendingToServer?: (
    space: string,
    docId: string,
    id: string,
    epoch?: number,
    heads?: string[],
  ) => void;
};

export class ClientTransaction {
  #status: TxStatus = "open";
  readonly log: Array<
    { space: string; docId: string; path: string[]; op: "read" | "write" }
  > = [];
  #writeSpace: string | null = null;
  #commitAdapter: CommitAdapter | null = null;
  #baselineProvider: BaselineProvider | null = null;
  #overlay: OverlayFns | null = null;
  #hooks:
    | {
      onOpen?: (tx: ClientTransaction) => void;
      onClose?: (tx: ClientTransaction) => void;
      onCommitted?: (
        tx: ClientTransaction,
        info: { space: string; status: "ok" | "conflict" | "rejected" },
      ) => void;
    }
    | null = null;
  #stagedByDoc = new Map<
    string,
    {
      space: string;
      docId: string;
      branch: string;
      pendingDoc: AM.Doc<any>;
      mutations: Array<(d: any) => void>;
    }
  >();
  #readDocs = new Set<string>();
  #invalidReason: string | null = null;

  constructor(
    commitAdapter?: CommitAdapter,
    baselineProvider?: BaselineProvider,
    overlay?: OverlayFns,
    hooks?: {
      onOpen?: (tx: ClientTransaction) => void;
      onClose?: (tx: ClientTransaction) => void;
      onCommitted?: (
        tx: ClientTransaction,
        info: { space: string; status: "ok" | "conflict" | "rejected" },
      ) => void;
    },
  ) {
    this.#commitAdapter = commitAdapter ?? null;
    this.#baselineProvider = baselineProvider ?? null;
    this.#overlay = overlay ?? null;
    this.#hooks = hooks ?? null;
    try {
      this.#hooks?.onOpen?.(this);
    } catch {
      // ignore
    }
  }

  read(
    _space: string,
    _docId: string,
    _path: string[],
    nolog = false,
    validPathOut?: string[],
  ): unknown {
    if (this.#status !== "open") throw new Error("transaction closed");
    if (!nolog) {
      this.log.push({
        space: _space,
        docId: _docId,
        path: _path.slice(),
        op: "read",
      });
    }
    this.#readDocs.add(_docId);
    // If this transaction has staged writes for the document, return the value
    // from the staged Automerge doc (preview). Else undefined (caller may fall
    // back to StorageClient.readView()). Fill validPathOut with the longest
    // valid prefix found in the staged doc.
    const st = this.#stagedByDoc.get(_docId);
    if (!st) {
      if (validPathOut) validPathOut.splice(0, validPathOut.length, ...[]);
      return undefined;
    }
    const js = AM.toJS(st.pendingDoc) as unknown;
    const { value, valid } = utilGetAtPathWithPrefix(js, _path);
    if (validPathOut) {
      validPathOut.splice(0, validPathOut.length, ...valid);
    }
    return value;
  }

  write(
    space: string,
    docId: string,
    path: string[],
    mutate: (sub: unknown) => void,
    validPathOut?: string[],
  ): boolean {
    if (this.#status !== "open") throw new Error("transaction closed");
    if (this.#writeSpace && this.#writeSpace !== space) {
      throw new Error("transaction writes must target a single space");
    }
    this.#writeSpace = space;
    const branch = "main";
    let st = this.#stagedByDoc.get(docId);
    if (!st) {
      const base = createGenesisDoc<any>(docId);
      st = {
        space,
        docId,
        branch,
        pendingDoc: base,
        mutations: [],
      };
      this.#stagedByDoc.set(docId, st);
    }
    // Navigate to the requested path inside the Automerge doc.
    let ok = false;
    let lastValid: string[] = [];
    st.pendingDoc = AM.change(st.pendingDoc, (root: any) => {
      if (path.length === 0) {
        ok = true;
        lastValid = [];
        mutate(root);
        return;
      }
      let cur: unknown = root;
      const valid: string[] = [];
      for (let i = 0; i < path.length; i++) {
        const key = path[i]!;
        if (cur == null || typeof cur !== "object") break;
        // Automerge maps/arrays are proxied objects; treat numeric tokens as
        // array indices when applicable.
        const idx = Number.isInteger(Number(key)) ? Number(key) : undefined;
        if (
          Array.isArray(cur) && idx !== undefined && idx >= 0 &&
          idx < cur.length
        ) {
          cur = (cur as unknown[])[idx];
          valid.push(key);
          continue;
        }
        const obj = cur as Record<string, unknown>;
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
          cur = obj[key];
          valid.push(key);
          continue;
        }
        // Missing segment → stop
        break;
      }
      lastValid = valid;
      if (valid.length === path.length) {
        ok = true;
        // Re-traverse to obtain a fresh writable sub-proxy and call mutate
        let sub: unknown = root;
        for (const k of path) {
          const idx2 = Number.isInteger(Number(k)) ? Number(k) : undefined;
          if (Array.isArray(sub) && idx2 !== undefined) {
            sub = (sub as unknown[])[idx2];
          } else sub = (sub as Record<string, unknown>)[k];
        }
        mutate(sub);
      }
    });
    if (validPathOut) {
      validPathOut.splice(0, validPathOut.length, ...lastValid);
    }
    if (!ok) return false;
    // Record mutation for commit time: a closure that applies the same write
    // to an arbitrary Automerge doc (the server baseline copy).
    const mfn = (doc: any) => {
      if (path.length === 0) {
        mutate(doc);
        return;
      }
      let cur: unknown = doc;
      for (const key of path) {
        const idx = Number.isInteger(Number(key)) ? Number(key) : undefined;
        if (Array.isArray(cur) && idx !== undefined) {
          cur = (cur as unknown[])[idx];
        } else {
          cur = (cur as Record<string, unknown>)[key];
        }
      }
      mutate(cur);
    };
    st.mutations.push(mfn);
    this.log.push({ space, docId, path: path.slice(), op: "write" });
    return true;
  }

  async commit(): Promise<
    { status: "ok" | "conflict" | "rejected"; receipt?: TxReceipt }
  > {
    if (this.#status !== "open") throw new Error("transaction closed");
    if (this.#invalidReason) {
      // Clear any optimistic overlays that may have been applied earlier
      for (const st of this.#stagedByDoc.values()) {
        this.#overlay?.clearPending?.(st.space, st.docId, "__invalid__");
      }
      this.#status = "committed";
      try {
        if (this.#writeSpace) {
          this.#hooks?.onCommitted?.(this, {
            space: this.#writeSpace,
            status: "rejected",
          });
        }
      } catch {
        // ignore
      } finally {
        try {
          this.#hooks?.onClose?.(this);
        } catch {
          // ignore
        }
      }
      return { status: "rejected" };
    }
    if (this.#stagedByDoc.size === 0) {
      this.#status = "committed";
      try {
        if (this.#writeSpace) {
          this.#hooks?.onCommitted?.(this, {
            space: this.#writeSpace,
            status: "ok",
          });
        }
      } catch {
        // ignore
      } finally {
        try {
          this.#hooks?.onClose?.(this);
        } catch {
          // ignore
        }
      }
      return { status: "ok" };
    }
    if (!this.#writeSpace) throw new Error("no write space bound");
    if (!this.#commitAdapter) throw new Error("no commit adapter available");

    const clientTxId = crypto.randomUUID();

    // Apply optimistic overlays immediately so subsequent reads reflect the
    // optimistic view even before any awaited work in this method.
    if (this.#overlay?.applyPending) {
      for (const st of this.#stagedByDoc.values()) {
        try {
          const json = AM.toJS(st.pendingDoc);
          this.#overlay.applyPending(st.space, st.docId, clientTxId, json);
        } catch {
          // ignore overlay failure
        }
      }
    }

    const writeOnly = this.log.every((l) => l.op === "write");
    const writes: CommitAdapterReq["writes"] = [];
    const baseHeadsByDoc = new Map<string, string[]>();
    for (const st of this.#stagedByDoc.values()) {
      // Build on server baseline when available
      const provided = this.#baselineProvider
        ? await this.#baselineProvider(st.space, st.docId)
        : null;
      const baseDoc: AM.Doc<any> = provided ?? createGenesisDoc<any>(st.docId);
      let rolling = AM.clone(baseDoc);
      const baseHeadsSorted = [...AM.getHeads(baseDoc)].sort();
      baseHeadsByDoc.set(st.docId, baseHeadsSorted);
      const changes: Uint8Array[] = [];
      for (const m of st.mutations) {
        rolling = AM.change(rolling, (d: any) => m(d));
        const ch = AM.getLastLocalChange(rolling);
        if (ch) changes.push(ch);
      }
      writes.push({
        ref: { docId: st.docId, branch: st.branch },
        baseHeads: baseHeadsSorted,
        changes: changes.map((b) => ({ bytes: b })),
        allowServerMerge: writeOnly ? true : undefined,
      });
    }

    const req: CommitAdapterReq = {
      clientTxId,
      reads: [],
      writes,
    };

    const receipt = await this.#commitAdapter(this.#writeSpace, req);
    const anyRejected = receipt.results.some((r) => r.status === "rejected");
    const anyConflict = receipt.results.some((r) => r.status === "conflict");
    const status: "ok" | "conflict" | "rejected" = anyRejected
      ? "rejected"
      : anyConflict
      ? "conflict"
      : "ok";

    // Per-doc overlay resolution based on individual results
    for (const st of this.#stagedByDoc.values()) {
      const rr = receipt.results.find((r) => r.ref.docId === st.docId);
      if (!rr) {
        // No result? rollback conservatively
        this.#overlay?.clearPending?.(st.space, st.docId, clientTxId);
        continue;
      }
      if (rr.status === "ok") {
        this.#overlay?.promotePendingToServer?.(
          st.space,
          st.docId,
          clientTxId,
          receipt.txId,
          (rr.newHeads ?? []) as string[],
        );
      } else {
        this.#overlay?.clearPending?.(st.space, st.docId, clientTxId);
      }
    }

    this.#status = "committed";
    this.#stagedByDoc.clear();
    try {
      this.#hooks?.onCommitted?.(this, { space: this.#writeSpace, status });
    } catch {
      // ignore
    } finally {
      try {
        this.#hooks?.onClose?.(this);
      } catch {
        // ignore
      }
    }
    return { status, receipt };
  }

  abort(): void {
    if (this.#status !== "open") return;
    this.#status = "aborted";
    this.#stagedByDoc.clear();
    try {
      this.#hooks?.onClose?.(this);
    } catch {
      // ignore
    }
  }

  // ---- Read-set tracking and invalidation hooks ----
  externalDocChanged(space: string, docId: string): void {
    if (this.#status !== "open") return;
    if (this.#writeSpace && this.#writeSpace !== space) return;
    if (this.#readDocs.has(docId)) {
      this.#invalidReason = `external change to ${docId}`;
    }
  }

  dependencyRejected(space: string, docIds: readonly string[]): void {
    if (this.#status !== "open") return;
    if (this.#writeSpace && this.#writeSpace !== space) return;
    for (const d of docIds) {
      if (this.#readDocs.has(d)) {
        this.#invalidReason = `dependency rejected on ${d}`;
        break;
      }
    }
  }

  getReadDocs(): ReadonlySet<string> {
    return this.#readDocs;
  }

  getWriteDocs(): ReadonlyArray<string> {
    return Array.from(this.#stagedByDoc.keys());
  }
}

// removed local helper in favor of ./path.ts utilities
