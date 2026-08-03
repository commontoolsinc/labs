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
import { computeInputHashFromValue } from "./fetch-utils.ts";
import { setPatternCell, setResultCell } from "../result-utils.ts";
import { scopedCell } from "./scope-policy.ts";
import { getPatternEnvironment } from "../builder/env.ts";
import type { NormalizedFullLink } from "../link-utils.ts";

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
 * `docs/development/fetch-request-deadlines.md` records why this bound stays
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
  let claimedRerunRequested = false;
  const serverBuiltinRuntimeWrites: NormalizedFullLink[] = [];
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

  const action: Action = (tx: IExtendedStorageTransaction) => {
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
    serverBuiltinRuntimeWrites.splice(
      0,
      serverBuiltinRuntimeWrites.length,
      pending.getAsNormalizedFullLink(),
      result.getAsNormalizedFullLink(),
      error.getAsNormalizedFullLink(),
      cache.getAsNormalizedFullLink(),
    );

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
    let state: FetchState = cacheEntry?.state ?? { type: "idle" };
    // A shadow incarnation can leave durable pending/error state without a
    // live request after claim activation aborts its local work. Keep the
    // marker through an initial idle->fetching transition so a suppressed
    // shadow outbox entry can be re-opened on the following run. Normal client
    // incarnations must not take over another incarnation's in-flight fetch.
    const reopenClaimedWork = claimedRerunRequested && state.type !== "idle" &&
      (state.type === "error" ||
        (state.type === "fetching" &&
          inFlight.get(inputHash) !== state.requestId));
    if (claimedRerunRequested && state.type !== "idle") {
      claimedRerunRequested = false;
    }
    if (reopenClaimedWork) {
      state = { type: "idle" };
      cache.withTx(tx).update({
        [inputHash]: { inputHash, state },
      });
    }

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
      // outbox id stays the input hash, which is what makes it an idempotency
      // key for the same request from anywhere.
      const requestId = `${runtime.id}:${inputHash}`;
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
              inputsCell,
              inputHash,
              url,
              { pending, result, error },
              abortController.signal,
            ).finally(() => {
              if (inFlight.get(inputHash) === requestId) {
                inFlight.delete(inputHash);
              }
            }),
            parentCell,
            { externalEffect: true },
          );
        },
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
  return Object.assign(action, {
    serverBuiltinRuntimeWrites,
    prepareClaimedRerun: () => {
      abortController?.abort("fetchProgram claim incarnation changed");
      abortController = undefined;
      // Main replaced the single `myRequestId` marker with the per-hash
      // `inFlight` map; forgetting this replica's claims is the same act.
      inFlight.clear();
      claimedRerunRequested = true;
    },
  });
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
 *
 * The writeback PUBLISHES the outputs itself rather than leaving the action's
 * next run to project them off the cache, which is what every other async
 * builtin here already does (`fetch.ts`'s `startFetch` takes the same three
 * cells; `llm`, `llmDialog`, `compileAndRun` and `sqliteQuery` all write their
 * own results from the continuation). It has to: the arc propagates the run's
 * `sourceAction` into its async continuations — the post-commit outbox flushes
 * each effect inside `runWithTransactionSourceAction`, and `Runtime.edit()`
 * adopts it (`compile-and-run.ts` documents why: without it the writes are
 * unattributable and no executor claim can cover them) — so this transaction
 * carries the fetchProgram action as its `sourceAction` and the scheduler
 * classifies the change as `skip-own-commit-source` (scheduler-v2 P5,
 * `scheduler/invalidation.ts`). No wake follows, so a cache-only writeback
 * strands `pending` at true with no result and no error, forever. Publishing
 * here cannot disagree with the projection: both are the same function of the
 * same entry, under the same "still `fetching`" and "inputs unchanged" guards.
 */
async function startFetch(
  runtime: Runtime,
  cache: Cell<Record<string, FetchCacheEntry>>,
  inputsCell: Cell<{ url: string; result?: ProgramResult }>,
  inputHash: string,
  url: string,
  outputs: {
    pending: Cell<boolean>;
    result: Cell<ProgramResult | undefined>;
    error: Cell<any | undefined>;
  },
  abortSignal: AbortSignal,
) {
  try {
    const mappedHost = runtime.mappedHostFor(cache.space);
    const apiBase = new URL(mappedHost ?? getPatternEnvironment().apiUrl);
    const resolvedMain = new URL(url, apiBase);
    const beganRelative = !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(url.trim()) &&
      !/^[\\/]{2}/.test(url.trim());
    // Create HTTP program resolver
    const resolver = new HttpProgramResolver(
      resolvedMain,
      (input, init) => {
        const target = input instanceof URL ? input : new URL(
          input instanceof Request ? input.url : input,
          resolvedMain,
        );
        const rawTarget = beganRelative && target.origin === resolvedMain.origin
          ? `${target.pathname}${target.search}`
          : target.href;
        return runtime.fetchBuiltin(
          "fetchProgram",
          rawTarget,
          target,
          { ...init, signal: abortSignal },
        );
      },
    );

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
      if (entry?.state.type !== "fetching") return;
      const data = { files: program.files, main: program.main };
      cache.withTx(tx).update({
        [inputHash]: { inputHash, state: { type: "success", data } },
      });
      publishOutputs(tx, inputsCell, inputHash, outputs, {
        result: data,
        error: undefined,
      });
    });
  } catch (err) {
    // Don't write errors if request was aborted
    if (abortSignal.aborted) return;

    await runtime.idle();

    // Only write into an entry that is still marked `fetching`.
    await runtime.editWithRetry((tx) => {
      const allEntries = cache.withTx(tx).get();
      const entry = allEntries[inputHash];
      if (entry?.state.type !== "fetching") return;
      const message = err instanceof Error ? err.message : String(err);
      cache.withTx(tx).update({
        [inputHash]: { inputHash, state: { type: "error", message } },
      });
      publishOutputs(tx, inputsCell, inputHash, outputs, {
        result: undefined,
        error: message,
      });
    });
  }
}

/**
 * Project a settled cache entry onto the output cells, exactly as the action's
 * own tail does — same `pending: false`, same `result`/`error` pairing.
 *
 * Guarded on the inputs still hashing to the entry this resolution owns. A
 * resolution that outlives an input change has already lost the outputs to the
 * newer request (the action re-ran and republished from the newer entry), and
 * its cache write remains useful — a later run for these inputs reads it — but
 * publishing here would overwrite the current request's outputs with an
 * unrelated program. `fetch.ts`'s error path takes the same guard.
 */
function publishOutputs(
  tx: IExtendedStorageTransaction,
  inputsCell: Cell<{ url: string; result?: ProgramResult }>,
  inputHash: string,
  outputs: {
    pending: Cell<boolean>;
    result: Cell<ProgramResult | undefined>;
    error: Cell<any | undefined>;
  },
  settled: { result: ProgramResult | undefined; error: string | undefined },
): void {
  const currentHash = computeInputHashFromValue(
    snapshotFetchProgramInputs(inputsCell.withTx(tx)),
  );
  if (currentHash !== inputHash) return;
  outputs.pending.withTx(tx).set(false);
  outputs.result.withTx(tx).set(settled.result);
  outputs.error.withTx(tx).set(settled.error);
}
