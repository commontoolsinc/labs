import { type Cell } from "../cell.ts";
import { type Action } from "../scheduler.ts";
import type { Runtime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import type { CellScope } from "../builder/types.ts";
import { internSchema } from "@commonfabric/data-model/schema-hash";
import { HttpProgramResolver } from "@commonfabric/js-compiler/program";
import { ensureCompilerStack } from "../harness/deferred-compiler-stack.ts";
import { createFrozenRequestSnapshot } from "../cfc/request-snapshot.ts";
import { enqueueSinkRequestPostCommitEffect } from "../cfc/sink-request.ts";
import {
  effectTargetKey,
  markEffectCompletion,
} from "../executor/effect-completion.ts";
import { computeInputHashFromValue } from "./fetch-utils.ts";
import { setPatternCell, setResultCell } from "../result-utils.ts";
import { scopedCell } from "./scope-policy.ts";

/**
 * How long a `fetching` cache entry left by another replica is believed before
 * this one takes the resolution over.
 *
 * This is not a bound on resolving a program. A resolution running here ends
 * when its promise settles, and the entry it owns is never judged by elapsed
 * time — `inFlight` below answers "am I already resolving this?" from local
 * state. The bound applies only to an entry this replica did not claim, where
 * the question is whether the replica that claimed it is still there. Nothing
 * in the runner reports another replica's presence, so that question has no
 * event to wait on.
 *
 * The value is left where it was. Once an early takeover no longer costs a
 * result, the size is a trade with a cost on both sides: too low duplicates a
 * resolution whenever another replica looks in while one is running, too high
 * leaves a replica that arrives before the bound elapses looking at a claim it
 * will not take over and has no reason to re-examine, so the piece keeps
 * showing a spinner. A duplicated resolution is wasted work; a spinner that
 * never resolves is a dead end, so the trade goes to the lower value.
 *
 * `docs/features/fetch-request-deadlines.md` records why this bound stays
 * and what an early takeover costs.
 */
const PROGRAM_CLAIM_STALE_AFTER = 1000 * 10;

export interface ProgramResult {
  files: Array<{ name: string; contents: string }>;
  main: string;
}

// State machine for fetch lifecycle
type FetchState =
  | { type: "idle" }
  | { type: "fetching"; requestId: string; startTime: number }
  | { type: "success"; data: ProgramResult }
  | { type: "error"; message: string };

// Single source of truth for fetch status
interface FetchCacheEntry {
  inputHash: string;
  state: FetchState;
}

const fetchProgramInputSchema = internSchema(
  {
    type: "object",
    properties: {
      url: { type: "string" },
    },
  },
);

function snapshotFetchProgramInputs(
  cell: Cell<{ url?: string; result?: ProgramResult }>,
): { url?: string } {
  const snapshot = cell.asSchema(fetchProgramInputSchema).get() ??
    ({} as { url?: string });
  return createFrozenRequestSnapshot({ url: snapshot.url });
}

// Full schema for cache structure to ensure proper validation when reading back
// from storage. Without this, nested arrays may have undefined elements due to
// incomplete schema-based transformation.
const cacheSchema = internSchema(
  {
    type: "object",
    default: {},
    additionalProperties: {
      type: "object",
      properties: {
        inputHash: { type: "string" },
        state: {
          anyOf: [
            { type: "object", properties: { type: { const: "idle" } } },
            {
              type: "object",
              properties: {
                type: { const: "fetching" },
                requestId: { type: "string" },
                startTime: { type: "number" },
              },
            },
            {
              type: "object",
              properties: {
                type: { const: "success" },
                data: {
                  type: "object",
                  properties: {
                    files: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          name: { type: "string" },
                          contents: { type: "string" },
                        },
                        required: ["name", "contents"],
                      },
                    },
                    main: { type: "string" },
                  },
                  required: ["files", "main"],
                },
              },
            },
            {
              type: "object",
              properties: {
                type: { const: "error" },
                message: { type: "string" },
              },
            },
          ],
        },
      },
    },
  },
);

/**
 * Fetch and resolve a program from a URL.
 *
 * Returns the resolved program as `result` with structure { files, main }.
 * `pending` is true while resolution is in progress.
 *
 * @param url - A cell containing the URL to fetch the program from.
 * @returns { pending: boolean, result: ProgramResult, error: any } - As individual cells.
 */
