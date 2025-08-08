import type {
  BranchName,
  BranchRef,
  BranchState,
  DocId,
  Heads,
  ReadAssert,
  SpaceStorage,
  SubmittedChange,
  TxDocResult,
  TxReceipt,
  TxRequest,
} from "../interface.ts";

// Minimal in-memory storage engine following the spec semantics.
// Heads logic, seq numbers, and simple epoch counter per space.

function canonicalHeads(heads: Heads): Heads {
  return [...new Set(heads)].sort();
}

function nowIso(): string {
  return new Date().toISOString();
}

interface BranchData {
  branchId: string;
  heads: string[]; // canonical sorted
  seqNo: number;
  rootRef?: string;
}

interface DocData {
  branches: Map<string, BranchData>; // key: branch name
}

export class InMemorySpaceStorage implements SpaceStorage {
  private readonly docs = new Map<DocId, DocData>();
  private epoch = 0;

  async getOrCreateDoc(docId: DocId): Promise<void> {
    if (!this.docs.has(docId)) {
      this.docs.set(docId, { branches: new Map() });
    }
  }

  async getOrCreateBranch(
    docId: DocId,
    branch: BranchName,
  ): Promise<BranchState> {
    await this.getOrCreateDoc(docId);
    const doc = this.docs.get(docId)!;
    if (!doc.branches.has(branch)) {
      const branchId = `${docId}#${branch}`;
      doc.branches.set(branch, { branchId, heads: [], seqNo: 0 });
    }
    return this.toBranchState(docId, branch);
  }

  async getBranchState(docId: DocId, branch: BranchName): Promise<BranchState> {
    await this.getOrCreateBranch(docId, branch);
    return this.toBranchState(docId, branch);
  }

  private toBranchState(docId: DocId, branch: BranchName): BranchState {
    const d = this.docs.get(docId)!;
    const b = d.branches.get(branch)!;
    return {
      branchId: b.branchId,
      heads: [...b.heads],
      seqNo: b.seqNo,
      epoch: this.epoch,
      rootRef: b.rootRef,
    };
  }

  async submitTx(req: TxRequest): Promise<TxReceipt> {
    // Validate read assertions first: heads must match current.
    const conflicts: TxDocResult[] = [];
    for (const read of req.reads) {
      const st = await this.getBranchState(read.ref.docId, read.ref.branch);
      if (!equalHeads(st.heads, read.heads)) {
        conflicts.push({
          ref: read.ref,
          status: "conflict",
          reason: "ReadConflict",
        });
      }
    }
    if (conflicts.length) {
      return {
        txId: this.epoch,
        committedAt: nowIso(),
        results: [],
        conflicts,
      };
    }

    // Process writes: validate baseHeads and update heads with submitted changes.
    const results: TxDocResult[] = [];
    for (const w of req.writes) {
      const st = await this.getBranchState(w.ref.docId, w.ref.branch);
      if (!equalHeads(st.heads, w.baseHeads)) {
        results.push({ ref: w.ref, status: "conflict", reason: "BaseHeadsMismatch" });
        continue;
      }

      const branchData = this.docs.get(w.ref.docId)!.branches.get(w.ref.branch)!;

      let newHeads = [...branchData.heads];
      let applied = 0;

      for (const ch of w.changes) {
        const hdr = decodeChangeHeader(ch);
        // deps must be subset of current heads (non-merge) or any heads for merge
        for (const dep of hdr.deps) {
          if (!newHeads.includes(dep)) {
            results.push({
              ref: w.ref,
              status: "rejected",
              reason: `MissingDep:${dep}`,
            });
            // Stop processing further changes for this write.
            applied = 0;
            break;
          }
        }
        if (applied === 0 && results.at(-1)?.status === "rejected") {
          break;
        }
        // Update heads set: (heads - deps) U {hash}
        newHeads = canonicalHeads(newHeads.filter((h) => !hdr.deps.includes(h)).concat(hdr.changeHash));
        applied += 1;
      }

      if (applied > 0) {
        branchData.heads = newHeads;
        branchData.seqNo += applied;
        // rootRef computation is deferred/not implemented in-memory
        results.push({ ref: w.ref, status: "ok", newHeads, applied });
      } else if (!results.find((r) => r.ref === w.ref && r.status !== "ok")) {
        results.push({ ref: w.ref, status: "rejected", reason: "NoChangesApplied" });
      }
    }

    // Increment epoch for a successful tx definitionally even with partial rejects
    this.epoch += 1;

    return {
      txId: this.epoch,
      committedAt: nowIso(),
      results,
      conflicts,
    };
  }

  async getDocBytes(): Promise<Uint8Array> {
    // Not implemented in in-memory MVP; PIT/snapshots require Automerge state.
    return new Uint8Array();
  }
}

function equalHeads(a: Heads, b: Heads): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function decodeChangeHeader(change: SubmittedChange) {
  // Placeholder: in full impl we'd parse Automerge change bytes to get header
  // For now, we derive a pseudo-hash from bytes and assume no deps.
  const hash = pseudoHash(change.bytes);
  return { changeHash: hash, deps: [], actorId: "", seq: 0 };
}

function pseudoHash(bytes: Uint8Array): string {
  // Simple deterministic hash for testing without pulling crypto yet
  let h = 0;
  for (let i = 0; i < bytes.length; i++) {
    h = (h * 31 + bytes[i]) >>> 0;
  }
  return `h${h.toString(16).padStart(8, "0")}`;
}
