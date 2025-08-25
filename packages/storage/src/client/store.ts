export type JsonValue = unknown;

export type DocState = {
  serverEpoch: number;
  heads: string[];
  branch: string;
  json: JsonValue;
};

export class ClientStore {
  // space -> docId -> DocState
  #bySpace = new Map<string, Map<string, DocState>>();
  // space -> docId -> pending overlays (stack)
  #pending = new Map<
    string,
    Map<string, Array<{ id: string; json: JsonValue }>>
  >();

  private ensureSpace(space: string): Map<string, DocState> {
    let m = this.#bySpace.get(space);
    if (!m) {
      m = new Map();
      this.#bySpace.set(space, m);
    }
    return m;
  }

  private ensurePendingSpace(
    space: string,
  ): Map<string, Array<{ id: string; json: JsonValue }>> {
    let m = this.#pending.get(space);
    if (!m) {
      m = new Map();
      this.#pending.set(space, m);
    }
    return m;
  }

  applyServerDoc(params: {
    space: string;
    docId: string;
    branch?: string;
    epoch: number;
    heads?: string[];
    json: JsonValue;
  }): void {
    const { space, docId, branch = "main", epoch, heads = [] } = params;
    const spaceMap = this.ensureSpace(space);
    const prev = spaceMap.get(docId);
    if (!prev || epoch >= prev.serverEpoch) {
      spaceMap.set(docId, {
        serverEpoch: epoch,
        heads,
        branch,
        json: params.json,
      });
    }
  }

  applyPending(
    params: { space: string; docId: string; id: string; json: JsonValue },
  ): void {
    const { space, docId, id, json } = params;
    const pspace = this.ensurePendingSpace(space);
    const arr = pspace.get(docId) ?? [];
    arr.push({ id, json });
    pspace.set(docId, arr);
  }

  clearPending(params: { space: string; docId: string; id: string }): void {
    const { space, docId, id } = params;
    const pspace = this.#pending.get(space);
    if (!pspace) return;
    const arr = pspace.get(docId);
    if (!arr || arr.length === 0) return;
    const next = arr.filter((e) => e.id !== id);
    if (next.length > 0) pspace.set(docId, next);
    else pspace.delete(docId);
  }

  clearAllPendingForDoc(space: string, docId: string): void {
    const pspace = this.#pending.get(space);
    if (!pspace) return;
    pspace.delete(docId);
  }

  readView(
    space: string,
    docId: string,
  ): { json: JsonValue | undefined; version: { epoch: number } } {
    const spaceMap = this.#bySpace.get(space);
    const st = spaceMap?.get(docId);
    let json = st?.json;
    const pspace = this.#pending.get(space);
    const arr = pspace?.get(docId);
    if (Array.isArray(arr) && arr.length > 0) {
      const top = arr[arr.length - 1];
      json = top?.json;
    }
    return { json, version: { epoch: st?.serverEpoch ?? -1 } };
  }
}
