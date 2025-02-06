import React from "react";
import { WebComponent } from "./WebComponent";
import { getRecipe } from "@commontools/runner";
import { useCell } from "@/hooks/use-charm";
import { charmManager, sidebar } from "@/views/state";
import { NAME, UI } from "@commontools/builder";

interface SidebarProps {
  linkedCharms: any[];
  workingSpec: string;
  focusedCharm: any;
  handlePublish: () => void;
  recipeId: string;
}

const Sidebar: React.FC<
  SidebarProps & {
    query: any;
    onQueryChanged: (value: string) => void;
    schema: any;
    copyRecipeLink: () => void;
    argument: any;
    data: any;
    onDataChanged: (value: string) => void;
    onSpecChanged: (value: string) => void;
  }
> = ({
  linkedCharms,
  workingSpec,
  focusedCharm,
  handlePublish,
  recipeId,
  query,
  onQueryChanged,
  schema,
  copyRecipeLink,
  argument,
  data,
  onDataChanged,
  onSpecChanged,
}) => {
  const [sidebarTab, setSidebarTab] = useCell(sidebar);

  const handleSidebarTabChange = (newTab: string) => {
    setSidebarTab(newTab);
  };

  const tabs = [
    { id: "home", icon: "home", label: "Home" },
    { id: "prompt", icon: "message", label: "Prompt" },
    { id: "links", icon: "sync_alt", label: "Links" },
    { id: "query", icon: "query_stats", label: "Query" },
    { id: "data", icon: "database", label: "Data" },
    { id: "schema", icon: "schema", label: "Schema" },
    { id: "source", icon: "code", label: "Source" },
    { id: "recipe-json", icon: "data_object", label: "JSON" },
  ];

  const panels = {
    home: (
      <div>
        <div>Pinned</div>
      </div>
    ),
    links: (
      <div>
        <div>Linked Charms</div>
        <div>
          {linkedCharms.map((charm) => (
            <common-charm-link charm={charm} />
          ))}
        </div>
      </div>
    ),
    query: (
      <div>
        <div>Query</div>
        <div>
          <os-code-editor
            slot="content"
            language="application/json"
            source={JSON.stringify(query, null, 2)}
            onDocChange={onQueryChanged}
          />
        </div>
      </div>
    ),
    schema: (
      <div>
        <div>Schema</div>
        <div>
          <os-code-editor
            slot="content"
            language="application/json"
            source={JSON.stringify(schema, null, 2)}
          />
        </div>
      </div>
    ),
    source: (
      <div>
        <div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              border: "1px solid pink",
              padding: "10px",
            }}
          >
            <a
              href={`/recipe/spell-${recipeId}`}
              target="_blank"
              onClick={copyRecipeLink}
              style={{ float: "right" }}
              className="close-button"
            >
              🔗 Share
            </a>
            <button onClick={handlePublish} className="close-button">
              🪄 Publish to Spellbook Jr
            </button>
          </div>
        </div>
        <div style={{ margin: "10px" }}></div>
        <div>
          <common-spell-editor recipeId={recipeId} data={argument} />
        </div>
      </div>
    ),
    "recipe-json": (
      <div>
        <div>Recipe JSON</div>
        <div>
          <os-code-editor
            slot="content"
            language="application/json"
            source={JSON.stringify(getRecipe(recipeId), null, 2)}
          />
        </div>
      </div>
    ),
    data: (
      <div>
        <div>
          Data
          <span
            id="log-button"
            onClick={() => console.log(JSON.stringify(focusedCharm?.getAsQueryResult()))}
            className="close-button"
          >
            log
          </span>
        </div>
        <div>
          <os-code-editor
            slot="content"
            language="application/json"
            source={JSON.stringify(data, null, 2)}
            onDocChange={onDataChanged}
          />
        </div>
      </div>
    ),
    prompt: (
      <div>
        <div>
          Spec
          <a
            href={`/recipe/${recipeId}`}
            target="_blank"
            onClick={copyRecipeLink}
            style={{ float: "right" }}
            className="close-button"
          >
            🔗 Share
          </a>
        </div>
        <div>
          <os-code-editor
            slot="content"
            language="text/markdown"
            source={workingSpec}
            onDocChange={onSpecChanged}
          />
        </div>
      </div>
    ),
  };

  return (
    <div>
      <os-sidebar-close-button></os-sidebar-close-button>
      {panels[sidebarTab as keyof typeof panels]}
      <WebComponent
        as="os-tab-bar"
        items={tabs}
        selected={sidebarTab}
        onTabChange={(e: CustomEvent) => handleSidebarTabChange(e.detail.selected)}
      />
    </div>
  );
};

export default Sidebar;
