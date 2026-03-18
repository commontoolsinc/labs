import { type Cell } from "../cell.ts";
import { type Action } from "../scheduler.ts";
import type { Runtime } from "../runtime.ts";
import { getPatternEnvironment } from "../builder/env.ts";
import type {
  IExtendedStorageTransaction,
  MemorySpace,
} from "../storage/interface.ts";
import type { Schema } from "../builder/types.ts";
import {
  computeInputHashFromValue,
  internalSchema,
  tryClaimMutex,
  tryWriteResult,
} from "./fetch-utils.ts";
import {
  fetchAuthorizationHeaderPlacementAllowed,
} from "../cfc/fetch-auth-structure.ts";
import { commitCfcFetchIntentWithRetries } from "../cfc/fetch-intent-commit.ts";
import {
  authorizeFetchSinkRequest,
  deriveFetchSinkResultLabels,
  writeFetchResultLabels,
} from "../cfc/fetch-sink-labels.ts";
import {
  type CfcAtom,
  joinIntegrityLabels,
  normalizeIntegrityLabel,
} from "../cfc/label-algebra.ts";
import {
  type FetchDataInputs,
  type NormalizedFetchDataInputs,
  snapshotFetchDataInputs,
} from "./fetch-request.ts";

/**
 * Fetch data from a URL.
 *
 * Returns the fetched result as `result`. `pending` is true while a request is pending.
 *
 * @param url - A doc containing the URL to fetch data from.
 * @param mode - The mode to use for fetching data. Either `text` or `json`
 *   default to `json` results.
 * @returns { pending: boolean, result: any, error: any } - As individual docs, representing `pending` state, final `result`, and any `error`.
 */
