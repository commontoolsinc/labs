/**
 * Memory v2 Commit Validation and Application
 *
 * Processes client commits: validates read dependencies, assigns version
 * numbers, creates facts, and updates head pointers. All operations run
 * inside a single SQLite IMMEDIATE transaction for atomicity.
 *
 * @see spec 03-commit-model.md
 * @module v2-commit
 */

import type { Database } from "@db/sqlite";
import type {
  ClientCommit,
  Commit,
  ConflictDetail,
  JSONValue,
  StoredFact,
} from "./v2-types.ts";
import type { Reference } from "merkle-reference";
import {
  computeCommitHash,
  computeFactHash,
  computeValueHash,
  EMPTY,
} from "./v2-reference.ts";
import { V2Space } from "./v2-space.ts";

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class V2ConflictError extends Error {
  override name = "V2ConflictError" as const;
  conflicts: ConflictDetail[];

  constructor(conflicts: ConflictDetail[]) {
    super(`Conflict on ${conflicts.map((c) => c.id).join(", ")}`);
    this.conflicts = conflicts;
  }
}

// ---------------------------------------------------------------------------
// Commit application
// ---------------------------------------------------------------------------

/**
 * Apply a client commit to a v2 space database.
 *
 * Runs inside an IMMEDIATE transaction. Steps:
 * 1. Validate confirmed reads against current heads
 * 2. Assign next version (Lamport clock)
 * 3. For each operation, create fact, insert into DB, update head
 * 4. Insert commit record
 * 5. Update branch head_version
 * 6. Return Commit with facts
 *
 * @see spec 03-commit-model.md §3.6
 */
