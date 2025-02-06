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
import { CharmRenderer } from "@/components/CharmRunner";
import { WebComponent } from "@/components/WebComponent";
import { useCallback, useState } from "react";

import * as osUi from "@commontools/os-ui";
console.log(osUi); // FIXME(ja): load bearing console.log - without this osUi doesn't load
import "@commontools/os-ui/src/static/main.css";
import Sidebar from "@/components/Sidebar";
import { useCell } from "@/hooks/use-charm";
import { charmManager, replica, searchResults, sidebar } from "./state";
import "./main.css";
import { castSpell } from "@/search";
import SearchResults from "@/components/SearchResults";
import { Charm, syncRecipe } from "@commontools/charm";
import { NAME, UI } from "@commontools/builder";


// FIXME(ja): perhaps this could be in common-charm?  needed to enable iframe with sandboxing
const serializeProxyObjects = (proxy: any) => {
  return proxy == undefined ? undefined : JSON.parse(JSON.stringify(proxy));
}

setIframeContextHandler({
  read(context: any, key: string): any {
    let data = context?.getAsQueryResult ? context?.getAsQueryResult([key]) : context?.[key];
    let serialized = serializeProxyObjects(data);
    return serialized;
  },
  write(context: any, key: string, value: any) {
    context.getAsQueryResult()[key] = value;
  },
  subscribe(context: any, key: string, callback: (key: string, value: any) => void): any {
    const action: Action = (log: ReactivityLog) => {
      let data = context.getAsQueryResult([key], log);
      let serialized = serializeProxyObjects(data);
      callback(key, serialized);
    };

    addAction(action);
    return action;
  },
  unsubscribe(_context: any, receipt: any) {
    removeAction(receipt);
  },
});

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

export default function Shell() {
  const [sidebarTab] = useCell(sidebar);
  const replicaName = replica;
  const [spellResults, setSearchResults] = useCell(searchResults);
  const [currentFocus, setFocus] = useState<DocImpl<Charm> | null>(null);

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
      history.pushState({}, "", `/charm/${encodeURIComponent(JSON.stringify(charmId))}`);

      // FIXME(ja): getEntityId doesn't work currently?
      const charm = charmManager.getCharms().get().find(({ cell }) => cell.entityId?.['/'] == charmId['/']);
      if (charm) setFocus(charm.cell as DocImpl<Charm>);
    },
    [setFocus],
  );

  console.log("currentFocus", currentFocus);

  return (
    <div className="h-full relative">
      <WebComponent
        as={"os-chrome"}
        wide={sidebarTab === "source" || sidebarTab === "data" || sidebarTab === "query"}
        locationTitle={replicaName}
      >
        
        {currentFocus ? (
          <>
            <button onClick={() => setFocus(null)}>close</button>
            <CharmRenderer className="h-full" charm={currentFocus} />
          </>
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