export function fetchProgram(
  inputsCell: Cell<{ url: string; result?: ProgramResult }>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  addCancel: (cancel: () => void) => void,
  cause: Cell<any>[],
  parentCell: Cell<any>,
  runtime: Runtime,
): Action {
  let cellsInitialized = false;
  let pending: Cell<boolean>;
  let result: Cell<ProgramResult | undefined>;
  let error: Cell<any | undefined>;
  let cache: Cell<Record<string, FetchCacheEntry>>;
  let cellScope: CellScope | undefined;
  let abortController: AbortController | undefined = undefined;
  // Input hash to the claim id this replica wrote for it, for every resolution
  // running here right now. The claim id carries `runtime.id`, which is unique
  // per storage manager and so per replica; the entry's `requestId` used to be
  // the input hash, which every replica resolving the same URL writes
  // identically, so no replica could tell its own claim from anyone else's.
  const inFlight = new Map<string, string>();

  // This is called when the pattern containing this node is being stopped.
  addCancel(() => {
    // Abort the request if it's still pending.
    abortController?.abort("Pattern stopped");

    // Only try to update state if cells were initialized
    if (!cellsInitialized || inFlight.size === 0) return;

    const tx = runtime.edit();
    // Teardown tx on piece stop — no scheduler run stamps it;
    // bookkeeping per serving-loop.md §3d, RULED 2026-08-05, so a
    // serving runtime releases this replica's claims instead of
    // refusing the unstamped seal. No-op off the serving posture.
    runtime.stampServerRun(tx, {
      actionId: `fetchProgram/teardown/${parentCell.sourceURI}`,
      kind: "bookkeeping",
    });

    try {
      // If we were fetching, transition back to idle
      const currentCache = cache.withTx(tx).get();
      const updates: Record<string, FetchCacheEntry> = {};

      // Release only the entries this replica still holds. An entry another
      // replica took over carries its claim id, not ours, and resetting it
      // would strand the resolution that replica is running.
      for (const [hash, entry] of Object.entries(currentCache)) {
        if (
          entry.state.type === "fetching" &&
          entry.state.requestId === inFlight.get(hash)
        ) {
          updates[hash] = {
            inputHash: hash,
            state: { type: "idle" },
          };
        }
      }

      if (Object.keys(updates).length > 0) {
        cache.withTx(tx).update(updates);
      }

      runtime.prepareTxForCommit(tx);
      tx.commit();
    } catch (_) {
      // Ignore errors during cleanup - the runtime might be shutting down
      tx.abort();
    }
  });

  return (tx: IExtendedStorageTransaction) => {
    tx.resetNarrowestReadScope();
    const requestSnapshot = snapshotFetchProgramInputs(inputsCell.withTx(tx));
    const outputScope = tx.getNarrowestReadScope();

    if (!cellsInitialized || cellScope !== outputScope) {
      const basePending = runtime.getCell<boolean>(
        parentCell.space,
        { fetchProgram: { pending: cause } },
        undefined,
        tx,
      );
      pending = scopedCell(runtime, tx, basePending, outputScope);

      const baseResult = runtime.getCell<ProgramResult | undefined>(
        parentCell.space,
        {
          fetchProgram: { result: cause },
        },
        undefined,
        tx,
      );
      result = scopedCell(runtime, tx, baseResult, outputScope);

      const baseError = runtime.getCell<any | undefined>(
        parentCell.space,
        {
          fetchProgram: { error: cause },
        },
        undefined,
        tx,
      );
      error = scopedCell(runtime, tx, baseError, outputScope);

      const baseCache = runtime.getCell(
        parentCell.space,
        { fetchProgram: { cache: cause } },
        cacheSchema,
        tx,
      ) as Cell<Record<string, FetchCacheEntry>>;
      cache = scopedCell(
        runtime,
        tx,
        baseCache,
        outputScope,
      ) as Cell<Record<string, FetchCacheEntry>>;

      // Link the new result cells to the parent result cell
      setResultCell(pending, parentCell);
      setResultCell(result, parentCell);
      setResultCell(error, parentCell);
      setResultCell(cache, parentCell);
      // Link the new result cells to the pattern cell too
      const patternCellPtr = parentCell.key("pattern");
      setPatternCell(pending, patternCellPtr);
      setPatternCell(result, patternCellPtr);
      setPatternCell(error, patternCellPtr);
      setPatternCell(cache, patternCellPtr);

      // Kick off sync in the background
      pending.sync();
      result.sync();
      error.sync();
      cache.sync();

      // The cells above are re-minted when the scope changes, so a resolution
      // started under the old scope writes into the old scope's cache and says
      // nothing about the new one. Forget those claims; their `finally` sees a
      // claim id that is no longer recorded and leaves the map alone.
      inFlight.clear();

      cellsInitialized = true;
      cellScope = outputScope;
    }

    const { url } = requestSnapshot;
    const inputHash = computeInputHashFromValue(requestSnapshot);

    if (!url) {
      // When URL is empty, clear outputs
      pending.withTx(tx).set(false);
      result.withTx(tx).set(undefined);
      error.withTx(tx).set(undefined);
      sendResult(tx, { pending, result, error });
      return;
    }

    // Get current state for this input hash
    const allEntries = cache.withTx(tx).get();
    const cacheEntry = allEntries[inputHash];
    const state: FetchState = cacheEntry?.state ?? { type: "idle" };

    // State machine transitions. A resolution running in this replica ends
    // when its promise settles, so an entry in `inFlight` is left alone
    // whatever the entry says and however long it has been running. An entry
    // claimed elsewhere and left untouched for longer than the staleness bound
    // is taken over directly, without passing through `idle`: a round trip
    // through `idle` would publish `pending: false` with no result for a tick,
    // which reads to a consumer as "finished, nothing here".
    const resolvingHere = inFlight.has(inputHash);
    const claimAbandoned = state.type === "fetching" && !resolvingHere &&
      Date.now() - state.startTime > PROGRAM_CLAIM_STALE_AFTER;

    if (!resolvingHere && (state.type === "idle" || claimAbandoned)) {
      // Try to transition to fetching. The claim id names this replica; the
      // outbox/dedupe key is the input hash WIDENED BY THIS NODE's cache-cell
      // identity (effectTargetKey): the per-node cache doc is the writeback
      // target, so a DISTINCT node with the same URL must keep its own
      // effect — a shared bare-hash key dropped the second node's closure
      // and left its cache entry `fetching` forever (round-2 headline).
      const requestId = `${runtime.id}:${inputHash}`;
      const effectKey = effectTargetKey(`fetchProgram:${inputHash}`, cache);
      cache.withTx(tx).update({
        [inputHash]: {
          inputHash,
          state: { type: "fetching", requestId, startTime: Date.now() },
        },
      });

      enqueueSinkRequestPostCommitEffect(
        tx,
        "fetchProgram",
        `fetchProgram:${inputHash}`,
        requestSnapshot,
        "fetchProgram-start",
        () => {
          // Start fetch asynchronously only after the transaction commits.
          // Tracked as async builtin work owned by this run, so
          // `runtime.settled()` and `runtime.settledFor(parentCell)` both wait
          // for the program resolve + writeback; `idle()` does not.
          // Recorded in `inFlight` here rather than above, because a
          // transaction that never commits never reaches this callback.
          inFlight.set(inputHash, requestId);
          abortController = new AbortController();
          runtime.trackAsyncWork(
            startFetch(
              runtime,
              cache,
              inputHash,
              url,
              abortController.signal,
              effectKey,
            ).finally(() => {
              if (inFlight.get(inputHash) === requestId) {
                inFlight.delete(inputHash);
              }
            }),
            parentCell,
          );
        },
        { idempotencyKey: effectKey },
      );
    }

    // Convert state machine state to output cells
    const currentEntries = cache.withTx(tx).get();
    const currentState = currentEntries[inputHash]?.state ?? {
      type: "idle",
    };
    pending.withTx(tx).set(currentState.type === "fetching");
    result.withTx(tx).set(
      currentState.type === "success" ? currentState.data : undefined,
    );
    error.withTx(tx).set(
      currentState.type === "error" ? currentState.message : undefined,
    );

    sendResult(tx, { pending, result, error });
  };
}