export function applyCommit(
  store: Database,
  clientCommit: ClientCommit,
): { ok: Commit } | { error: V2ConflictError } {
  const branch = clientCommit.branch ?? "";

  // Wrap the space for low-level operations
  // We use "" as subject since we only need the store operations
  const space = new V2Space("", store);

  try {
    const result = store.transaction(() => {
      // -----------------------------------------------------------------------
      // 1. Validate confirmed reads
      // -----------------------------------------------------------------------
      const conflicts: ConflictDetail[] = [];

      for (const read of clientCommit.reads.confirmed) {
        const head = space.readHead(branch, read.id);

        if (!head && read.version !== 0) {
          // Entity doesn't exist but client expected a version
          conflicts.push({
            id: read.id,
            expected: { version: read.version, hash: read.hash },
            actual: {
              version: 0,
              hash: EMPTY(read.id),
            },
          });
        } else if (head && read.version < head.version) {
          // Client's read is stale
          conflicts.push({
            id: read.id,
            expected: { version: read.version, hash: read.hash },
            actual: {
              version: head.version,
              hash: head.factHash as unknown as Reference,
            },
          });
        }
      }

      if (conflicts.length > 0) {
        throw new V2ConflictError(conflicts);
      }

      // -----------------------------------------------------------------------
      // 2. Assign next version
      // -----------------------------------------------------------------------
      const version = space.nextVersion(branch);

      // -----------------------------------------------------------------------
      // 3. Insert commit record first (facts reference it via FK)
      // -----------------------------------------------------------------------
      const commitHash = computeCommitHash(clientCommit);
      const commitHashStr = commitHash.toString();

      const readsJson = clientCommit.reads.confirmed.length > 0 ||
          clientCommit.reads.pending.length > 0
        ? JSON.stringify(clientCommit.reads)
        : null;
      space.insertCommit(commitHashStr, version, branch, readsJson);

      // -----------------------------------------------------------------------
      // 4. Process operations
      // -----------------------------------------------------------------------
      const facts: StoredFact[] = [];

      for (const op of clientCommit.operations) {
        switch (op.op) {
          case "set": {
            // Insert value
            const valueHash = computeValueHash(op.value);
            const valueHashStr = valueHash.toString();
            space.insertValue(valueHashStr, JSON.stringify(op.value));

            // Compute fact hash
            const fact = {
              type: "set" as const,
              id: op.id,
              value: op.value,
              parent: op.parent,
            };
            const factHash = computeFactHash(fact);
            const factHashStr = factHash.toString();
            const parentStr = op.parent.toString();
            const isEmptyParent = parentStr === EMPTY(op.id).toString();

            // Insert fact
            space.insertFact({
              hash: factHashStr,
              id: op.id,
              valueRef: valueHashStr,
              parent: isEmptyParent ? null : parentStr,
              branch,
              version,
              commitRef: commitHashStr,
              factType: "set",
            });

            // Update head
            space.updateHead(branch, op.id, factHashStr, version);

            facts.push({
              hash: factHash,
              fact,
              version,
              commitHash,
            });
            break;
          }

          case "patch": {
            // Insert ops as value
            const opsJson = JSON.stringify(op.patches);
            const opsHash = computeValueHash(
              op.patches as unknown as JSONValue,
            );
            const opsHashStr = opsHash.toString();
            space.insertValue(opsHashStr, opsJson);

            // Compute fact hash
            const fact = {
              type: "patch" as const,
              id: op.id,
              ops: op.patches,
              parent: op.parent,
            };
            const factHash = computeFactHash(fact);
            const factHashStr = factHash.toString();
            const parentStr = op.parent.toString();
            const isEmptyParent = parentStr === EMPTY(op.id).toString();

            // Insert fact
            space.insertFact({
              hash: factHashStr,
              id: op.id,
              valueRef: opsHashStr,
              parent: isEmptyParent ? null : parentStr,
              branch,
              version,
              commitRef: commitHashStr,
              factType: "patch",
            });

            // Update head
            space.updateHead(branch, op.id, factHashStr, version);

            facts.push({
              hash: factHash,
              fact,
              version,
              commitHash,
            });
            break;
          }

          case "delete": {
            // Compute fact hash
            const fact = {
              type: "delete" as const,
              id: op.id,
              parent: op.parent,
            };
            const factHash = computeFactHash(fact);
            const factHashStr = factHash.toString();
            const parentStr = op.parent.toString();
            const isEmptyParent = parentStr === EMPTY(op.id).toString();

            // Insert fact (value_ref = __empty__)
            space.insertFact({
              hash: factHashStr,
              id: op.id,
              valueRef: "__empty__",
              parent: isEmptyParent ? null : parentStr,
              branch,
              version,
              commitRef: commitHashStr,
              factType: "delete",
            });

            // Update head
            space.updateHead(branch, op.id, factHashStr, version);

            facts.push({
              hash: factHash,
              fact,
              version,
              commitHash,
            });
            break;
          }

          case "claim": {
            // Validate only — check that entity's head matches claimed parent
            const head = space.readHead(branch, op.id);
            const currentHash = head ? head.factHash : EMPTY(op.id).toString();
            const expectedHash = op.parent.toString();

            if (currentHash !== expectedHash) {
              throw new V2ConflictError([
                {
                  id: op.id,
                  expected: {
                    version: head?.version ?? 0,
                    hash: op.parent,
                  },
                  actual: {
                    version: head?.version ?? 0,
                    hash: currentHash as unknown as Reference,
                  },
                },
              ]);
            }
            // No write for claims
            break;
          }
        }
      }

      // -----------------------------------------------------------------------
      // 5. Update branch head_version
      // -----------------------------------------------------------------------
      space.updateBranchHeadVersion(branch, version);

      // -----------------------------------------------------------------------
      // 6. Build result
      // -----------------------------------------------------------------------
      const commit: Commit = {
        hash: commitHash,
        version,
        branch,
        facts,
        createdAt: new Date().toISOString(),
      };

      return commit;
    }).immediate();

    return { ok: result };
  } catch (error) {
    if (error instanceof V2ConflictError) {
      return { error };
    }
    throw error;
  }
}
