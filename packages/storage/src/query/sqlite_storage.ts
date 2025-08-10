import type { Database } from "@db/sqlite";
import * as Automerge from "@automerge/automerge";
import { getAutomergeBytesAtSeq, uptoSeqNo } from "../sqlite/pit.ts";
import { getBranchState } from "../sqlite/heads.ts";
import type { Path, Version } from "./types.ts";

function isObject(x: any): x is Record<string, any> {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}

function getAtPath(doc: any, path: Path): any {
  let cur = doc;
  for (const seg of path) {
    cur = isObject(cur) || Array.isArray(cur) ? (cur as any)[seg] : undefined;
  }
  return cur;
}

export class SqliteStorage {
  constructor(private db: Database, private defaultBranch = "main") {}

  private resolve(
    docId: string,
    at?: Version,
  ): { branchId: string; seq: number } {
    const branchName = at?.branch ?? this.defaultBranch;
    const state = getBranchState(this.db, docId, branchName);
    const seq = at?.epoch != null
      ? uptoSeqNo(this.db, docId, state.branchId, at.epoch)
      : state.seqNo;
    return { branchId: state.branchId, seq };
  }

  read(docId: string, path: Path, at?: Version): any {
    const { branchId, seq } = this.resolve(docId, at);
    const bytes = getAutomergeBytesAtSeq(this.db, null, docId, branchId, seq);
    const json = Automerge.toJS(Automerge.load(bytes));
    return getAtPath(json, path);
  }

  listProps(docId: string, path: Path, at?: Version): string[] {
    const v = this.read(docId, path, at);
    return isObject(v) ? Object.keys(v) : [];
  }

  listItemsCount(docId: string, path: Path, at?: Version): number {
    const v = this.read(docId, path, at);
    return Array.isArray(v) ? v.length : 0;
  }

  currentVersion(docId: string): Version {
    const state = getBranchState(this.db, docId, this.defaultBranch);
    return { epoch: state.epoch, branch: this.defaultBranch };
  }

  readDocAtVersion(docId: string, at: Version): { version: Version; doc: any } {
    const { branchId, seq } = this.resolve(docId, at);
    const bytes = getAutomergeBytesAtSeq(this.db, null, docId, branchId, seq);
    const json = Automerge.toJS(Automerge.load(bytes));
    return {
      version: {
        epoch: at.epoch ??
          getBranchState(this.db, docId, at.branch ?? this.defaultBranch).epoch,
        branch: at.branch ?? this.defaultBranch,
      },
      doc: json,
    };
  }
}
