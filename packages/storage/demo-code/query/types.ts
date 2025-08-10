export type DocId = string;
export type Path = string[]; // internal path representation
export type PathKey = string; // JSON.stringify(Path)
export type Version = { epoch: number; branch?: string };

// Previously called Cell; now Link = (docId, path tokens)
export type Link = { doc: DocId; path: Path };

export type Verdict = "Yes" | "No" | "MaybeExceededDepth";

export type Delta = {
  doc: DocId;
  changed: Set<PathKey>; // keys created via keyPath(path)
  removed: Set<PathKey>;
  newDoc?: any;
  atVersion: Version;
};

export type EngineEvent = {
  queryId: string;
  verdictChanged: boolean;
  touchAdded: Link[];
  touchRemoved: Link[];
  changedDocs: Set<DocId>;
  atVersion: Version;
};
