import { setIframeContextHandler } from "@commontools/iframe-sandbox";
import {
  Action,
  addAction,
  addCommonIDfromObjectID,
  isCell,
  ReactivityLog,
  removeAction,
} from "@commontools/runner";
import { client as llm } from "@commontools/llm";

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
};

// Map to store write tracking by context and key
const writeTrackers = new Map<any, Map<string, WriteTracking>>();

// Configuration
const MAX_IMMEDIATE_WRITES_PER_SECOND = 20; // Allow 20 immediate writes per second
const THROTTLED_WRITE_INTERVAL_MS = 100; // 0.1s interval after threshold

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
    });
  }

  const tracking = contextMap.get(key)!;
  const now = Date.now();

  // Reset counter if a second has passed
  if (now - tracking.lastResetTime > 1000) {
    tracking.writeCount = 0;
    tracking.lastResetTime = now;
    if (tracking.pendingTimeout) {
      clearTimeout(tracking.pendingTimeout);
      tracking.pendingTimeout = null;
    }
  }

  // If we're under the threshold, process immediately
  if (tracking.writeCount < MAX_IMMEDIATE_WRITES_PER_SECOND) {
    tracking.writeCount++;
    // Execute callback immediately
    callback();
  } else {
    // Update the callback to be executed when the timeout fires
    tracking.pendingCallback = callback;

    // Only set a new timeout if there isn't one already
    if (!tracking.pendingTimeout) {
      tracking.pendingTimeout = setTimeout(() => {
        // Execute the latest callback
        tracking.pendingCallback?.();

        // Clear the timeout reference
        tracking.pendingTimeout = null;
        tracking.pendingCallback = null;
      }, THROTTLED_WRITE_INTERVAL_MS);
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
      const data = isCell(context) ? context.key(key).get?.() : context?.[key];
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
          context.key(key).set(value);
        } else {
          context[key] = value;
        }
      });
    },
    subscribe(
      context: any,
      key: string,
      callback: (key: string, value: any) => void,
    ): any {
      const action: Action = (log: ReactivityLog) => {
        const data = key === "*"
          ? (isCell(context) ? context.withLog(log).get() : context)
          : (isCell(context)
            // get?.() because streams don't have a get, set undefined for those
            ? context.withLog(log).key(key).get?.()
            : context?.[key]);
        const serialized = removeNonJsonData(data);
        const serializedString = JSON.stringify(serialized);
        const previousValue = getPreviousValue(context, key);
        if (serializedString !== previousValue) {
          console.log("subscribe", key, serialized, previousValue);
          setPreviousValue(context, key, serializedString);
          callback(key, serialized);
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
  });
