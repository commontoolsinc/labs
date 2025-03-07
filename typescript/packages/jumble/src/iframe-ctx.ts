import { setIframeContextHandler } from "@commontools/iframe-sandbox";
import {
  Action,
  addAction,
  isCell,
  ReactivityLog,
  removeAction,
} from "@commontools/runner";
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
  pendingValue: any; // Store the value to be written when timeout fires
  writeCount: number;
  lastResetTime: number;
};

// Map to store write tracking by context and key
const writeTrackers = new Map<any, Map<string, WriteTracking>>();

// Configuration
const MAX_IMMEDIATE_WRITES_PER_SECOND = 20; // Allow 20 immediate writes per second
const THROTTLED_WRITE_INTERVAL_MS = 100; // 0.1s interval after threshold

export const setupIframe = () =>
  setIframeContextHandler({
    read(context: any, key: string): any {
      const data = isCell(context) ? context.key(key).get() : context?.[key];
      const serialized = serializeProxyObjects(data);
      return serialized;
    },
    write(context: any, key: string, value: any) {
      // Get or create context map for this specific context+key
      if (!writeTrackers.has(context)) {
        writeTrackers.set(context, new Map());
      }
      const contextMap = writeTrackers.get(context)!;

      // Get or initialize tracking info for this key
      if (!contextMap.has(key)) {
        contextMap.set(key, {
          pendingTimeout: null,
          pendingValue: undefined,
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

        // Perform write immediately
        if (isCell(context)) {
          context.key(key).setRaw(value);
        } else {
          context[key] = value;
        }
      } // Otherwise, use debouncing
      else {
        // Update the value to be written when the timeout fires
        tracking.pendingValue = value;

        // Only set a new timeout if there isn't one already
        if (!tracking.pendingTimeout) {
          tracking.pendingTimeout = setTimeout(() => {
            // Perform the actual write operation with the latest value
            if (isCell(context)) {
              context.key(key).setRaw(tracking.pendingValue);
            } else {
              context[key] = tracking.pendingValue;
            }

            // Clear the timeout reference
            tracking.pendingTimeout = null;
          }, THROTTLED_WRITE_INTERVAL_MS);
        }
      }
    },
    subscribe(
      context: any,
      key: string,
      callback: (key: string, value: any) => void,
    ): any {
      const action: Action = (log: ReactivityLog) => {
        const data = isCell(context)
          ? context.withLog(log).key(key).get()
          : context?.[key];
        const serialized = serializeProxyObjects(data);
        callback(key, serialized);
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
  });
