/**
 * The filesystem the interactive file picker (C-x C-f) talks to. A port, so the
 * session stays pure and testable: the real implementation wraps Deno, and a
 * test injects a fake. Opening a file yields a plain-file {@link EditableSource}
 * plus its text, ready to become the session's new buffer.
 */
import { basename, dirname, join } from "@std/path";
import { type EditableSource, fileSource } from "./editsource.ts";

export interface DirEntry {
  readonly name: string;
  readonly isDir: boolean;
}

export interface FileGateway {
  /** The working directory the picker opens at when there is no current file. */
  cwd(): string;
  /** A directory's entries, or null when it cannot be read. */
  list(absDir: string): DirEntry[] | null;
  /** Open a file: its editable source and current text, or null on failure. */
  open(absPath: string): { source: EditableSource; text: string } | null;
  /** Join a directory and a path segment, normalised. */
  join(dir: string, segment: string): string;
  /** The parent directory of a path. */
  parent(path: string): string;
  /** The final path segment (for display). */
  base(path: string): string;
}

export function realFileGateway(): FileGateway {
  return {
    cwd: () => {
      try {
        return Deno.cwd();
      } catch {
        return ".";
      }
    },
    list: (absDir) => {
      try {
        const out: DirEntry[] = [];
        for (const e of Deno.readDirSync(absDir)) {
          out.push({ name: e.name, isDir: isDir(absDir, e) });
        }
        return out;
      } catch {
        return null;
      }
    },
    open: (absPath) => {
      try {
        const text = Deno.readTextFileSync(absPath);
        return { source: fileSource(absPath), text };
      } catch {
        return null;
      }
    },
    join: (dir, segment) => join(dir, segment),
    parent: (path) => dirname(path),
    base: (path) => basename(path),
  };
}

/** Resolve symlinks so a link to a directory is offered as one. */
function isDir(dir: string, e: Deno.DirEntry): boolean {
  if (e.isDirectory) return true;
  if (!e.isSymlink) return false;
  try {
    return Deno.statSync(join(dir, e.name)).isDirectory;
  } catch {
    return false;
  }
}
