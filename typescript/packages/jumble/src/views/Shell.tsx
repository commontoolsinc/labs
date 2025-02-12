import "@commontools/ui";
import { useCallback } from "react";
import { NavLink, Outlet, useParams, useLocation } from "react-router-dom";
import { animated } from "@react-spring/web";

import { setIframeContextHandler } from "@commontools/iframe-sandbox";
import { LLMClient } from "@commontools/llm-client";
import { Action, ReactivityLog, addAction, removeAction } from "@commontools/runner";
import { MdOutlinePerson, MdOutlineStar } from "react-icons/md";
import { LuPencil } from "react-icons/lu";
import ShapeLogo from "@/assets/ShapeLogo.svg";
import { CommandCenter } from "@/components/CommandCenter";
import { NavPath } from "@/components/NavPath";

import CharmDetail from "@/views/CharmDetail";
import CharmList from "@/views/CharmList";
import CharmEditView from "@/views/CharmEditView";

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
  const { charmId, replicaName } = useParams();
  const location = useLocation();

  // TOOLBAR START
  // NOTE(jake): We will want to move this into a Toolbar component at some point
  const isDetailActive = location.pathname.endsWith("/detail");
  const togglePath = isDetailActive
    ? `/${replicaName}/${charmId}`
    : `/${replicaName}/${charmId}/detail`;
  // TOOLBAR END

  const onLaunchCommand = useCallback(() => {
    window.dispatchEvent(new CustomEvent("open-command-center"));
  }, []);

  return (
    <div className="shell h-full bg-gray-50 border-2 border-black">
      <header className="flex bg-gray-50 items-center justify-between border-b-2 p-2">
        <NavLink
          to={replicaName ? `/${replicaName}` : "/"}
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

      {/* TOOLBAR START */}
      {/* FIXME(jake): This should be a Toolbar component at some point. */}
      <div className="toolbar m-4 p-4 border-2 border-black flex items-center justify-between">
        <div slot="toolbar-start">
          <NavPath replicaId={replicaName} charmId={charmId} />
        </div>

        <div slot="toolbar-end">
          {charmId && (
            <NavLink
              to={togglePath}
              className={`w-10 h-10 flex items-center justify-center rounded-lg transition-colors ${
                isDetailActive
                  ? "bg-gray-300 hover:bg-gray-400 text-black"
                  : "bg-transparent text-black  hover:bg-gray-200"
              }`}
            >
              <LuPencil size={16} />
            </NavLink>
          )}
        </div>
      </div>
      {/* TOOLBAR END */}
      <div className="relative h-full">
        <Outlet />
      </div>

      <animated.button
        className="
          flex items-center justify-center fixed bottom-2 right-2 w-12 h-12 z-50
          border-2 border-black shadow-[2px_2px_0px_0px_rgba(0,0,0,0.5)]
          hover:translate-y-[-2px] hover:shadow-[2px_2px_0px_0px_rgba(0,0,0,0.7)]
          transition-[border,box-shadow,transform] duration-100 ease-in-out
          bg-white cursor-pointer
        "
        onClick={onLaunchCommand}
      >
        <MdOutlineStar fill="black" size={24} />
      </animated.button>

      <CommandCenter />
    </div>
  );
}
