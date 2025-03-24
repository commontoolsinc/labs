import { IPC, setIframeContextHandler } from "@commontools/iframe-sandbox";
import {
  Action,
  addAction,
  addCommonIDfromObjectID,
  idle,
  isCell,
  ReactivityLog,
  removeAction,
} from "@commontools/runner";
import { client as llm } from "@commontools/llm";
import { isObj } from "@commontools/utils";

// FIXME(ja): perhaps this could be in common-charm?  needed to enable iframe with sandboxing
// This is to prepare Proxy objects to be serialized
// before sent between frame boundaries via structured clone algorithm.
// There should be a more efficient generalized method for doing
// so instead of an extra JSON parse/stringify cycle.
const removeNonJsonData = (proxy: any) => {
  return proxy == undefined ? undefined : JSON.parse(JSON.stringify(proxy));
};

// Type for tracking write operations per context+key
type TimeoutId = ReturnType<typeof setTimeout>;
type WriteTracking = {
  pendingTimeout: TimeoutId | null;
  pendingCallback: (() => void) | null; // Store the callback to execute when timeout fires
  writeCount: number;
  lastResetTime: number;
  lastWriteTime: number; // Time of last successful write
  lastProcessTime: number; // Time taken to process the last write
};

// Map to store write tracking by context and key
const writeTrackers = new Map<any, Map<string, WriteTracking>>();

// Configuration
const MAX_IMMEDIATE_WRITES_PER_SECOND = 20; // Allow 20 immediate writes per second
const THROTTLED_WRITE_INTERVAL_MS = 100; // 0.1s interval after threshold
const MAX_WRITE_DELAY_MS = 10000; // Maximum delay between writes (10s)

// Throttle function that handles write rate limiting
function throttle(context: any, key: string, callback: () => void): void {
  // Get or create context map for this specific context
  if (!writeTrackers.has(context)) {
    writeTrackers.set(context, new Map());
  }
  const contextMap = writeTrackers.get(context)!;

  // Get or initialize tracking info for this key
  if (!contextMap.has(key)) {
    contextMap.set(key, {
      pendingTimeout: null,
      pendingCallback: null,
      writeCount: 0,
      lastResetTime: Date.now(),
      lastWriteTime: Date.now(),
      lastProcessTime: 0,
    });
  }

  const tracking = contextMap.get(key)!;
  const now = Date.now();
  const timeSinceLastWrite = now - (tracking.lastWriteTime || now);

  // Calculate adaptive reset time based on processing time
  const adaptiveResetTime = Math.max(
    1000, // At least 1 second
    Math.min(tracking.lastProcessTime * 10, MAX_WRITE_DELAY_MS), // But no more than 10s
  );

  // Reset counter if adaptive time has passed
  if (now - tracking.lastResetTime > adaptiveResetTime) {
    tracking.writeCount = 0;
    tracking.lastResetTime = now;

    // Clear any pending timeout since we're resetting counters
    if (tracking.pendingTimeout) {
      clearTimeout(tracking.pendingTimeout);
      tracking.pendingTimeout = null;
    }
  }

  // Force a write if we haven't written in MAX_WRITE_DELAY_MS
  const forceWrite = timeSinceLastWrite >= MAX_WRITE_DELAY_MS;

  // Check if processing takes too long and should be throttled immediately
  const slowProcessing =
    tracking.lastProcessTime > THROTTLED_WRITE_INTERVAL_MS / 3;

  // Process immediately if:
  // 1. We're under the frequency threshold AND processing isn't slow, OR
  // 2. We need to force a write due to timeout
  if (
    (tracking.writeCount < MAX_IMMEDIATE_WRITES_PER_SECOND &&
      !slowProcessing) || forceWrite
  ) {
    tracking.writeCount++;

    // Measure processing time
    const startTime = performance.now();

    // Execute callback immediately
    callback();

    // Update tracking
    tracking.lastWriteTime = now;
    tracking.lastProcessTime = performance.now() - startTime;
  } else {
    // Update the callback to be executed when the timeout fires
    tracking.pendingCallback = callback;

    // Only set a new timeout if there isn't one already
    if (!tracking.pendingTimeout) {
      // Calculate appropriate throttle interval based on processing time (at least 3x)
      const throttleInterval = Math.max(
        THROTTLED_WRITE_INTERVAL_MS,
        Math.min(tracking.lastProcessTime * 3, MAX_WRITE_DELAY_MS), // Cap at 10 seconds
      );

      console.log("throttling writes", key, throttleInterval);

      tracking.pendingTimeout = setTimeout(() => {
        // Measure processing time
        const startTime = performance.now();

        // Execute the latest callback
        tracking.pendingCallback?.();

        // Update tracking
        tracking.lastWriteTime = Date.now();
        tracking.lastProcessTime = performance.now() - startTime;

        // Clear the timeout reference
        tracking.pendingTimeout = null;
        tracking.pendingCallback = null;
      }, throttleInterval);
    }
  }
}

