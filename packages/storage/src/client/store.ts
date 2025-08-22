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

  private ensureSpace(space: string): Map<string, DocState> {
    let m = this.#bySpace.get(space);
    if (!m) {
      m = new Map();
      this.#bySpace.set(space, m);
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

  readView(space: string, docId: string): { json: JsonValue | undefined; version: { epoch: number } } {
    const spaceMap = this.#bySpace.get(space);
    const st = spaceMap?.get(docId);
    return { json: st?.json, version: { epoch: st?.serverEpoch ?? -1 } };
  }
}
