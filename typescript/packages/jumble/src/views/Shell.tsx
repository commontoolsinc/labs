import "@commontools/ui";
import { useCallback } from "react";
import { NavLink, Route, Routes, useMatch } from "react-router-dom";

import { setIframeContextHandler } from "@commontools/iframe-sandbox";
import { LLMClient } from "@commontools/llm-client";
import { Action, ReactivityLog, addAction, removeAction } from "@commontools/runner";
import { MdOutlinePerson, MdOutlineStar } from "react-icons/md";

import ShapeLogo from "@/assets/ShapeLogo.svg";
import { CommandCenter } from "@/components/CommandCenter";
import { NavPath } from "@/components/NavPath";
import CharmDetail from "@/views/CharmDetail";
import CharmList from "@/views/CharmList";

import "./main.css";

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
    <div className="shell h-full bg-gray-50 border-2 border-black">
      <header className="flex bg-gray-50 items-center justify-between border-b-2 p-2">
        <NavLink
          to={focusedReplicaId ? `/${focusedReplicaId}` : "/"}
          className="brand flex items-center gap-2"
        >
          <ShapeLogo width={32} height={32} shapeColor="#000" containerColor="#d2d2d2" />
          <h1 className="font-bold jetbrains-mono text-sm text-black hover:underline">
            Common Tools
          </h1>
        </NavLink>

        <div className="account">
          <button className="w-10 h-10 flex items-center justify-center rounded-lg bg-gray-300 hover:bg-gray-400 transition-colors">
            <MdOutlinePerson size={24} />
          </button>
        </div>
      </header>

      <div className="toolbar m-4 p-4 border-2 border-black">
        <div slot="toolbar-start">
          {focusedReplicaId && <NavPath replicaId={focusedReplicaId} charmId={focusedCharmId} />}
        </div>
      </div>
      <div className="h-full overflow-y-auto">
        <Routes>
          <Route path="/:charmId" element={<CharmDetail />} />
          <Route index element={<CharmList />} />
        </Routes>
      </div>

      <button
        onClick={onLaunchCommand}
        className="fixed bottom-2 right-2 w-12 h-12 flex items-center justify-center rounded-lg bg-gray-300 hover:bg-gray-400 transition-colors z-50"
      >
        <MdOutlineStar fill="black" size={24} />
      </button>

      <CommandCenter />
    </div>
  );
}
