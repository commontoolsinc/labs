import { useCell } from "@/hooks/use-cell";
import { NavLink } from "react-router-dom";
import { NAME, UI } from "@commontools/builder";
import { useCharmManager } from "@/contexts/CharmManagerContext";
import { Charm } from "@commontools/charm";
import { charmId } from "@/utils/charms";
import { useEffect, useRef, useState } from "react";
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
    const charmData = charm[UI];
    if (!charmData) return;
    preview.innerHTML = "";

    try {
      const cancel = render(preview, charmData);
      return cancel;
    } catch (error) {
      console.error("Failed to render charm preview:", error);
      preview.innerHTML = "<p>Preview unavailable</p>";
    }
  }, [charm, isIntersecting]);

  return (
    <Card className="p-2" details>
      <NavLink to={`/${replicaName}/${charmId(charm)}`}>
        <div>
          <h3 className="text-xl font-semibold text-gray-800 mb-4">
            {(charm[NAME] || "Unnamed Charm") + ` (#${charmId(charm).slice(-4)})`}
          </h3>
          <div
            ref={previewRef}
            className="w-full bg-gray-50 rounded border border-gray-100 min-h-[192px] pointer-events-none select-none"
          ></div>
        </div>
      </NavLink>
    </Card>
  );
}

export default function CharmList() {
  const { replicaName } = useParams<{ replicaName: string }>();
  const { charmManager } = useCharmManager();
  const [charms] = useCell(charmManager.getCharms());

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8 p-8">
      {replicaName &&
        charms.map((charm) => (
          <CharmPreview key={charmId(charm)} charm={charm} replicaName={replicaName} />
        ))}
    </div>
  );
}
