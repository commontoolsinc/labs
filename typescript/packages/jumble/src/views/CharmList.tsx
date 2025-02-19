import { useCell } from "@/hooks/use-cell";
import { NavLink } from "react-router-dom";
import { NAME, UI } from "@commontools/builder";
import { useCharmManager } from "@/contexts/CharmManagerContext";
import { castNewRecipe, Charm } from "@commontools/charm";
import { charmId } from "@/utils/charms";
import { useCallback, useEffect, useRef, useState } from "react";
import { Card } from "@/components/Card";
import { useParams } from "react-router-dom";
import { render } from "@commontools/html";

export interface CommonDataEvent extends CustomEvent {
  detail: {
    data: any[];
  };
}
function CharmPreview({ charm, replicaName }: { charm: Charm; replicaName: string }) {
  const previewRef = useRef<HTMLDivElement | null>(null);
  const [isIntersecting, setIsIntersecting] = useState(false);

  useEffect(() => {
    if (!previewRef.current) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        setIsIntersecting(entry.isIntersecting);
      },
      { threshold: 0 },
    );

    observer.observe(previewRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!previewRef.current || !isIntersecting) return;
    const preview = previewRef.current;
    const charmData = charm.cell.get()?.[UI];
    if (!charmData) return;
    preview.innerHTML = ""; // Clear any existing rendered content
    const cancel = render(preview, charmData);
    return cancel;
  }, [charm, isIntersecting]);

  return (
    <Card className="p-2" details>
      <NavLink to={`/${replicaName}/${charmId(charm)}`}>
        <div>
          <h3 className="text-xl font-semibold text-gray-800 mb-4">
            {(charm.cell.getAsQueryResult()?.[NAME] || "Unnamed Charm") +
              ` (#${charmId(charm).slice(-4)})`}
          </h3>
          <div
            ref={previewRef}
            className="w-full bg-gray-50 rounded border border-gray-100 min-h-[192px]"
          ></div>
        </div>
      </NavLink>
    </Card>
  );
}

export default function CharmList() {
  const { replicaName } = useParams<{ replicaName: string }>();
  console.log("replicaName", replicaName);
  const { charmManager } = useCharmManager();
  const [charms] = useCell(charmManager.getCharms());
  const commonImportRef = useRef<HTMLElement | null>(null);

  const onImportLocalData = useCallback(
    (event: CommonDataEvent) => {
      const [data] = event.detail.data;
      console.log("Importing local data:", data);
      // FIXME(ja): this needs better error handling
      const title = prompt("Enter a title for your recipe:");
      if (!title) return;

      castNewRecipe(charmManager, data, title);
      // if (charmId) {
      //   openCharm(charmId);
      // }
    },
    [charmManager],
  );

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
  }, [replicaName, onImportLocalData]);

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8 p-8">
      {replicaName &&
        charms
          .filter((c) => !!c.cell)
          .map((charm) => (
            <CharmPreview key={charmId(charm)} charm={charm} replicaName={replicaName} />
          ))}
    </div>
  );
}