/**
 * Start fetching a program. The writeback lands only on an entry still marked
 * `fetching`, so a resolution whose entry has since reached `success` or
 * `error`, or been released, writes nothing. It deliberately does not require
 * the entry to carry *this* replica's claim id: after a takeover two
 * resolutions for the same input hash are running, they resolve the same URL,
 * and whichever finishes first should be the one that counts.
 *
 * The abort signal does not reach the network. `HttpProgramResolver` issues its
 * requests without one, so this checks the signal between steps: it suppresses
 * a writeback from a resolution nobody is waiting for, and does not end the
 * resolution.
 */
async function startFetch(
  runtime: Runtime,
  cache: Cell<Record<string, FetchCacheEntry>>,
  inputHash: string,
  url: string,
  abortSignal: AbortSignal,
  effectKey: string,
) {
  try {
    // Create HTTP program resolver
    const resolver = new HttpProgramResolver(url);

    // Program resolution parses; load the deferred compiler stack first.
    const { resolveProgram, ts } = await ensureCompilerStack();

    // Resolve the program with all dependencies
    const program = await resolveProgram(resolver, {
      unresolvedModules: { type: "allow-all" },
      resolveUnresolvedModuleTypes: true,
      target: ts.ScriptTarget.ES2023,
    });

    // Check if aborted during resolution
    if (abortSignal.aborted) return;

    await runtime.idle();

    // Only write into an entry that is still marked `fetching`.
    await runtime.editWithRetry((tx) => {
      const allEntries = cache.withTx(tx).get();
      const entry = allEntries[inputHash];
      if (entry?.state.type === "fetching") {
        // Marked on the arm that writes (round-2 thread 12): a
        // suppressed writeback (the entry already resolved by a
        // competing resolution) must not commit as a spurious no-op
        // effect-completion for an already-completed key.
        markEffectCompletion(tx, effectKey);
        cache.withTx(tx).update({
          [inputHash]: {
            inputHash,
            state: {
              type: "success",
              data: { files: program.files, main: program.main },
            },
          },
        });
      }
    });
  } catch (err) {
    // Don't write errors if request was aborted
    if (abortSignal.aborted) return;

    await runtime.idle();

    // Only write into an entry that is still marked `fetching`.
    await runtime.editWithRetry((tx) => {
      const allEntries = cache.withTx(tx).get();
      const entry = allEntries[inputHash];
      if (entry?.state.type === "fetching") {
        // Marked on the arm that writes — see the success path above
        // (round-2 thread 12).
        markEffectCompletion(tx, effectKey);
        cache.withTx(tx).update({
          [inputHash]: {
            inputHash,
            state: {
              type: "error",
              message: err instanceof Error ? err.message : String(err),
            },
          },
        });
      }
    });
  }
}
