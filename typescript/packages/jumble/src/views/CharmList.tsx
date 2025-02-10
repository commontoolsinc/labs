import { useCell } from "@/hooks/use-cell";
import { NavLink } from "react-router-dom";
import { NAME, UI } from "@commontools/builder";
import { useCharmManager } from "@/contexts/CharmManagerContext";
import { castNewRecipe } from "@commontools/charm";
import { charmId } from "@/utils/charms";
import { useEffect, useRef } from "react";
import { Card } from "@/components/Card";
import { useParams } from "react-router-dom";

export interface CommonDataEvent extends CustomEvent {
  detail: {
    data: any[];
  };
}

export default function CharmList() {
  const { replicaName } = useParams<{ replicaName: string }>();
  const { charmManager } = useCharmManager();
  const [charms] = useCell(charmManager.getCharms());
  const commonImportRef = useRef<HTMLElement | null>(null);

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
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8 p-8">
      <os-common-import ref={commonImportRef}>
        <div style={{ display: "flex", alignItems: "center" }}>
          <os-ai-icon></os-ai-icon>
          <p>
            Imagine or drop json to begin ... or{" "}
            <button
              onClick={() =>
                onImportLocalData(
                  new CustomEvent("common-data", {
                    detail: { data: [{ gallery: [{ title: "pizza", prompt: "a yummy pizza" }] }] },
                  }),
                )
              }
            >
              ai image gallery
            </button>
          </p>
        </div>
      </os-common-import>
      {charms.map((charm, index) => (
        <>
          {charm.cell && (
            <Card details key={index}>
              <NavLink to={`/${replicaName}/${charmId(charm)}`}>
                <div className="p-4" style={{ viewTransitionName: `charm-${charmId(charm)}` }}>
                  <h3 className="text-xl font-semibold text-gray-800 mb-4">
                    {charm.cell.get()?.[NAME] || "Unnamed Charm"}
                  </h3>
                  <div className="w-full bg-gray-50 rounded border border-gray-100 p-3">
                    <pre className="w-full h-24 overflow-hidden whitespace-pre-wrap text-xs text-gray-500">
                      {JSON.stringify(charm.cell.get()?.[UI], null, 2)}
                    </pre>
                  </div>
                </div>
              </NavLink>
            </Card>
          )}
        </>
      ))}
    </div>
  );
}
