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
import { Cell } from "@commontools/runner";

export interface CommonDataEvent extends CustomEvent {
  detail: {
    data: any[];
  };
}
function CharmPreview({ charm, replicaName }: { charm: Cell<Charm>; replicaName: string }) {
  const previewRef = useRef<HTMLDivElement | null>(null);
  const [isIntersecting, setIsIntersecting] = useState(false);

  const { charmManager } = useCharmManager();

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
    preview.innerHTML = "";

    try {
      return render(preview, charm.key(UI));
    } catch (error) {
      console.error("Failed to render charm preview:", error);
      preview.innerHTML = "<p>Preview unavailable</p>";
    }
  }, [charm, isIntersecting]);

  return (
    <Card className="p-2 group relative" details>
      <button
        onClick={(e) => {
          e.preventDefault();
          if (window.confirm("Are you sure you want to remove this charm?")) {
            charmManager.remove({ "/": charmId(charm)! });
          }
        }}
        className="absolute hidden group-hover:block top-2 right-2 p-2 text-gray-400 hover:text-red-500 transition-colors"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
        </svg>
      </button>
      <NavLink to={`/${replicaName}/${charmId(charm)}`}>
        <div>
          <h3 className="text-xl font-semibold text-gray-800 mb-4">
            {(charm.get()[NAME] || "Unnamed Charm") + ` (#${charmId(charm)!.slice(-4)})`}
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
