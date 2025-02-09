import React from "react";
import { WebComponent } from "./WebComponent";
import { DocImpl, getRecipe } from "@commontools/runner";
import { useCell } from "@/hooks/use-charm";
import { sidebar } from "@/views/state";
import { NAME } from "@commontools/builder";
import { NavLink } from "react-router-dom";
import { Charm } from "@commontools/charm";
import { useCharmManager } from "@/contexts/CharmManagerContext";
import { charmId } from "@/utils/charms";

export interface SidebarProps {
  linkedCharms: DocImpl<Charm>[];
  workingSpec: string;
  handlePublish: () => void;
  recipeId: string;
  schema: any;
  copyRecipeLink: () => void;
  data: any;
  onDataChanged: (value: string) => void;
  onSpecChanged: (value: string) => void;
}

const Sidebar: React.FC<SidebarProps> = ({
  linkedCharms,
  workingSpec,
  recipeId,
  schema,
  data,
  onDataChanged,
  onSpecChanged,
}) => {
  const { charmManager } = useCharmManager();

  const [sidebarTab, setSidebarTab] = useCell(sidebar);
  const [charms] = useCell(charmManager.getCharms());

  const handleSidebarTabChange = (newTab: string) => {
    setSidebarTab(newTab);
  };

  const tabs = [
    { id: "home", icon: "home", label: "Home" },
    { id: "prompt", icon: "message", label: "Prompt" },
    { id: "links", icon: "sync_alt", label: "Links" },
    { id: "data", icon: "database", label: "Data" },
    { id: "schema", icon: "schema", label: "Schema" },
    { id: "recipe-json", icon: "data_object", label: "JSON" },
  ];

  const panels = {
    home: (
      <div>
        <div>Pinned</div>
        <ul>
          {charms.map((charm) => (
            <li key={charmId(charm)}>
              <NavLink to={`/charm/${charmId(charm)}`}>
                {charm.cell.get()[NAME] || "unknown"}
              </NavLink>
              <button onClick={() => charmManager.remove(charm)}>×</button>
            </li>
          ))}
        </ul>
      </div>
    ),
    links: (
      <div>
        <div>Linked Charms</div>
        <div>
          {linkedCharms.map((charm) => (
            <NavLink to={`/charm/${charmId(charm)}`}>{charm.get()[NAME]}</NavLink>
          ))}
        </div>
      </div>
    ),
    schema: (
      <div>
        <div>Schema</div>
        <div>
          <WebComponent
            as="os-code-editor"
            slot="content"
            language="application/json"
            source={JSON.stringify(schema, null, 2)}
          />
        </div>
      </div>
    ),
    "recipe-json": (
      <div>
        <div>Recipe JSON</div>
        <div>
          <WebComponent
            as="os-code-editor"
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
          <WebComponent
            as="os-code-editor"
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
          <WebComponent
            as="os-code-editor"
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