export function fetchData(
  inputsCell: Cell<FetchDataInputs>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  addCancel: (cancel: () => void) => void,
  cause: Cell<any>[],
  parentCell: Cell<any>,
  runtime: Runtime, // Runtime will be injected by the registration function
): Action {
  let cellsInitialized = false;
  let pending: Cell<boolean>;
  let result: Cell<any | undefined>;
  let error: Cell<any | undefined>;
  let internal: Cell<Schema<typeof internalSchema>>;
  let myRequestId: string | undefined = undefined;
  let abortController: AbortController | undefined = undefined;

  // This is called when the pattern containing this node is being stopped.
  addCancel(() => {
    // Abort the request if it's still pending.
    abortController?.abort("Pattern stopped");

    // Only try to update state if cells were initialized
    if (!cellsInitialized) return;

    const tx = runtime.edit();

    try {
      // If the pending request is ours, set pending to false and clear the requestId.
      const currentRequestId = internal.withTx(tx).key("requestId").get();
      if (currentRequestId === myRequestId) {
        pending.withTx(tx).set(false);
        internal.withTx(tx).key("requestId").set("");
      }

      // Since we're aborting, don't retry. If the above fails, it's because the
      // requestId was already changing under us.
      tx.commit();
    } catch (_) {
      // Ignore errors during cleanup - the runtime might be shutting down
      tx.abort();
    }
  });

  return (tx: IExtendedStorageTransaction) => {
    if (!cellsInitialized) {
      pending = runtime.getCell(
        parentCell.space,
        { fetchData: { pending: cause } },
        undefined,
        tx,
      );

      result = runtime.getCell<any | undefined>(
        parentCell.space,
        {
          fetchData: { result: cause },
        },
        undefined,
        tx,
      );

      error = runtime.getCell<any | undefined>(
        parentCell.space,
        {
          fetchData: { error: cause },
        },
        undefined,
        tx,
      );

      internal = runtime.getCell(
        parentCell.space,
        { fetchData: { internal: cause } },
        internalSchema,
        tx,
      );

      pending.setSourceCell(parentCell);
      result.setSourceCell(parentCell);
      error.setSourceCell(parentCell);
      internal.setSourceCell(parentCell);

      // Kick off sync in the background
      pending.sync();
      result.sync();
      error.sync();
      internal.sync();

      cellsInitialized = true;
    }

    // Set results to links to our cells. We have to do this outside of
    // isInitialized since the write could conflict, and then this code will run
    // again, but isInitialized will be true already. The framework will notice
    // that this write is a no-op after the first successful write, so this
    // should be fine.
    sendResult(tx, { pending, result, error });

    const inputsSnapshot = snapshotFetchDataInputs(inputsCell.withTx(tx));
    const url = inputsSnapshot?.url;
    if (!url) {
      // Only update if values actually need to change to reduce transaction conflicts
      const currentPending = pending.withTx(tx).get();
      const currentResult = result.withTx(tx).get();
      const currentError = error.withTx(tx).get();
      const currentInternal = internal.withTx(tx).get();

      if (currentPending !== false) pending.withTx(tx).set(false);
      if (currentResult !== undefined) result.withTx(tx).set(undefined);
      if (currentError !== undefined) error.withTx(tx).set(undefined);
      // Clear internal state when URL is empty so we don't think we have cached results
      if (currentInternal.inputHash !== "") {
        internal.withTx(tx).set({
          requestId: "",
          lastActivity: 0,
          inputHash: "",
        });
      }
      return;
    }

    const inputHash = computeInputHashFromValue(inputsSnapshot);
    // Check if we're already working on or have the result for these inputs
    const currentInternal = internal.withTx(tx).get();
    const currentPending = pending.withTx(tx).get();
    const currentResult = result.withTx(tx).get();
    const currentError = error.withTx(tx).get();

    const inputsMatch = currentInternal?.inputHash === inputHash;

    // If inputs changed, clear everything and abort any in-flight request
    if (!inputsMatch) {
      if (myRequestId) {
        abortController?.abort("Inputs changed");
        myRequestId = undefined;
      }

      pending.withTx(tx).set(false);
      result.withTx(tx).set(undefined);
      error.withTx(tx).set(undefined);
      internal.withTx(tx).update({
        inputHash,
        requestId: "",
        lastActivity: 0,
      });
    }

    // If we have a result OR error for these inputs, we're done
    const hasValidResult = inputsMatch && currentResult !== undefined;
    const hasError = inputsMatch && currentError !== undefined;

    // If we're already fetching these inputs, wait
    const alreadyFetching = inputsMatch && currentPending &&
      myRequestId !== undefined;

    // Start a new fetch if we don't have a result/error and aren't already fetching
    if (!hasValidResult && !hasError && !alreadyFetching) {
      const newRequestId = crypto.randomUUID();
      // Try to claim mutex - returns immediately if another tab is processing
      tryClaimMutex(
        runtime,
        inputsCell,
        pending,
        result,
        error,
        internal,
        newRequestId,
        // Materialize inputs via the schema system and preprocess body.
        // asSchema().get() returns a frozen plain snapshot with nested
        // properties (like options.headers) fully resolved, safe to use
        // after commit.
        snapshotFetchDataInputs,
      ).then(
        ({ claimed, inputs, inputHash }) => {
          if (!claimed) {
            // Another tab is handling this, we're done
            return;
          }

          const normalizedInputs = inputs as NormalizedFetchDataInputs;
          const { url } = normalizedInputs;

          // Clear any previous result/error when starting a new fetch
          // This ensures observers see a clean pending state
          runtime.editWithRetry((tx) => {
            result.withTx(tx).set(undefined);
            error.withTx(tx).set(undefined);
          });

          // Check if URL became empty while waiting for mutex
          if (!url) {
            // Release the lock and clear state
            myRequestId = undefined;
            runtime.editWithRetry((tx) => {
              pending.withTx(tx).set(false);
              result.withTx(tx).set(undefined);
              error.withTx(tx).set(undefined);
              internal.withTx(tx).set({
                requestId: "",
                lastActivity: 0,
                inputHash: "",
              });
            });
            return;
          }

          abortController = new AbortController();

          // We claimed the mutex, start the fetch
          myRequestId = newRequestId;
          startFetch(
            runtime,
            parentCell.space,
            parentCell,
            inputsCell,
            normalizedInputs,
            inputHash,
            pending,
            result,
            error,
            internal,
            abortController.signal,
          );
        },
      );
    }
  };
}

