// This is all you need to import/register the @commontools/ui web components
import "@commontools/ui";
import { setIframeContextHandler } from "@commontools/iframe-sandbox";
import { Action, ReactivityLog, addAction, removeAction } from "@commontools/runner";
import { WebComponent } from "@/components/WebComponent";
import { useCallback } from "react";

import * as osUi from "@commontools/os-ui";
// bf: load bearing console.log
console.log("initializing os-ui", osUi);

import "@commontools/os-ui/src/static/main.css";
import "./main.css";
import { Routes, Route, useMatch } from "react-router-dom";
import CharmDetail from "./CharmDetail";
import CharmList from "./CharmList";
import { LLMClient } from "@commontools/llm-client";
import { NavPath } from "@/components/NavPath";
import { CommandCenter } from "@/components/CommandCenter";

// FIXME(ja): perhaps this could be in common-charm?  needed to enable iframe with sandboxing
// This is to prepare Proxy objects to be serialized
// before sent between frame boundaries via structured clone algorithm.
// There should be a more efficient generalized method for doing
// so instead of an extra JSON parse/stringify cycle.
const serializeProxyObjects = (proxy: any) => {
  return proxy == undefined ? undefined : JSON.parse(JSON.stringify(proxy));
};

const llmUrl =
  typeof window !== "undefined"
    ? window.location.protocol + "//" + window.location.host + "/api/ai/llm"
    : "//api/ai/llm";

const llm = new LLMClient(llmUrl);

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
      jsonPayload.model = ["groq:llama-3.3-70b-specdec", "anthropic:claude-3-5-sonnet-latest"];
    }

    const res = await llm.sendRequest(jsonPayload);
    console.log("onLLMRequest res", res);
    return res as any;
  },
});

export default function Shell() {
  const match = useMatch("/:replicaName/:charmId?");
  const focusedCharmId = match?.params.charmId ?? null;
  const focusedReplicaId = match?.params.replicaName ?? null;

  const onLaunchCommand = useCallback(() => {
    window.dispatchEvent(new CustomEvent("open-command-center"));
  }, []);

  return (
    <div className="h-full relative">
      <WebComponent as={"os-chrome"}>
        <div slot="toolbar-start">
          {focusedReplicaId && <NavPath replicaId={focusedReplicaId} charmId={focusedCharmId} />}
        </div>

        <div className="relative h-full">
          <Routes>
            <Route path="/:charmId" element={<CharmDetail />} />
            <Route index element={<CharmList />} />
          </Routes>
        </div>
      </WebComponent>

      <WebComponent
        slot="overlay"
        as="os-icon-button"
        icon="star"
        size="lg"
        className="pin-br"
        onClick={onLaunchCommand}
      />
      <CommandCenter />
    </div>
  );
}
