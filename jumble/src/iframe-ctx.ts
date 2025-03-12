import { setIframeContextHandler } from "@commontools/iframe-sandbox";
import {
  Action,
  addAction,
  isCell,
  ReactivityLog,
  removeAction,
} from "@commontools/runner";
import { ID } from "@commontools/builder";
import { llm } from "@/utils/llm.ts";

// FIXME(ja): perhaps this could be in common-charm?  needed to enable iframe with sandboxing
// This is to prepare Proxy objects to be serialized
// before sent between frame boundaries via structured clone algorithm.
// There should be a more efficient generalized method for doing
// so instead of an extra JSON parse/stringify cycle.
const serializeProxyObjects = (proxy: any) => {
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

/**
 * Translates `id` that React likes to create to our `ID` property, making sure
 * in any given object it is never used twice.
 *
 * This mostly makes sense in a context where we ship entire JSON documents back
 * and forth and can't express graphs, i.e. two places referring to the same
 * underlying entity.
 *
 * We'll want to revisit once iframes become more sophisticated in what they can
 * express, e.g. we could have the inner shim do some of this work instead.
 */
function addCommonIDfromObjectID(obj: any) {
  function traverse(obj: any) {
    if (typeof obj == "object" && obj !== null) {
      const seen = new Set();
      Object.keys(obj).forEach((key: string) => {
        if (
          typeof obj[key] == "object" && obj[key] !== null && "id" in obj[key]
        ) {
          let n = 0;
          let id = obj[key].id;
          while (seen.has(id)) id = `${obj[key].id}-${++n}`;
          seen.add(id);
          obj[key][ID] = id;
        }
        traverse(obj[key]);
      });
    }
  }

  if ("id" in obj) obj[ID] = obj.id;
  traverse(obj);
}

export const setupIframe = () =>
  setIframeContextHandler({
    read(context: any, key: string): any {
      const data = isCell(context) ? context.key(key).get?.() : context?.[key];
      const serialized = serializeProxyObjects(data);
      return serialized;
    },
    write(context: any, key: string, value: any) {
      throttle(context, key, () => {
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
      let previousValue: any;

      const action: Action = (log: ReactivityLog) => {
        const data = key === "*"
          ? (isCell(context) ? context.withLog(log).get() : context)
          : (isCell(context)
            // get?.() because streams don't have a get, set undefined for those
            ? context.withLog(log).key(key).get?.()
            : context?.[key]);
        const serialized = serializeProxyObjects(data);
        if (serialized !== previousValue) {
          previousValue = serialized;
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
