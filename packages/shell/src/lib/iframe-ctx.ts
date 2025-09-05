import {
  type CommonIframeSandboxElement,
  Context,
  IPC,
  Receipt,
  setIframeContextHandler,
} from "@commontools/iframe-sandbox";
import {
  Action,
  type IExtendedStorageTransaction,
  isCell,
  type Runtime,
} from "@commontools/runner";
import { isObject, isRecord } from "@commontools/utils/types";

// Helper to prepare Proxy objects for serialization across frame boundaries
const removeNonJsonData = (proxy: unknown) => {
  return proxy == undefined ? undefined : JSON.parse(JSON.stringify(proxy));
};

// Track previous values to avoid unnecessary updates
const previousValues = new Map<unknown, Map<string, unknown>>();

function getPreviousValue(context: Context, key: string) {
  return previousValues.get(context)?.get(key);
}

function setPreviousValue(context: Context, key: string, value: unknown) {
  if (!previousValues.has(context)) {
    previousValues.set(context, new Map());
  }
  previousValues.get(context)!.set(key, value);
}

export const setupIframe = (runtime: Runtime) =>
  setIframeContextHandler({
    read(
      _element: CommonIframeSandboxElement,
      context: Context,
      key: string,
    ): unknown {
      const data = key === "*"
        ? isCell(context) ? context.get() : context
        : isCell(context)
        ? context.key(key).get?.()
        : isRecord(context)
        ? context?.[key]
        : undefined;
      const serialized = removeNonJsonData(data);
      setPreviousValue(context, key, JSON.stringify(serialized));
      return serialized;
    },

    write(
      _element: CommonIframeSandboxElement,
      context: Context,
      key: string,
      value: unknown,
    ) {
      setPreviousValue(context, key, JSON.stringify(value));

      if (isCell(context)) {
        const currentValue = context.key(key).get();
        const currentValueType = currentValue !== undefined
          ? Array.isArray(currentValue) ? "array" : typeof currentValue
          : undefined;
        const type = context.key(key).schema?.type ??
          currentValueType ?? typeof value;

        if (type === "object" && isObject(value)) {
          context.key(key).update(value);
        } else if (
          (type === "array" && Array.isArray(value)) ||
          (type === "integer" && typeof value === "number") ||
          (type === typeof value as string)
        ) {
          const tx = context.runtime.edit();
          context.withTx(tx).key(key).set(value);
          // No retry, since if there is a conflict, the iframe will by the time
          // this promise resolves have already gotten the base-line truth (In
          // other words: It's correct to ignore this edit)
          tx.commit();
        } else {
          console.warn(
            "write skipped due to type",
            type,
            value,
            context.key(key).schema,
          );
        }
      } else if (isRecord(context)) {
        context[key] = value;
      } else {
        throw new Error("Unknown context.");
      }
    },

    subscribe(
      _element: CommonIframeSandboxElement,
      context: Context,
      key: string,
      callback: (key: string, value: unknown) => void,
      doNotSendMyDataBack: boolean,
    ): Receipt {
      const action: Action = (tx: IExtendedStorageTransaction) => {
        const data = key === "*"
          ? (isCell(context) ? context.get() : context)
          : (isCell(context)
            ? context.withTx(tx).key(key).get?.()
            : isRecord(context)
            ? context?.[key]
            : undefined);
        const serialized = removeNonJsonData(data);
        const serializedString = JSON.stringify(serialized);
        const previousValue = getPreviousValue(context, key);

        if (serializedString !== previousValue || !doNotSendMyDataBack) {
          setPreviousValue(context, key, serializedString);
          callback(key, serialized);
        }

        // Remove * support after first call (legacy compatibility)
        if (key === "*") {
          runtime.idle().then(() => runtime.scheduler.unsubscribe(action));
        }
      };

      // Schedule the action with appropriate reactivity log
      const reads = isCell(context) ? [context.getAsNormalizedFullLink()] : [];
      const cancel = runtime.scheduler.subscribe(
        action,
        { reads, writes: [] },
        true,
      );
      return { action, cancel };
    },

    unsubscribe(
      _element: CommonIframeSandboxElement,
      _context: Context,
      receipt: Receipt,
    ) {
      // Handle both old format (direct action) and new format ({ action, cancel })
      if (
        receipt && typeof receipt === "object" && "cancel" in receipt &&
        typeof receipt.cancel === "function"
      ) {
        receipt.cancel();
      } else {
        // Fallback for direct action
        if (typeof receipt === "function") {
          runtime.scheduler.unsubscribe(receipt as Action);
        } else {
          throw new Error("Invalid receipt.");
        }
      }
    },

    // Simplified handlers - not implementing LLM and webpage reading for now
    onLLMRequest(
      _element: CommonIframeSandboxElement,
      _context: Context,
      _payload: string,
    ): Promise<object> {
      console.warn("LLM requests not yet implemented in shell");
      return Promise.resolve({ error: "LLM requests not yet implemented" });
    },

    onReadWebpageRequest(
      _element: CommonIframeSandboxElement,
      _context: Context,
      _payload: string,
    ): Promise<object> {
      console.warn("Webpage reading not yet implemented in shell");
      return Promise.resolve({ error: "Webpage reading not yet implemented" });
    },

    onPerform(
      _element: CommonIframeSandboxElement,
      _context: unknown,
      command: IPC.TaskPerform,
    ): Promise<{ ok: object; error?: void } | { ok?: void; error: Error }> {
      console.warn("Perform commands not yet implemented in shell");
      return Promise.resolve({
        error: new Error(`Command is not implemented`),
      });
    },
  });
