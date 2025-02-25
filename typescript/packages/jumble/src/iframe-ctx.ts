import { setIframeContextHandler } from "@commontools/iframe-sandbox";
import { Action, ReactivityLog, addAction, removeAction } from "@commontools/runner";
import { llm } from "@/utils/llm.ts";

// FIXME(ja): perhaps this could be in common-charm?  needed to enable iframe with sandboxing
// This is to prepare Proxy objects to be serialized
// before sent between frame boundaries via structured clone algorithm.
// There should be a more efficient generalized method for doing
// so instead of an extra JSON parse/stringify cycle.
const serializeProxyObjects = (proxy: any) => {
  return proxy == undefined ? undefined : JSON.parse(JSON.stringify(proxy));
};

export const setupIframe = () =>
  setIframeContextHandler({
    read(context: any, key: string): any {
      const data = context?.getAsQueryResult ? context?.getAsQueryResult([key]) : context?.[key];
      const serialized = serializeProxyObjects(data);
      return serialized;
    },
    write(context: any, key: string, value: any) {
      context.getAsQueryResult()[key] = value;
    },
    subscribe(context: any, key: string, callback: (key: string, value: any) => void): any {
      const action: Action = (log: ReactivityLog) => {
        const data = context.getAsQueryResult([key], log);
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
        jsonPayload.model = ["groq:llama-3.3-70b-versatile", "anthropic:claude-3-7-sonnet-latest"];
      }

      const res = await llm.sendRequest(jsonPayload);
      console.log("onLLMRequest res", res);
      return res as any;
    },
  });
