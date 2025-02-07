// This is all you need to import/register the @commontools/ui web components
import "@commontools/ui";
import { setIframeContextHandler } from "@commontools/iframe-sandbox";
import {
  Action,
  DocImpl,
  ReactivityLog,
  addAction,
  getRecipe,
  removeAction,
} from "@commontools/runner";
import { WebComponent } from "@/components/WebComponent";
import { useCallback } from "react";

import * as osUi from "@commontools/os-ui";
// bf: load bearing console.log
console.log(osUi);

import "@commontools/os-ui/src/static/main.css";
import Sidebar from "@/components/Sidebar";
import { useCell } from "@/hooks/use-charm";
import { replica, searchResults, sidebar } from "./state";
import "./main.css";
import { castSpell } from "@/search";
import SearchResults from "@/components/SearchResults";
import { Charm, CharmManager, iterate, castNewRecipe } from "@commontools/charm";
import { NavLink, Route, Routes, useNavigate } from "react-router-dom";
import CharmDetail from "./CharmDetail";
import CharmList from "./CharmList";
import { useCharmManager } from "@/contexts/CharmManagerContext";

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
  async onLLMRequest(_context: any, payload: string) {
    const res = await fetch(`${window.location.origin}/api/ai/llm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    });
    if (res.ok) {
      return await res.json();
    } else {
      throw new Error("LLM request failed");
    }
  },
});

async function castSpellAsCharm(charmManager: CharmManager, result: any, blob: any) {
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
  } else {
    console.log("Failed to cast");
  }
}

export default function Shell() {
  const [sidebarTab] = useCell(sidebar);
  const [replicaName] = useCell(replica);
  const [spellResults, setSearchResults] = useCell(searchResults);
  const navigate = useNavigate();
  const { charmManager } = useCharmManager();

  const onSubmit = useCallback(
    async (ev: CustomEvent) => {
      const charmId = window.location.pathname.match(/\/charm\/([^/]+)/)?.[1] ?? null;
      if (charmId) {
        console.log("Iterating charm", charmId);

        const charm = (await charmManager.get(charmId)) ?? null;
        const newCharmId = await iterate(charmManager, charm, ev.detail.value, ev.detail.shiftKey);
        navigate(`/charm/${newCharmId}`);
      } else {
        console.log("Casting spell", ev.detail.value);
        const spells = await castSpell(replicaName, ev.detail.value);
        setSearchResults(spells);
      }
    },
    [replicaName, setSearchResults, navigate, charmManager],
  );

  const onClose = useCallback(() => {
    setSearchResults([]);
  }, [setSearchResults]);

  const onSpellCast = useCallback(
    async (result: any, blob: any) => {
      await castSpellAsCharm(charmManager, result, blob);
      setSearchResults([]);
    },
    [setSearchResults, charmManager],
  );

  const onLocation = useCallback((_: CustomEvent) => {
    const name = prompt("Set new replica bame: ");
    if (name) {
      replica.send(name);
    }
  }, []);

  const onImportLocalData = async () => {
    const data = {
      count: 0,
    };
    console.log("Importing local data:", data);
    // FIXME(ja): this needs better error handling
    const title = prompt("Enter a title for your recipe:");
    if (!title) return;

    const charmId = await castNewRecipe(charmManager, data, title);
    console.log("charmId", charmId);
    // if (charmId) {
    //   openCharm(charmId);
    // }
  };

  return (
    <div className="h-full relative">
      <WebComponent
        as={"os-chrome"}
        wide={sidebarTab === "source"}
        locationTitle={replicaName}
        onLocation={onLocation}
      >
        <a href="#" onClick={onImportLocalData}>
          Import Thingy
        </a>

        <NavLink to="/" slot="toolbar-start">
          <WebComponent as="os-avatar" name="Ben"></WebComponent>
        </NavLink>

        <Routes>
          <Route path="charm/:charmId" element={<CharmDetail />} />
          <Route index element={<CharmList />} />
        </Routes>

        <SearchResults
          searchOpen={spellResults.length > 0}
          results={spellResults}
          onClose={onClose}
          onSpellCast={onSpellCast}
        />

        <WebComponent slot="overlay" as="os-fabgroup" className="pin-br" onSubmit={onSubmit} />

        <os-navstack slot="sidebar">
          {/* bf: most of these are stubbed, need to pass real values in */}
          <Sidebar
            linkedCharms={[]}
            workingSpec="example spec"
            handlePublish={() => {}}
            recipeId="dummy-recipe-id"
            schema={{ imagine: "a schema" }}
            copyRecipeLink={() => {}}
            data={{ imagine: "some data" }}
            onDataChanged={(value: string) => {}}
            onSpecChanged={(value: string) => {}}
          />
        </os-navstack>
      </WebComponent>
    </div>
  );
}
