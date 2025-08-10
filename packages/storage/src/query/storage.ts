import { DocId, Path, Version } from "./types.ts";

export interface Reader {
  read(doc: DocId, path: Path, at?: Version): any;
  listProps(doc: DocId, path: Path, at?: Version): string[];
  listItemsCount(doc: DocId, path: Path, at?: Version): number;
  currentVersion(doc: DocId): Version;
  readDocAtVersion(doc: DocId, at: Version): { version: Version; doc: any };
}
