import { Delta, DocId, Path, PathKey, Version } from "./types.ts";
import { child, keyPath } from "./path.ts";

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

export interface Storage {
  read(doc: DocId, path: Path, at?: Version): any;
  listProps(doc: DocId, path: Path, at?: Version): string[];
  listItemsCount(doc: DocId, path: Path, at?: Version): number;
  currentVersion(doc: DocId): Version;
  readDocAtVersion(doc: DocId, at: Version): { version: Version; doc: any };
}

export class InMemoryStorage implements Storage {
  private docs = new Map<DocId, { version: Version; doc: any }>();
  read(doc: DocId, path: Path, _at?: Version): any {
    const d = this.docs.get(doc);
    return d ? getAtPath(d.doc, path) : undefined;
  }
  listProps(doc: DocId, path: Path, _at?: Version): string[] {
    const d = this.docs.get(doc);
    const v = d ? getAtPath(d.doc, path) : undefined;
    return isObject(v) ? Object.keys(v) : [];
  }
  listItemsCount(doc: DocId, path: Path, _at?: Version): number {
    const d = this.docs.get(doc);
    const v = d ? getAtPath(d.doc, path) : undefined;
    return Array.isArray(v) ? v.length : 0;
  }
  currentVersion(doc: DocId): Version {
    return this.docs.get(doc)?.version ?? { seq: 0 };
  }
  readDocAtVersion(doc: DocId, at: Version): { version: Version; doc: any } {
    const d = this.docs.get(doc);
    return d
      ? { version: d.version, doc: d.doc }
      : { version: { seq: 0 }, doc: undefined };
  }

  setDoc(doc: DocId, docValue: any, version: Version): Delta {
    const prev = this.docs.get(doc)?.doc;
    this.docs.set(doc, { version, doc: docValue });
    const changed = new Set<PathKey>();
    const removed = new Set<PathKey>();

    const isEqual = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);
    const walk = (prefix: Path, a: any, b: any) => {
      if (!isEqual(a, b)) changed.add(keyPath(prefix));
      if (isObject(b)) {
        for (const k of Object.keys(b)) walk(child(prefix, k), a?.[k], b[k]);
      } else if (Array.isArray(b)) {
        for (let i = 0; i < b.length; i++) {
          walk(child(prefix, String(i)), a?.[i], b[i]);
        }
      }
      if (isObject(a)) {
        for (const k of Object.keys(a)) {
          if (!(k in (b || {}))) removed.add(keyPath(child(prefix, k)));
          else if (Array.isArray(a)) {
            for (let i = b?.length ?? 0; i < a.length; i++) {
              removed.add(keyPath(child(prefix, String(i))));
            }
          }
        }
      }
    };
    walk([], prev, docValue);
    return { doc, changed, removed, newDoc: docValue, atVersion: version };
  }
}
