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
console.log("initializing os-ui", osUi);

import "@commontools/os-ui/src/static/main.css";
import { useCell } from "@/hooks/use-cell";
import { searchResults, sidebar } from "./state";
import "./main.css";
import { castSpell } from "@/search";
import SearchResults from "@/components/SearchResults";
import { Charm, CharmManager, iterate } from "@commontools/charm";
import { NavLink, Routes, Route, useNavigate, useParams } from "react-router-dom";
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

export default function Shell() {
  // Get the replica name from the URL, defaulting to "common-knowledge"
  const { replicaName = "common-knowledge" } = useParams<{ replicaName: string }>();
  const navigate = useNavigate();
  const [sidebarTab] = useCell(sidebar);
  const [spellResults, setSearchResults] = useCell(searchResults);
  const { charmManager } = useCharmManager();

  const onSubmit = useCallback(
    async (ev: CustomEvent) => {
      const charmId = window.location.pathname.match(/\/[^/]+\/([^/]+)/)?.[1] ?? null;
      if (charmId) {
        console.log("Iterating charm", charmId);

        const charm = (await charmManager.get(charmId)) ?? null;
        const newCharmId = await iterate(charmManager, charm, ev.detail.value, ev.detail.shiftKey);
        if (newCharmId) {
          // FIXME(ja): this is a hack to get the charm id
          const id = (newCharmId as any).toJSON()["/"];
          navigate(`/${replicaName}/${id}`);
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

  const onLocation = useCallback(() => {
    const name = prompt("Set new replica name: ");
    if (name) {
      navigate(`/${name}`);
    }
  }, [navigate]);

  return (
    <div className="h-full relative">
      <WebComponent
        as={"os-chrome"}
        wide={sidebarTab === "source"}
        locationTitle={replicaName}
        onLocation={onLocation}
      >
        <NavLink to={`/${replicaName}`} slot="toolbar-start">
          <WebComponent as="os-avatar" name="Ben"></WebComponent>
        </NavLink>

        <div className="relative h-full">
          <Routes>
            <Route path="/:charmId" element={<CharmDetail />} />
            <Route index element={<CharmList />} />
          </Routes>
        </div>

        <SearchResults
          searchOpen={spellResults.length > 0}
          results={spellResults}
          onClose={onClose}
          onSpellCast={onSpellCast}
        />

        <WebComponent slot="overlay" as="os-fabgroup" className="pin-br" onSubmit={onSubmit} />
      </WebComponent>
    </div>
  );
}
