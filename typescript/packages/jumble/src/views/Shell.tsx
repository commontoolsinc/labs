// This is all you need to import/register the @commontools/ui web components
import "@commontools/ui";
import { setIframeContextHandler } from "@commontools/iframe-sandbox";
import {
  Action,
  DocImpl,
  EntityId,
  ReactivityLog,
  addAction,
  getRecipe,
  removeAction,
} from "@commontools/runner";
import { CharmRenderer, CharmRunner } from "@/components/CharmRunner";
import { WebComponent } from "@/components/WebComponent";
import { useCallback, useEffect, useMemo, useState } from "react";

import * as osUi from "@commontools/os-ui";
console.log(osUi);
import "@commontools/os-ui/src/static/main.css";
import Sidebar from "@/components/Sidebar";
import { useCell } from "@/hooks/use-charm";
import { charmManager, focusedCharm, replica, searchResults, sidebar } from "./state";
import "./main.css";
import { castSpell } from "@/search";
import SearchResults from "@/components/SearchResults";
import { Charm, syncRecipe } from "@commontools/charm";
import { NAME, UI } from "@commontools/builder";
import { setFips } from "node:crypto";
import { Route, Router, Routes, useParams } from "react-router-dom";

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
  const onCharmReady = useCallback(() => {}, []);

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
        onCharmReady={onCharmReady}
      />
    </>
  );
}
function Charms({ onCharmClick }: { onCharmClick?: (charmId: EntityId) => void }) {
  const [charms] = useCell(charmManager.getCharms());
  console.log("charms", charms);

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8 p-8">
      {charms.map((charm, index) => (
        <div
          key={index}
          className="bg-white border border-gray-100 rounded-lg overflow-hidden cursor-pointer hover:border-gray-300 transition-colors duration-200"
          onClick={() => onCharmClick?.(charm.cell.entityId!)}
        >
          <div className="p-4">
            <h3 className="text-xl font-semibold text-gray-800 mb-4">
              {charm.cell.get()[NAME] || "Unnamed Charm"}
            </h3>
            <div className="w-full bg-gray-50 rounded border border-gray-100 p-3">
              <pre className="w-full h-24 overflow-hidden whitespace-pre-wrap text-xs text-gray-500">
                {JSON.stringify(charm.cell.get()[UI], null, 2)}
              </pre>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function CharmRoute() {
  const { charmId } = useParams();
  const [currentFocus, setCurrentFocus] = useState<Charm | null>(null);

  useEffect(() => {
    async function loadCharm() {
      debugger;
      if (charmId) {
        // failing to create valid EntityId, need to go fromString()
        const charm = (await charmManager.get(JSON.parse(charmId))) ?? null;
        setCurrentFocus(charm);
      }
    }
    loadCharm();
  }, [charmId]);

  if (!currentFocus) {
    return <div>Loading...</div>;
  }

  return <CharmRenderer className="h-full" charm={currentFocus} />;
}

export default function Shell() {
  const [sidebarTab] = useCell(sidebar);
  const [replicaName] = useCell(replica);
  const [spellResults, setSearchResults] = useCell(searchResults);
  const [currentFocus, setFocus] = useState<Charm | null>(null);

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

  const onSpellCast = useCallback(
    async (result: any, blob: any) => {
      const recipeKey = result?.key;

      if (recipeKey && blob) {
        console.log("Syncing...");
        const recipeId = recipeKey.replace("spell-", "");
        await syncRecipe(recipeId);

        const recipe = getRecipe(recipeId);
        if (!recipe) return;

        console.log("Casting...");
        const charm: DocImpl<Charm> = await charmManager.runPersistent(recipe, blob.data);
        charmManager.add([charm]);
        console.log("Ready!");

        setSearchResults([]);
      } else {
        console.log("Failed to cast");
      }
    },
    [setSearchResults],
  );

  const onCharmClick = useCallback(
    async (charmId: EntityId) => {
      console.log(charmId);
      history.pushState({}, "", `/shell/charm/${encodeURIComponent(JSON.stringify(charmId))}`);
      // setFocus(charm);
    },
    [setFocus],
  );

  console.log("currentFocus", currentFocus);
  const params = useParams();

  return (
    <div className="h-full relative">
      <WebComponent
        as={"os-chrome"}
        wide={sidebarTab === "source" || sidebarTab === "data" || sidebarTab === "query"}
        locationTitle={replicaName}
      >
        <Routes>
          <Route path="charm/:charmId" element={<CharmRoute />} />
        </Routes>
        {currentFocus ? (
          <CharmRenderer className="h-full" charm={currentFocus} />
        ) : (
          <Charms onCharmClick={onCharmClick} />
        )}

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
