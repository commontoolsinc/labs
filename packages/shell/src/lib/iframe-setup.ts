import {
  type CommonIframeSandboxElement,
  IPC,
  setIframeContextHandler,
} from "@commontools/iframe-sandbox";
import {
  Action,
  addCommonIDfromObjectID,
  type IExtendedStorageTransaction,
  isCell,
  type Runtime,
} from "@commontools/runner";
import { isObject } from "@commontools/utils/types";

// Prepare Proxy objects to be serialized before sending between frame boundaries
const removeNonJsonData = (proxy: any) => {
  return proxy == undefined ? undefined : JSON.parse(JSON.stringify(proxy));
};

// Type for tracking write operations per context+key
type TimeoutId = ReturnType<typeof setTimeout>;
type WriteTracking = {
  pendingTimeout: TimeoutId | null;
  pendingCallback: (() => void) | null;
  writeCount: number;
  lastResetTime: number;
  lastWriteTime: number;
  lastProcessTime: number;
};

// Map to store write tracking by context and key
const writeTrackers = new Map<any, Map<string, WriteTracking>>();

// Configuration
const MAX_IMMEDIATE_WRITES_PER_SECOND = 20;
const THROTTLED_WRITE_INTERVAL_MS = 100;
const MAX_WRITE_DELAY_MS = 10000;

// Throttle function that handles write rate limiting
function throttle(context: any, key: string, callback: () => void): void {
  if (!writeTrackers.has(context)) {
    writeTrackers.set(context, new Map());
  }
  const contextMap = writeTrackers.get(context)!;

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

  const adaptiveResetTime = Math.max(
    1000,
    Math.min(tracking.lastProcessTime * 10, MAX_WRITE_DELAY_MS),
  );

  if (now - tracking.lastResetTime > adaptiveResetTime) {
    tracking.writeCount = 0;
    tracking.lastResetTime = now;

    if (tracking.pendingTimeout) {
      clearTimeout(tracking.pendingTimeout);
      tracking.pendingTimeout = null;
    }
  }

  const forceWrite = timeSinceLastWrite >= MAX_WRITE_DELAY_MS;
  const slowProcessing = tracking.lastProcessTime > THROTTLED_WRITE_INTERVAL_MS / 3;

  if ((tracking.writeCount < MAX_IMMEDIATE_WRITES_PER_SECOND && !slowProcessing) || forceWrite) {
    tracking.writeCount++;
    const startTime = performance.now();
    callback();
    tracking.lastWriteTime = now;
    tracking.lastProcessTime = performance.now() - startTime;
  } else {
    tracking.pendingCallback = callback;

    if (!tracking.pendingTimeout) {
      const throttleInterval = Math.max(
        THROTTLED_WRITE_INTERVAL_MS,
        Math.min(tracking.lastProcessTime * 3, MAX_WRITE_DELAY_MS),
      );

      tracking.pendingTimeout = setTimeout(() => {
        const startTime = performance.now();
        tracking.pendingCallback?.();
        tracking.lastWriteTime = Date.now();
        tracking.lastProcessTime = performance.now() - startTime;
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

export const setupIframe = (runtime: Runtime) =>
  setIframeContextHandler({
    read(_element: CommonIframeSandboxElement, context: any, key: string): any {
      const data = key === "*"
        ? isCell(context) ? context.get() : context
        : isCell(context)
        ? context.key(key).get?.()
        : context?.[key];
      const serialized = removeNonJsonData(data);
      setPreviousValue(context, key, JSON.stringify(serialized));
      return serialized;
    },

    write(
      _element: CommonIframeSandboxElement,
      context: any,
      key: string,
      value: any,
    ) {
      setPreviousValue(context, key, JSON.stringify(value));
      throttle(context, key, () => {
        if (isCell(context)) {
          addCommonIDfromObjectID(value);
          const currentValue = context.key(key).get();
          const currentValueType = currentValue !== undefined
            ? Array.isArray(currentValue) ? "array" : typeof currentValue
            : undefined;
          const type = context.key(key).schema?.type ??
            currentValueType ?? typeof value;
          if (type === "object" && isObject(value)) {
            const tx = context.runtime.edit();
            context.withTx(tx).key(key).update(value);
            tx.commit();
          } else if (
            (type === "array" && Array.isArray(value)) ||
            (type === "integer" && typeof value === "number") ||
            (type === typeof value as string)
          ) {
            const tx = context.runtime.edit();
            context.withTx(tx).key(key).set(value);
            tx.commit();
          } else {
            console.warn(
              "write skipped due to type",
              type,
              value,
              context.key(key).schema,
            );
          }
        } else {
          context[key] = value;
        }
      });
    },

    subscribe(
      _element: CommonIframeSandboxElement,
      context: any,
      key: string,
      callback: (key: string, value: any) => void,
      doNotSendMyDataBack: boolean,
    ): any {
      const action: Action = (tx: IExtendedStorageTransaction) => {
        const data = key === "*"
          ? (isCell(context) ? context.get() : context)
          : (isCell(context)
            ? context.withTx(tx).key(key).get?.()
            : context?.[key]);
        const serialized = removeNonJsonData(data);
        const serializedString = JSON.stringify(serialized);
        const previousValue = getPreviousValue(context, key);
        if (serializedString !== previousValue || !doNotSendMyDataBack) {
          setPreviousValue(context, key, serializedString);
          callback(key, serialized);
        }

        // HACK: Remove * support after first call
        if (key === "*") {
          runtime.idle().then(() => runtime.scheduler.unschedule(action));
        }
      };

      const reads = isCell(context) ? [context.getAsNormalizedFullLink()] : [];
      const cancel = runtime.scheduler.schedule(action, { reads, writes: [] });
      return { action, cancel };
    },

    unsubscribe(
      _element: CommonIframeSandboxElement,
      _context: any,
      receipt: any,
    ) {
      if (receipt && typeof receipt === "object" && receipt.cancel) {
        receipt.cancel();
      } else {
        runtime.scheduler.unschedule(receipt);
      }
    },

    // Simplified LLM and webpage reading support - can be enhanced later
    async onLLMRequest(
      _element: CommonIframeSandboxElement,
      _context: any,
      _payload: string,
    ): Promise<object> {
      console.warn("LLM requests not yet implemented in shell iframe context");
      return { error: "LLM requests not yet implemented" };
    },

    async onReadWebpageRequest(
      _element: CommonIframeSandboxElement,
      _context: any,
      _payload: string,
    ): Promise<object> {
      console.warn("Webpage reading not yet implemented in shell iframe context");
      return { error: "Webpage reading not yet implemented" };
    },

    async onPerform(
      _element: CommonIframeSandboxElement,
      _context: unknown,
      _command: IPC.TaskPerform,
    ): Promise<{ ok: object; error?: void } | { ok?: void; error: Error }> {
      return { error: new Error("Command is not implemented") };
    },
  });