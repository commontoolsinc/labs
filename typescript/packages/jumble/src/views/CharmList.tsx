import { useCell } from "@/hooks/use-cell.ts";
import { NavLink } from "react-router-dom";
import { NAME, UI } from "@commontools/builder";
import { useCharmManager } from "@/contexts/CharmManagerContext.tsx";
import { Charm } from "@commontools/charm";
import { charmId } from "@/utils/charms.ts";
import { useEffect, useRef, useState } from "react";
import { CommonCard } from "@/components/common/CommonCard.tsx";
import { useParams } from "react-router-dom";
import { render } from "@commontools/html";
import { Cell, getCellFromDocLink } from "@commontools/runner";
import ShapeLogo from "@/assets/ShapeLogo.tsx";
import { MdOutlineStar } from "react-icons/md";
import { useSyncedStatus } from "@/hooks/use-synced-status.ts";

export interface CommonDataEvent extends CustomEvent {
  detail: {
    data: any[];
  };
}

interface ParallaxLayerProps {
  id: string;
  translateFactor: number;
  x: number;
  y: number;
}
function ParallaxPreview({ content }: { content: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mousePositionRef = useRef({ x: 0, y: 0 });
  const animationFrameIdRef = useRef<number | null>(null);

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!containerRef.current) return;

    const rect = containerRef.current.getBoundingClientRect();
    // Calculate position relative to container center
    const x = ((e.clientX - rect.left) / rect.width - 0.5) * 2; // -1 to 1
    const y = ((e.clientY - rect.top) / rect.height - 0.5) * 2; // -1 to 1

    mousePositionRef.current = { x, y };
  };

  const handleMouseLeave = () => {
    // Reset position when mouse leaves
    mousePositionRef.current = { x: 0, y: 0 };
  };

  useEffect(() => {
    if (!containerRef.current) return;

    // Find SVG layers once the content is rendered
    const container = containerRef.current;

    const animate = () => {
      const svg = container.querySelector("svg");
      if (!svg) {
        animationFrameIdRef.current = requestAnimationFrame(animate);
        return;
      }

      const layers: ParallaxLayerProps[] = [
        {
          id: "bg",
          translateFactor: 10,
          x: mousePositionRef.current.x,
          y: mousePositionRef.current.y,
        },
        {
          id: "main",
          translateFactor: 20,
          x: mousePositionRef.current.x,
          y: mousePositionRef.current.y,
        },
        {
          id: "fg",
          translateFactor: 30,
          x: mousePositionRef.current.x,
          y: mousePositionRef.current.y,
        },
      ];

      layers.forEach((layer) => {
        const element = svg.getElementById(layer.id);
        if (element) {
          const translateX = layer.x * layer.translateFactor;
          const translateY = layer.y * layer.translateFactor;
          element.style.transform =
            `translate(${translateX}px, ${translateY}px)`;
          element.style.transition =
            mousePositionRef.current.x === 0 && mousePositionRef.current.y === 0
              ? "transform 0.5s ease-out"
              : "none"; // Remove transition for smoother animation
        }
      });

      // Continue animation loop
      animationFrameIdRef.current = requestAnimationFrame(animate);
    };

    // Start animation loop
    animationFrameIdRef.current = requestAnimationFrame(animate);

    // Cleanup animation frame on unmount
    return () => {
      if (animationFrameIdRef.current) {
        cancelAnimationFrame(animationFrameIdRef.current);
      }
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className="w-full bg-gray-50 rounded border border-gray-100 min-h-[192px] overflow-hidden relative"
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      dangerouslySetInnerHTML={{ __html: content }}
    />
  );
}

function CharmPreview(
  { charm, replicaName }: { charm: Cell<Charm>; replicaName: string },
) {
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

  const link = charm.getAsDocLink();
  link.path = ["$PREVIEW"];
  const preview = getCellFromDocLink({ uri: replicaName }, link);

  return (
    <CommonCard className="p-2 group relative" details>
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          if (
            globalThis.confirm("Are you sure you want to remove this charm?")
          ) {
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
            {(charm.get()[NAME] || "Unnamed Charm") +
              ` (#${charmId(charm)!.slice(-4)})`}
          </h3>
          {preview.get()
            ? (
              <>
                <ParallaxPreview content={String(preview.get())} />
                <style>
                  {`
                    svg { max-width: 100%; height: auto; }
                    #fg, #main, #bg { transform-origin: center center; }
                  `}
                </style>
              </>
            )
            : (
              <div
                ref={previewRef}
                className="w-full bg-gray-50 rounded border border-gray-100 min-h-[192px] pointer-events-none select-none"
              >
              </div>
            )}
        </div>
      </NavLink>
    </CommonCard>
  );
}

export default function CharmList() {
  const { replicaName } = useParams<{ replicaName: string }>();
  const { charmManager } = useCharmManager();
  const [charms] = useCell(charmManager.getCharms());
  const { isSyncing } = useSyncedStatus(charmManager);

  if (!isSyncing && (!charms || charms.length === 0)) {
    return (
      <div className="flex flex-col items-center justify-center h-[70vh] text-center p-8">
        <div className="mb-6">
          <ShapeLogo />
        </div>
        <h2 className="text-2xl font-semibold text-gray-800 mb-4">
          No charms here!
        </h2>
        <p className="text-gray-600 mb-6 max-w-md">
          Create your first charm by opening the command palette with{" "}
          <kbd className="px-2 py-1 bg-gray-100 border border-gray-300 rounded text-sm font-mono">
            {navigator.platform.indexOf("Mac") === 0 ? "⌘K" : "Ctrl+K"}
          </kbd>{" "}
          or by clicking the{" "}
          <span className="
              inline-flex items-center justify-center w-8 h-8 z-50
              border-2 border-grey shadow-[2px_2px_0px_0px_rgba(0,0,0,0.25)]
              bg-white
            ">
            <MdOutlineStar fill="grey" size={16} />
          </span>{" "}
          button.
        </p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8 p-8">
      {replicaName &&
        charms.map((charm) => (
          <CharmPreview
            key={charmId(charm)}
            charm={charm}
            replicaName={replicaName}
          />
        ))}
    </div>
  );
}
