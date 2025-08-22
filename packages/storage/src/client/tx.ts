export type TxStatus = "open" | "aborted" | "committed";

export class ClientTransaction {
  #status: TxStatus = "open";
  readonly log: Array<{ space: string; docId: string; path: string[]; op: "read" | "write" }>= [];
  #writeSpace: string | null = null;

  read(_space: string, _docId: string, _path: string[], nolog = false, validPathOut?: string[]): unknown {
    if (this.#status !== "open") throw new Error("transaction closed");
    if (!nolog) this.log.push({ space: _space, docId: _docId, path: _path.slice(), op: "read" });
    if (validPathOut) validPathOut.splice(0, validPathOut.length, ...[]);
    return undefined;
  }

  write(space: string, docId: string, path: string[], _mutate: (sub: unknown) => void, validPathOut?: string[]): boolean {
    if (this.#status !== "open") throw new Error("transaction closed");
    if (this.#writeSpace && this.#writeSpace !== space) throw new Error("transaction writes must target a single space");
    this.#writeSpace = space;
    this.log.push({ space, docId, path: path.slice(), op: "write" });
    if (validPathOut) validPathOut.splice(0, validPathOut.length, ...[]);
    return true;
  }

  commit(): Promise<{ status: "ok" | "conflict" | "rejected" }> {
    if (this.#status !== "open") throw new Error("transaction closed");
    this.#status = "committed";
    return Promise.resolve({ status: "ok" });
  }

  abort(): void {
    if (this.#status !== "open") return;
    this.#status = "aborted";
  }
}


