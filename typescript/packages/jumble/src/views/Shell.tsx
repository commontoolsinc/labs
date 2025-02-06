// This is all you need to import/register the @commontools/ui web components
import "@commontools/ui";
import { setIframeContextHandler } from "@commontools/iframe-sandbox";
import { Action, ReactivityLog, addAction, removeAction } from "@commontools/runner";
import { CharmRunner } from "@/components/CharmRunner";
import { WebComponent } from "@/components/WebComponent";
import { useCallback, useMemo, useState } from "react";

import * as osUi from "@commontools/os-ui";
console.log(osUi);
import "@commontools/os-ui/src/static/main.css";
import Sidebar from "@/components/Sidebar";
import { useCell } from "@/hooks/use-charm";
import { replica, searchResults, sidebar } from "./state";
import "./main.css";
import { castSpell } from "@/search";
import SearchResults from "@/components/SearchResults";

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
  const incrementCount = useCallback(() => {
    setCount((c) => c + 1);
  }, [setCount]);

  // must be mindful to avoid re-rendering CharmRunner unnecessarily
  const argument = useMemo(() => ({ count }), [count]);
  const charmImport = useCallback(() => import("@/recipes/smol.tsx"), []);

  return (
    <>
      <button onClick={incrementCount} className="mb-4 px-4 py-2 bg-blue-500 text-white rounded">
        Increment Count ({count})
      </button>

      <CharmRunner
        charmImport={charmImport}
        argument={argument}
        className="w-full h-full"
        autoLoad
      />
    </>
  );
}

export default function Shell() {
  const [sidebarTab] = useCell(sidebar);
  const [replicaName] = useCell(replica);
  const [spellResults, setSearchResults] = useCell(searchResults);

  const onSubmit = useCallback(
    async (ev: CustomEvent) => {
      const spells = await castSpell(replicaName, ev.detail.value);
      setSearchResults(spells);
    },
    [replicaName, setSearchResults],
  );

  const onClose = useCallback(() => {
    setSearchResults([]);
  }, [setSearchResults]);

  const onSpellCast = useCallback((spell: any, blob: any) => {
    console.log("Casting spell:", spell, blob);
  }, []);

  return (
    <div className="h-full relative">
      <WebComponent
        as={"os-chrome"}
        wide={sidebarTab === "source" || sidebarTab === "data" || sidebarTab === "query"}
        locationTitle={replicaName}
      >
        <Content />
        <SearchResults
          searchOpen={spellResults.length > 0}
          results={spellResults}
          onClose={onClose}
          onSpellCast={onSpellCast}
        />

        <WebComponent slot="overlay" as="os-fabgroup" className="pin-br" onSubmit={onSubmit} />

        <os-navstack slot="sidebar">
          <Sidebar workingSpec="" focusedCharm={null} linkedCharms={[]} />
        </os-navstack>
      </WebComponent>
    </div>
  );
}