async function startFetch(
  runtime: Runtime,
  space: MemorySpace,
  parentCell: Cell<any>,
  inputsCell: Cell<FetchDataInputs>,
  inputs: NormalizedFetchDataInputs,
  inputHash: string,
  pending: Cell<boolean>,
  result: Cell<any | undefined>,
  error: Cell<any | undefined>,
  internal: Cell<Schema<typeof internalSchema>>,
  abortSignal: AbortSignal,
) {
  const { url, mode, options, cfc } = inputs;
  if (!url) {
    return;
  }

  const responseHeadersToObject = (
    response: Response,
  ): Record<string, string> => {
    const headers: Record<string, string> = {};
    for (const [key, value] of response.headers.entries()) {
      headers[key] = value;
    }
    return headers;
  };

  const buildFetchHttpError = async (response: Response): Promise<Error> => {
    const contentMode = mode || "json";
    let parsedBody: unknown = undefined;

    try {
      parsedBody = contentMode === "json"
        ? await response.json()
        : await response.text();
    } catch {
      parsedBody = undefined;
    }

    const parsedError = parsedBody &&
        typeof parsedBody === "object" &&
        !Array.isArray(parsedBody) &&
        "error" in parsedBody
      ? (parsedBody as { error?: unknown }).error
      : undefined;
    const errorRecord = parsedError &&
        typeof parsedError === "object" &&
        !Array.isArray(parsedError)
      ? parsedError as Record<string, unknown>
      : undefined;
    const messageSource = typeof errorRecord?.message === "string"
      ? errorRecord.message
      : typeof parsedBody === "string"
      ? parsedBody
      : response.statusText;
    const error = new Error(`HTTP ${response.status}: ${messageSource}`);

    Object.assign(error, {
      code: typeof errorRecord?.code === "number"
        ? errorRecord.code
        : response.status,
      status: typeof errorRecord?.status === "string"
        ? errorRecord.status
        : response.statusText,
      headers: responseHeadersToObject(response),
      httpStatus: response.status,
      httpStatusText: response.statusText,
      ...(parsedError !== undefined ? { error: parsedError } : {}),
      ...(parsedError === undefined && parsedBody !== undefined
        ? { body: parsedBody }
        : {}),
    });

    return error;
  };

  const processResponse = async (r: Response) => {
    if (!r.ok) {
      throw await buildFetchHttpError(r);
    }
    return (mode || "json") === "json" ? await r.json() : await r.text();
  };

  const writeIntentFailure = async (failure: string) => {
    await runtime.editWithRetry((tx) => {
      const currentHash = computeInputHashFromValue(
        snapshotFetchDataInputs(inputsCell.withTx(tx)),
      );
      pending.withTx(tx).set(false);
      result.withTx(tx).set(undefined);
      if (currentHash === inputHash) {
        error.withTx(tx).set(failure);
        internal.withTx(tx).update({ inputHash });
      }
    });
  };

  // Body preprocessing (stringify non-string bodies) is handled by the
  // snapshotInputs callback in tryClaimMutex, so options is ready to use.
  let observedHttpResponse = false;
  try {
    const intent = cfc?.intent;
    if (intent) {
      let committedRequestIntegrity: readonly CfcAtom[] | undefined;
      const authorization = options?.headers?.Authorization ??
        options?.headers?.authorization;
      if (
        authorization &&
        !fetchAuthorizationHeaderPlacementAllowed(inputs, authorization)
      ) {
        await writeIntentFailure("authorization_header_placement_invalid");
        return;
      }

      const commitResult = await commitCfcFetchIntentWithRetries(
        runtime,
        space,
        intent,
        inputs,
        async (attemptNumber) => {
          try {
            let additionalRequestIntegrity = normalizeIntegrityLabel(
              intent.integrity,
            ) ?? [];
            if (intent.targetPrincipal) {
              const requestAudience = new URL(
                url,
                getPatternEnvironment().apiUrl,
              ).origin;
              const audienceVerified = await runtime.verifyCfcAudienceAtCommit({
                principal: intent.targetPrincipal,
                audience: requestAudience,
                endpoint: cfc.endpoint,
                intentId: intent.id,
                operation: intent.operation,
              });
              if (!audienceVerified) {
                return {
                  success: false,
                  error: "audience_verification_failed",
                  terminal: true,
                };
              }
              additionalRequestIntegrity = joinIntegrityLabels(
                additionalRequestIntegrity,
                [
                  {
                    type:
                      "https://commonfabric.org/cfc/atom/AudienceRepresents",
                    principal: intent.targetPrincipal,
                    audience: requestAudience,
                  },
                ],
              ) ?? additionalRequestIntegrity;
            }

            const requestAuthorized = await authorizeFetchSinkRequest(
              runtime,
              inputsCell,
              {
                endpoint: cfc.endpoint,
                additionalRequestIntegrity,
              },
            );
            if (!requestAuthorized) {
              return {
                success: false,
                error: "fetch_request_not_authorized",
                terminal: true,
              };
            }
            committedRequestIntegrity = additionalRequestIntegrity;

            const response = await fetch(
              new URL(url, getPatternEnvironment().apiUrl),
              {
                signal: abortSignal,
                ...options,
              },
            );
            observedHttpResponse = true;
            const data = await processResponse(response);
            return {
              success: true,
              attemptNumber,
              result: data,
            };
          } catch (err) {
            if (abortSignal.aborted) {
              return {
                success: false,
                error: "aborted",
              };
            }
            return {
              success: false,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        },
        {
          endpoint: cfc.endpoint,
        },
      );

      if (abortSignal.aborted) {
        return;
      }

      await runtime.idle();

      if (commitResult.success) {
        const sinkLabels = await deriveFetchSinkResultLabels(
          runtime,
          inputsCell,
          inputs,
          {
            endpoint: cfc.endpoint,
            additionalRequestIntegrity: committedRequestIntegrity,
          },
        );
        await tryWriteResult(
          runtime,
          internal,
          inputsCell,
          inputHash,
          (tx) => {
            pending.withTx(tx).set(false);
            result.withTx(tx).set(commitResult.result);
            error.withTx(tx).set(undefined);
            writeFetchResultLabels(tx, result, sinkLabels);
            writeFetchResultLabels(tx, parentCell, sinkLabels, "/result");
            const publicResultCell = parentCell.getSourceCell();
            if (publicResultCell) {
              writeFetchResultLabels(
                tx,
                publicResultCell,
                sinkLabels,
                "/result",
              );
            }
          },
          snapshotFetchDataInputs,
        );
        return;
      }

      await writeIntentFailure(commitResult.error ?? "intent_commit_failed");
      return;
    }

    const response = await fetch(
      new URL(url, getPatternEnvironment().apiUrl),
      {
        signal: abortSignal,
        ...options,
      },
    );
    observedHttpResponse = true;

    const data = await processResponse(response);
    const sinkLabels = await deriveFetchSinkResultLabels(
      runtime,
      inputsCell,
      inputs,
      { endpoint: cfc?.endpoint },
    );
    await runtime.idle();

    // Try to write result - any tab can write if inputs match
    await tryWriteResult(
      runtime,
      internal,
      inputsCell,
      inputHash,
      (tx) => {
        pending.withTx(tx).set(false);
        result.withTx(tx).set(data);
        error.withTx(tx).set(undefined);
        writeFetchResultLabels(tx, result, sinkLabels);
        writeFetchResultLabels(tx, parentCell, sinkLabels, "/result");
        const publicResultCell = parentCell.getSourceCell();
        if (publicResultCell) {
          writeFetchResultLabels(tx, publicResultCell, sinkLabels, "/result");
        }
      },
      snapshotFetchDataInputs,
    );
  } catch (err) {
    // Don't write errors if request was aborted
    if (abortSignal.aborted) return;

    await runtime.idle();

    const sinkLabels = observedHttpResponse
      ? await deriveFetchSinkResultLabels(
        runtime,
        inputsCell,
        inputs,
        { endpoint: cfc?.endpoint },
      )
      : undefined;

    // Write error - but only update inputHash if inputs haven't changed
    await runtime.editWithRetry((tx) => {
      const currentHash = computeInputHashFromValue(
        snapshotFetchDataInputs(inputsCell.withTx(tx)),
      );

      // Always clear pending and result
      pending.withTx(tx).set(false);
      result.withTx(tx).set(undefined);

      // Only write error and inputHash if inputs still match
      if (currentHash === inputHash) {
        error.withTx(tx).set(err);
        internal.withTx(tx).update({ inputHash });
        writeFetchResultLabels(tx, error, sinkLabels);
        writeFetchResultLabels(tx, parentCell, sinkLabels, "/error");
        const publicResultCell = parentCell.getSourceCell();
        if (publicResultCell) {
          writeFetchResultLabels(tx, publicResultCell, sinkLabels, "/error");
        }
      }
    });
  }
}