const previousValues = new Map<any, Map<string, any>>();

function getPreviousValue(context: any, key: string) {
  return previousValues.get(context)?.get(key);
}

function setPreviousValue(context: any, key: string, value: any) {
  if (!previousValues.has(context)) {
    previousValues.set(context, new Map());
  }
  previousValues.get(context)!.set(key, value);
}

export const setupIframe = () =>
  setIframeContextHandler({
    read(context: any, key: string): any {
      const data = key === "*"
        ? isCell(context) ? context.get() : context
        : isCell(context)
        ? context.key(key).get?.()
        : context?.[key];
      const serialized = removeNonJsonData(data);
      console.log("read", key, serialized, JSON.stringify(serialized));
      setPreviousValue(context, key, JSON.stringify(serialized));
      return serialized;
    },
    write(context: any, key: string, value: any) {
      setPreviousValue(context, key, JSON.stringify(value));
      throttle(context, key, () => {
        console.log("write", key, value, JSON.stringify(value));
        if (isCell(context)) {
          addCommonIDfromObjectID(value);
          if (isObj(value) && !Array.isArray(value)) {
            context.key(key).update(value);
          } else {
            context.key(key).set(value);
          }
        } else {
          context[key] = value;
        }
      });
    },
    subscribe(
      context: any,
      key: string,
      callback: (key: string, value: any) => void,
      doNotSendMyDataBack: boolean,
    ): any {
      const action: Action = (log: ReactivityLog) => {
        const data = key === "*"
          // No withLog because we don't want to schedule more runs, see below
          ? (isCell(context) ? context.get() : context)
          : (isCell(context)
            // get?.() because streams don't have a get, set undefined for those
            ? context.withLog(log).key(key).get?.()
            : context?.[key]);
        const serialized = removeNonJsonData(data);
        const serializedString = JSON.stringify(serialized);
        const previousValue = getPreviousValue(context, key);
        if (serializedString !== previousValue || !doNotSendMyDataBack) {
          console.log("subscribe", key, serialized, previousValue);
          setPreviousValue(context, key, serializedString);
          callback(key, serialized);
        }

        // HACK(seefeld): We want to remove * support, but some existing iframes
        // use it to know that data is available. So as a hack, we're
        // unsubscribing from * here after the first time it's called.
        // TODO(seefeld): Remove this and * support2025-04-15 or earlier.
        if (key === "*") {
          // Wait for idle to confuse the scheduler as it updates dependencies
          // after running this function.
          idle().then(() => removeAction(action));
        }
      };

      addAction(action);
      return action;
    },
    unsubscribe(_context: any, receipt: any) {
      removeAction(receipt);
    },
    async onLLMRequest(_context: any, payload: string) {
      console.log("onLLMRequest", payload);
      const jsonPayload = JSON.parse(payload);
      if (!jsonPayload.model) {
        jsonPayload.model = [
          "groq:llama-3.3-70b-versatile",
          "anthropic:claude-3-7-sonnet-latest",
        ];
      }

      const res = await llm.sendRequest(jsonPayload);
      console.log("onLLMRequest res", res);
      return res as any;
    },
    async onReadWebpageRequest(_context: any, payload: string) {
      console.log("onReadWebpageRequest", payload);
      const res = await fetch(
        `/api/ai/webreader/${encodeURIComponent(payload)}`,
      );
      console.log("onReadWebpageRequest res", res);
      return await res.json();
    },
    async onPerform(
      context: unknown,
      command: IPC.TaskPerform,
    ): Promise<{ ok: object; error?: void } | { ok?: void; error: Error }> {
      console.log("perform", command);
      return await { error: new Error(`Command is not implemented`) };
    },
  });
