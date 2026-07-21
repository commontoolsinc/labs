import { type Cell } from "../cell.ts";
import { type Action } from "../scheduler.ts";
import type { Runtime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import type { CellScope } from "../builder/types.ts";
import { internSchema } from "@commonfabric/data-model/schema-hash";
import { hashOf } from "@commonfabric/data-model/value-hash";
import { createFrozenRequestSnapshot } from "../cfc/request-snapshot.ts";
import { enqueueSinkRequestPostCommitEffect } from "../cfc/sink-request.ts";
import { setPatternCell, setResultCell } from "../result-utils.ts";
import { scopedCell } from "./scope-policy.ts";
import type { JSONSchema } from "@commonfabric/api";
import { validateSchemaValue } from "../cfc/schema-sanitization.ts";
import { DataUnavailable } from "@commonfabric/data-model/fabric-instances";
import { selectUnavailableInput } from "../data-unavailability.ts";

/**
 * Stream data from a URL, used for querying Synopsys.
 * Ben: This is a hack for demo purposes, we should feel free to delete this file when we have a robust integration.
 *
 * This differs from a regular fetch in that we poll in a generator loop to get all the data.
 *
 * Returns the streamed result as `result`. `pending` is true while a request is pending.
 *
 * @param url - A doc containing the URL to stream data from.
 * @returns { pending: boolean, result: any, error: any } - As individual docs, representing `pending` state, streamed `result`, and any `error`.
 */
export function streamData(
  inputsCell: Cell<StreamDataInputs>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  addCancel: (cancel: () => void) => void,
  cause: Cell<any>[],
  parentCell: Cell<any>,
  runtime: Runtime,
): Action {
  return createStreamDataAction(
    "legacy",
    inputsCell,
    sendResult,
    addCancel,
    cause,
    parentCell,
    runtime,
  );
}

/** Direct-final stream contract used by newly compiled graphs. */
export function streamDataResult(
  inputsCell: Cell<StreamDataInputs>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  addCancel: (cancel: () => void) => void,
  cause: Cell<any>[],
  parentCell: Cell<any>,
  runtime: Runtime,
): Action {
  return createStreamDataAction(
    "availability",
    inputsCell,
    sendResult,
    addCancel,
    cause,
    parentCell,
    runtime,
  );
}

function createStreamDataAction(
  contract: "legacy" | "availability",
  inputsCell: Cell<StreamDataInputs>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  addCancel: (cancel: () => void) => void,
  cause: Cell<any>[],
  parentCell: Cell<any>,
  runtime: Runtime,
): Action {
  const status = { run: 0, controller: undefined } as {
    run: number;
    controller: AbortController | undefined;
  };

  let previousCall = "";
  let startAttempt = 0;
  let cellsInitialized = false;
  let pending: Cell<boolean>;
  let result: Cell<any | undefined>;
  let partial: Cell<any | undefined> | undefined;
  let error: Cell<any | undefined>;
  let cellScope: CellScope | undefined;

  addCancel(() => {
    ++status.run;
    status.controller?.abort();
    status.controller = undefined;
  });

  return (tx: IExtendedStorageTransaction) => {
    tx.resetNarrowestReadScope();
    const inputWithLog = inputsCell.withTx(tx);
    const unavailableInput = contract === "availability"
      ? selectUnavailableInput(inputWithLog.getRaw(), {
        runtime,
        tx,
        base: inputsCell,
      })
      : undefined;
    const requestSnapshot = unavailableInput === undefined
      ? snapshotStreamDataInputs(inputWithLog)
      : undefined;
    const outputScope = tx.getNarrowestReadScope();

    if (!cellsInitialized || cellScope !== outputScope) {
      if (cellsInitialized && cellScope !== outputScope) {
        previousCall = "";
      }
      const namespace = contract === "legacy"
        ? "streamData"
        : "streamDataResult";
      const basePending = runtime.getCell<boolean>(
        parentCell.space,
        { [namespace]: { pending: cause } },
        undefined,
        tx,
      );
      pending = scopedCell(runtime, tx, basePending, outputScope);
      pending.send(false);

      const baseResult = runtime.getCell<any | undefined>(
        parentCell.space,
        { [namespace]: { result: cause } },
        undefined,
        tx,
      );
      result = scopedCell(runtime, tx, baseResult, outputScope);

      if (contract === "availability") {
        const basePartial = runtime.getCell<any | undefined>(
          parentCell.space,
          { [namespace]: { partial: cause } },
          undefined,
          tx,
        );
        partial = scopedCell(runtime, tx, basePartial, outputScope);
      }

      const baseError = runtime.getCell<any | undefined>(
        parentCell.space,
        { [namespace]: { error: cause } },
        undefined,
        tx,
      );
      error = scopedCell(runtime, tx, baseError, outputScope);

      // Link the new result cells to the parent result cell
      setResultCell(pending, parentCell);
      setResultCell(result, parentCell);
      if (partial) setResultCell(partial, parentCell);
      setResultCell(error, parentCell);
      // Link the new result cells to the pattern cell too
      const patternCellPtr = parentCell.key("pattern");
      setPatternCell(pending, patternCellPtr);
      setPatternCell(result, patternCellPtr);
      if (partial) setPatternCell(partial, patternCellPtr);
      setPatternCell(error, patternCellPtr);

      // Since we'll only write into the docs above, we only have to call this once
      // here, instead of in the action.
      sendResult(
        tx,
        contract === "availability"
          ? { pending, result, partial, error }
          : { pending, result, error },
      );
      cellsInitialized = true;
      cellScope = outputScope;
    }
    const pendingWithLog = pending.withTx(tx);
    const resultWithLog = result.withTx(tx);
    const partialWithLog = partial?.withTx(tx);
    const errorWithLog = error.withTx(tx);

    if (unavailableInput !== undefined) {
      previousCall = "";
      if (status.controller) {
        status.controller.abort("Inputs unavailable");
        status.controller = undefined;
      }
      ++status.run;
      pendingWithLog.set(
        unavailableInput.reason === "pending" ||
          unavailableInput.reason === "syncing",
      );
      resultWithLog.setRaw(unavailableInput);
      partialWithLog!.setRaw(unavailableInput);
      errorWithLog.set(
        unavailableInput.reason === "error"
          ? unavailableInput.error.message
          : undefined,
      );
      return;
    }

    // Unavailable inputs return above, so the request is materialized here.
    const materializedRequest = requestSnapshot!;
    const { url, options, schema } = materializedRequest;

    const requestId = hashOf(materializedRequest).toString();
    // Re-entrancy guard: Don't restart the stream if the entire canonical
    // request, including its event schema, is unchanged.
    const currentCall = requestId;
    if (currentCall === previousCall) return;
    const previousCallBeforeAttempt = previousCall;
    const thisAttempt = ++startAttempt;
    previousCall = currentCall;
    tx.addCommitCallback((_committedTx, commitResult) => {
      if (
        commitResult.error &&
        startAttempt === thisAttempt &&
        previousCall === currentCall
      ) {
        previousCall = previousCallBeforeAttempt;
      }
    });

    if (status.controller) {
      status.controller.abort();
      status.controller = undefined;
    }

    if (url === undefined) {
      pendingWithLog.set(false);
      if (contract === "availability") {
        resultWithLog.setRaw(DataUnavailable.schemaMismatch());
        partialWithLog!.setRaw(DataUnavailable.schemaMismatch());
      } else {
        resultWithLog.set(undefined);
      }
      errorWithLog.set(undefined);
      ++status.run;
      return;
    }

    pendingWithLog.set(true);
    if (contract === "availability") {
      resultWithLog.setRaw(DataUnavailable.pending());
      partialWithLog!.setRaw(DataUnavailable.pending());
    } else {
      resultWithLog.set(undefined);
    }
    errorWithLog.set(undefined);

    const thisRun = ++status.run;
    const effectNamespace = contract === "legacy"
      ? "streamData"
      : "streamDataResult";

    enqueueSinkRequestPostCommitEffect(
      tx,
      effectNamespace,
      `${effectNamespace}:${requestId}`,
      materializedRequest,
      `${effectNamespace}-start`,
      () => {
        if (thisRun !== status.run) {
          return;
        }

        const controller = new AbortController();
        const signal = controller.signal;
        status.controller = controller;

        fetch(url, { ...options, signal })
          .then(async (response) => {
            if (!response.ok) {
              throw new Error(
                `Stream request failed: ${response.status} ${response.statusText}`,
              );
            }
            const reader = response.body?.getReader();
            const utf8 = new TextDecoder();

            if (!reader) {
              throw new Error("Response body is not readable");
            }

            const decoder = createSseEventDecoder();
            let lastEvent: unknown;

            while (true) {
              if (thisRun !== status.run) {
                controller.abort();
                return;
              }

              const { done, value } = await reader.read();
              const text = value ? utf8.decode(value, { stream: !done }) : "";
              const decoded = decoder.push(
                done ? text + utf8.decode() : text,
                done,
              );

              for (const parsedData of decoded) {
                if (schema !== undefined) {
                  const failure = validateSchemaValue(schema, parsedData);
                  if (failure) {
                    throw new StreamDataSchemaMismatchError(failure);
                  }
                }
                lastEvent = parsedData;
                await runtime.idle();
                await runtime.editWithRetry((tx) => {
                  if (thisRun !== status.run) return;
                  if (contract === "availability") {
                    partial!.withTx(tx).set(parsedData);
                  } else {
                    result.withTx(tx).set(parsedData);
                  }
                });
              }

              if (done) {
                if (contract === "availability") {
                  if (lastEvent === undefined) {
                    throw new Error("Stream closed before emitting an event");
                  }
                  await runtime.editWithRetry((tx) => {
                    if (thisRun !== status.run) return;
                    pending.withTx(tx).set(false);
                    result.withTx(tx).set(lastEvent);
                    error.withTx(tx).set(undefined);
                  });
                }
                if (thisRun === status.run) status.controller = undefined;
                break;
              }
            }
          })
          .catch(async (e) => {
            if (e instanceof DOMException && e.name === "AbortError") {
              return;
            }
            // The legacy contract clears its raw result. The availability
            // contract publishes a terminal marker; callers that need visual
            // continuity can retain its partial result with latestComplete().
            console.error(e);

            await runtime.idle();

            await runtime.editWithRetry((tx) => {
              if (thisRun !== status.run) return;
              pending.withTx(tx).set(false);
              if (contract === "availability") {
                const unavailable = e instanceof StreamDataSchemaMismatchError
                  ? DataUnavailable.schemaMismatch()
                  : DataUnavailable.error(
                    e instanceof Error ? e : new Error(String(e)),
                  );
                result.withTx(tx).setRaw(unavailable);
                partial!.withTx(tx).setRaw(unavailable);
              } else {
                result.withTx(tx).set(undefined);
              }
              error.withTx(tx).set(e);
            });

            if (contract === "legacy") {
              // Preserve the old raw state's retry behavior.
              previousCall = "";
            }
            if (thisRun === status.run) status.controller = undefined;
          });
      },
    );
  };
}

class StreamDataSchemaMismatchError extends Error {}

function createSseEventDecoder(): {
  push(text: string, flush: boolean): unknown[];
} {
  let buffer = "";
  let id: string | undefined;
  let event: string | undefined;
  let data: string[] = [];

  const finishEvent = (): unknown | undefined => {
    if (id === undefined && event === undefined && data.length === 0) {
      return undefined;
    }
    if (id === undefined || event === undefined || data.length === 0) {
      throw new Error("Incomplete server-sent event");
    }
    const value = { id, event, data: JSON.parse(data.join("\n")) };
    id = undefined;
    event = undefined;
    data = [];
    return value;
  };

  const consumeLine = (line: string): unknown | undefined => {
    if (line === "") return finishEvent();
    if (line.startsWith("id:")) id = line.slice(3).trimStart();
    else if (line.startsWith("event:")) event = line.slice(6).trimStart();
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    return undefined;
  };

  return {
    push(text: string, flush: boolean): unknown[] {
      buffer += text;
      const values: unknown[] = [];
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        const value = consumeLine(line);
        if (value !== undefined) values.push(value);
      }
      if (flush) {
        if (buffer.length > 0) {
          const value = consumeLine(buffer.replace(/\r$/, ""));
          if (value !== undefined) values.push(value);
          buffer = "";
        }
        const value = finishEvent();
        if (value !== undefined) values.push(value);
      }
      return values;
    },
  };
}

type StreamDataInputs = {
  url?: string;
  schema?: JSONSchema;
  options?: { body?: any; method?: string; headers?: Record<string, string> };
};

const streamDataInputSchema = internSchema(
  {
    type: "object",
    properties: {
      url: { type: "string" },
      schema: true,
      options: {
        type: "object",
        properties: {
          body: {},
          method: { type: "string" },
          headers: {
            type: "object",
            additionalProperties: { type: "string" },
          },
        },
      },
    },
  },
);

function snapshotStreamDataInputs(
  cell: Cell<StreamDataInputs>,
): StreamDataInputs {
  const snapshot = cell.asSchema(streamDataInputSchema).get() ??
    ({} as StreamDataInputs);
  const body = snapshot.options?.body;
  if (!snapshot.options) {
    return createFrozenRequestSnapshot({
      url: snapshot.url,
      ...(snapshot.schema !== undefined && { schema: snapshot.schema }),
    });
  }
  const options = {
    ...snapshot.options,
    body: body !== undefined && typeof body !== "string"
      ? JSON.stringify(body)
      : body,
  };
  return createFrozenRequestSnapshot({
    url: snapshot.url,
    ...(snapshot.schema !== undefined && { schema: snapshot.schema }),
    options,
  });
}
