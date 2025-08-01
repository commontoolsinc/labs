import {
  type CommonIframeSandboxElement,
  IPC,
  setIframeContextHandler,
} from "@commontools/iframe-sandbox";
import {
  Action,
  type IExtendedStorageTransaction,
  isCell,
  type Runtime,
} from "@commontools/runner";
import { isObject } from "@commontools/utils/types";

// Helper to prepare Proxy objects for serialization across frame boundaries
const removeNonJsonData = (proxy: any) => {
  return proxy == undefined ? undefined : JSON.parse(JSON.stringify(proxy));
};

// Track previous values to avoid unnecessary updates
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

        // Remove * support after first call (legacy compatibility)
        if (key === "*") {
          runtime.idle().then(() => runtime.scheduler.unschedule(action));
        }
      };

      // Schedule the action with appropriate reactivity log
      const reads = isCell(context) ? [context.getAsNormalizedFullLink()] : [];
      const cancel = runtime.scheduler.schedule(action, { reads, writes: [] });
      return { action, cancel };
    },
    
    unsubscribe(
      _element: CommonIframeSandboxElement,
      _context: any,
      receipt: any,
    ) {
      // Handle both old format (direct action) and new format ({ action, cancel })
      if (receipt && typeof receipt === "object" && receipt.cancel) {
        receipt.cancel();
      } else {
        // Fallback for direct action
        runtime.scheduler.unschedule(receipt);
      }
    },
    
    // Simplified handlers - not implementing LLM and webpage reading for now
    onLLMRequest(
      _element: CommonIframeSandboxElement,
      _context: any,
      _payload: string,
    ): Promise<object> {
      console.warn("LLM requests not yet implemented in shell");
      return Promise.resolve({ error: "LLM requests not yet implemented" });
    },
    
    onReadWebpageRequest(
      _element: CommonIframeSandboxElement,
      _context: any,
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
      return Promise.resolve({ error: new Error(`Command is not implemented`) });
    },
  });