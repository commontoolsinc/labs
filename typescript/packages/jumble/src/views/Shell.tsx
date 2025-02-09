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
import { useCallback, useEffect, useRef } from "react";

import * as osUi from "@commontools/os-ui";
// bf: load bearing console.log
console.log("initializing os-ui", osUi);

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
import { LLMClient } from "@commontools/llm-client";

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
  async onLLMRequest(_context: any, payload: string) {
    console.log("onLLMRequest", payload);
    const jsonPayload = JSON.parse(payload);
    if (!jsonPayload.model) {
      jsonPayload.model = ["groq:llama-3.3-70b-specdec", "anthropic:claude-3-5-sonnet-latest"];
    }

    const res = await llm.sendRequest(jsonPayload);
    console.log("onLLMRequest res", res);
    return res;
  },
});

async function castSpellAsCharm(charmManager: CharmManager, result: any, blob: any) {
  const recipeKey = result?.key;

  if (recipeKey && blob) {
    console.log("Syncing...");
    const recipeId = recipeKey.replace("spell-", "");
    await charmManager.syncRecipeBlobby(recipeId);

    const recipe = getRecipe(recipeId);
    if (!recipe) return;

    console.log("Casting...");
    const doc = await charmManager.sync({ "/": blob.key }, true);
    const charm: DocImpl<Charm> = await charmManager.runPersistent(recipe, {
      cell: doc,
      path: ["argument"],
    });
    charmManager.add([charm]);
    console.log("Ready!");
  } else {
    console.log("Failed to cast");
  }
}

interface CommonDataEvent extends CustomEvent {
  detail: {
    shiftKey: boolean;
    data: any[];
  };
}

export default function Shell() {
  const [sidebarTab] = useCell(sidebar);
  const [replicaName] = useCell(replica);
  const [spellResults, setSearchResults] = useCell(searchResults);
  const navigate = useNavigate();
  const { charmManager } = useCharmManager();
  const commonImportRef = useRef<HTMLElement | null>(null);

  const onSubmit = useCallback(
    async (ev: CustomEvent) => {
      const charmId = window.location.pathname.match(/\/charm\/([^/]+)/)?.[1] ?? null;
      if (charmId) {
        console.log("Iterating charm", charmId);

        const charm = (await charmManager.get(charmId)) ?? null;
        const newCharmId = await iterate(charmManager, charm, ev.detail.value, ev.detail.shiftKey);
        if (newCharmId) {
          // FIXME(ja): this is a hack to get the charm id
          const id = (newCharmId as any).toJSON()["/"];
          navigate(`/charm/${id}`);
        }
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
    const name = prompt("Set new replica name: ");
    if (name) {
      replica.send(name);
    }
  }, []);

  const onImportLocalData = (event: CommonDataEvent) => {
    const [data] = event.detail.data;
    console.log("Importing local data:", data);
    // FIXME(ja): this needs better error handling
    const title = prompt("Enter a title for your recipe:");
    if (!title) return;

    castNewRecipe(charmManager, data, title);
    // if (charmId) {
    //   openCharm(charmId);
    // }
  };

  useEffect(() => {
    const current = commonImportRef.current;
    if (current) {
      current.addEventListener("common-data", onImportLocalData as EventListener);
    }
    return () => {
      if (current) {
        current.removeEventListener("common-data", onImportLocalData as EventListener);
      }
    };
  }, []);

  return (
    <div className="h-full relative">
      <WebComponent
        as={"os-chrome"}
        wide={sidebarTab === "source"}
        locationTitle={replicaName}
        onLocation={onLocation}
      >
        <os-common-import ref={commonImportRef}>
          <div style={{ display: "flex", alignItems: "center" }}>
            <os-ai-icon></os-ai-icon>
            <p>Imagine or drop json to begin</p>
          </div>
        </os-common-import>

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
            handlePublish={() => { }}
            recipeId="dummy-recipe-id"
            schema={{ imagine: "a schema" }}
            copyRecipeLink={() => { }}
            data={{ imagine: "some data" }}
            onDataChanged={(value: string) => { }}
            onSpecChanged={(value: string) => { }}
          />
        </os-navstack>
      </WebComponent>
    </div>
  );
}
