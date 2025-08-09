import type {
  BranchName,
  BranchState,
  DocId,
  SpaceStorage,
  StorageProvider,
  TxReceipt,
  TxRequest,
} from "../interface.ts";
import { openSqlite, type SqliteHandle } from "./sqlite/db.ts";
import { getBranchState as readBranchState, getOrCreateBranch as ensureBranch, getOrCreateDoc as ensureDoc } from "./sqlite/heads.ts";

export interface SQLiteSpaceOptions {
  spacesDir: URL; // directory where per-space sqlite files live
}

class UnimplementedSpace implements SpaceStorage {
  constructor(private readonly handle: SqliteHandle) {}
  getOrCreateDoc(docId: DocId): Promise<void> {
    ensureDoc(this.handle.db, docId);
    return Promise.resolve();
  }
  getOrCreateBranch(docId: DocId, branch: BranchName): Promise<BranchState> {
    return Promise.resolve(ensureBranch(this.handle.db, docId, branch));
  }
  getBranchState(docId: DocId, branch: BranchName): Promise<BranchState> {
    return Promise.resolve(readBranchState(this.handle.db, docId, branch));
  }
  submitTx(_req: TxRequest): Promise<TxReceipt> {
    throw new Error("not implemented: submitTx");
  }
  getDocBytes(): Promise<Uint8Array> {
    throw new Error("not implemented: getDocBytes");
  }
}

export function createStorageProvider(): StorageProvider {
  return {
    info: { name: "@commontools/storage", version: "0.0.0" },
  };
}

export async function openSpaceStorage(
  spaceDid: string,
  opts: SQLiteSpaceOptions,
): Promise<SpaceStorage> {
  const file = new URL(`./${spaceDid}.sqlite`, opts.spacesDir);
  // Ensure directory exists
  await Deno.mkdir(opts.spacesDir, { recursive: true });
  const handle = await openSqlite({ url: file });
  // For now return a stub until heads/tx are implemented
  return new UnimplementedSpace(handle);
}
