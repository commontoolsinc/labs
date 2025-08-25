import * as AM from "@automerge/automerge";
import { createGenesisDoc } from "../store/genesis.ts";
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

export class ClientTransaction {
  #status: TxStatus = "open";
  readonly log: Array<
    { space: string; docId: string; path: string[]; op: "read" | "write" }
  > = [];
  #writeSpace: string | null = null;
  #commitAdapter: CommitAdapter | null = null;
  #baselineProvider: BaselineProvider | null = null;
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

  constructor(
    commitAdapter?: CommitAdapter,
    baselineProvider?: BaselineProvider,
  ) {
    this.#commitAdapter = commitAdapter ?? null;
    this.#baselineProvider = baselineProvider ?? null;
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
    if (validPathOut) validPathOut.splice(0, validPathOut.length, ...[]);
    return undefined;
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
    // For now, only support root path writes; apply mutate to whole doc for preview
    st.pendingDoc = AM.change(st.pendingDoc, (d: any) => {
      mutate(d);
    });
    st.mutations.push(mutate as (d: any) => void);
    this.log.push({ space, docId, path: path.slice(), op: "write" });
    if (validPathOut) validPathOut.splice(0, validPathOut.length, ...[]);
    return true;
  }

  async commit(): Promise<
    { status: "ok" | "conflict" | "rejected"; receipt?: TxReceipt }
  > {
    if (this.#status !== "open") throw new Error("transaction closed");
    if (this.#stagedByDoc.size === 0) {
      this.#status = "committed";
      return { status: "ok" };
    }
    if (!this.#writeSpace) throw new Error("no write space bound");
    if (!this.#commitAdapter) throw new Error("no commit adapter available");

    const writeOnly = this.log.every((l) => l.op === "write");

    const writes: CommitAdapterReq["writes"] = [];
    for (const st of this.#stagedByDoc.values()) {
      // Build on server baseline when available
      const provided = this.#baselineProvider
        ? await this.#baselineProvider(st.space, st.docId)
        : null;
      const baseDoc: AM.Doc<any> = provided ?? createGenesisDoc<any>(st.docId);
      let rolling = AM.clone(baseDoc);
      const baseHeadsSorted = [...AM.getHeads(baseDoc)].sort();
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
    this.#status = "committed";
    this.#stagedByDoc.clear();
    return { status, receipt };
  }

  abort(): void {
    if (this.#status !== "open") return;
    this.#status = "aborted";
    this.#stagedByDoc.clear();
  }
}
