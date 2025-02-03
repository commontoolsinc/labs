// This is all you need to import/register the @commontools/ui web components
import "@commontools/ui";
import { setIframeContextHandler } from "@commontools/iframe-sandbox";
import { Action, ReactivityLog, addAction, removeAction } from "@commontools/runner";
import { CharmRunner } from "@/components/CharmRunner";
import { WebComponent } from "@/components/WebComponent";
import { useState } from "react";

import * as osUi from "@commontools/os-ui";
console.log(osUi);
import "@commontools/os-ui/src/static/main.css";
import Sidebar from "@/components/Sidebar";
import { useCell } from "@/hooks/use-charm";
import { sidebar } from "./state";
import "./main.css";

// FIXME(ja): perhaps this could be in common-charm?  needed to enable iframe with sandboxing
setIframeContextHandler({
  read(context: any, key: string): any {
    return context?.getAsQueryResult ? context?.getAsQueryResult([key]) : context?.[key];
  },
  write(context: any, key: string, value: any) {
    context.getAsQueryResult()[key] = value;
  },
  subscribe(context: any, key: string, callback: (key: string, value: any) => void): any {
    const action: Action = (log: ReactivityLog) =>
      callback(key, context.getAsQueryResult([key], log));

    addAction(action);
    return action;
  },
  unsubscribe(_context: any, receipt: any) {
    removeAction(receipt);
  },
});

function Content() {
  const [count, setCount] = useState(0);

  const incrementCount = () => {
    setCount((c) => c + 1);
  };

  return (
    <>
      <button onClick={incrementCount} className="mb-4 px-4 py-2 bg-blue-500 text-white rounded">
        Increment Count ({count})
      </button>

      <CharmRunner
        charmImport={() => import("@/recipes/smol.tsx")}
        argument={{ count }}
        className="w-full h-full"
        autoLoad
      />
    </>
  );
}

export default function Shell() {
  const [sidebarTab] = useCell(sidebar);

  return (
    <div className="h-full relative">
      <WebComponent
        as={"os-chrome"}
        wide={sidebarTab === "source" || sidebarTab === "data" || sidebarTab === "query"}
        locationTitle="Hello World"
        onLocation={() => {
          debugger;
        }}
      >
        <Content />

        <WebComponent
          slot="overlay"
          as="os-fabgroup"
          className="pin-br"
          onSubmit={() => {
            console.log("submitted");
          }}
        />

        <os-navstack slot="sidebar">
          <Sidebar workingSpec="" focusedCharm={null} linkedCharms={[]} />
        </os-navstack>
      </WebComponent>
    </div>
  );
}
