export type JsonValue = unknown;

export type DocState = {
  serverEpoch: number;
  heads: string[];
  branch: string;
  // Minimal placeholder shape; real impl will keep bytes/docs and pending chain
};

export class ClientStore {
  // space -> docId -> DocState
  #bySpace = new Map<string, Map<string, DocState>>();

  ensureSpace(space: string): Map<string, DocState> {
    let m = this.#bySpace.get(space);
    if (!m) {
      m = new Map();
      this.#bySpace.set(space, m);
    }
    return m;
  }
}


