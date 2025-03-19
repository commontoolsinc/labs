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
import { Cell } from "@commontools/runner";
import ShapeLogo from "@/assets/ShapeLogo.tsx";
import { MdOutlineStar } from "react-icons/md";
import { useSyncedStatus } from "@/contexts/SyncStatusContext.tsx";
import { CharmRenderer } from "@/components/CharmRunner.tsx";
import { CharmLink } from "@/components/CharmLink.tsx";
import { HoverPreview } from "@/components/HoverPreview.tsx";

export interface CommonDataEvent extends CustomEvent {
  detail: {
    data: any[];
  };
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

  return (
    <CommonCard className="p-2 group relative" details>
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          charmManager.remove({ "/": charmId(charm)! });
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
          <div
            ref={previewRef}
            className="w-full bg-gray-50 rounded border border-gray-100 min-h-[192px] pointer-events-none select-none"
          >
          </div>
        </div>
      </NavLink>
    </CommonCard>
  );
}

interface CharmTableProps {
  charms: Cell<Charm>[];
  replicaName: string;
  charmManager: any;
}

const CharmTable = (
  { charms, replicaName, charmManager }: CharmTableProps,
) => {
  const [hoveredCharm, setHoveredCharm] = useState<string | null>(null);
  const [previewPosition, setPreviewPosition] = useState({ x: 0, y: 0 });
  const [selectedCharms, setSelectedCharms] = useState<string[]>([]);
  // Use a ref to cache the last hovered charm to prevent thrashing
  const hoveredCharmRef = useRef<string | null>(null);
  const hoveredCharmInstance = charms.find((c) => charmId(c) === hoveredCharm);

  const handleMouseMove = (e: React.MouseEvent, id: string) => {
    // Only update state if the hovered charm has changed
    if (hoveredCharmRef.current !== id) {
      hoveredCharmRef.current = id;
      setHoveredCharm(id);
    }

    // Position the preview card relative to the cursor
    setPreviewPosition({
      x: e.clientX + 20, // offset to the right of cursor
      y: e.clientY - 100, // offset above the cursor
    });
  };

  const handleMouseLeave = () => {
    hoveredCharmRef.current = null;
    setHoveredCharm(null);
  };

  const toggleCharmSelection = (id: string) => {
    setSelectedCharms((prev) =>
      prev.includes(id)
        ? prev.filter((charmId) => charmId !== id)
        : [...prev, id]
    );
  };

  const handleMoveToTrash = async () => {
    if (selectedCharms.length === 0) return;

    if (
      confirm(
        `Are you sure you want to move ${selectedCharms.length} charm${
          selectedCharms.length > 1 ? "s" : ""
        } to trash?`,
      )
    ) {
      // Process each selected charm
      for (const id of selectedCharms) {
        await charmManager.remove({ "/": id });
      }
      // Clear selection after moving to trash
      setSelectedCharms([]);
    }
  };

  const selectAllCharms = () => {
    if (selectedCharms.length === charms.length) {
      // If all are selected, deselect all
      setSelectedCharms([]);
    } else {
      // Otherwise select all
      setSelectedCharms(charms.map((charm) => charmId(charm)!));
    }
  };

  return (
    <div className="
      border border-black shadow-[4px_4px_0px_0px_rgba(0,0,0,0.5)] rounded-[4px] transition-all
      transition-[border,box-shadow,transform] duration-100 ease-in-out
      group relative
    ">
      {selectedCharms.length > 0 && (
        <div className="bg-gray-100 p-4 border-b flex justify-between items-center">
          <div className="text-sm">
            {selectedCharms.length}{" "}
            charm{selectedCharms.length !== 1 ? "s" : ""} selected
          </div>
          <button
            type="button"
            onClick={handleMoveToTrash}
            className="px-4 py-2 bg-red-500 text-white rounded hover:bg-red-600 transition-colors"
          >
            Move {selectedCharms.length} to Trash
          </button>
        </div>
      )}
      <div className="overflow-hidden w-full rounded-[4px]">
        <table className="w-full text-sm text-left text-gray-500 rounded-[4px]">
          <thead className="text-xs text-gray-700 uppercase bg-gray-50">
            <tr>
              <th scope="col" className="px-6 py-3">
                <input
                  type="checkbox"
                  className="h-4 w-4"
                  onChange={selectAllCharms}
                  checked={selectedCharms.length > 0 &&
                    selectedCharms.length === charms.length}
                />
              </th>
              <th scope="col" className="px-6 py-3">Name</th>
              <th scope="col" className="px-6 py-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {charms.map((charm) => {
              const id = charmId(charm);
              const name = charm.get()[NAME] || "Unnamed Charm";
              const isSelected = selectedCharms.includes(id!);

              return (
                <tr
                  key={id}
                  className={`bg-white border-b hover:bg-gray-50 relative ${
                    isSelected ? "bg-blue-50" : ""
                  }`}
                  onMouseMove={(e) => handleMouseMove(e, id!)}
                  onMouseLeave={handleMouseLeave}
                >
                  <td className="px-6 py-4">
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      checked={isSelected}
                      onChange={() => toggleCharmSelection(id!)}
                    />
                  </td>
                  <td className="px-6 py-4 font-medium text-gray-900">
                    <CharmLink charm={charm} showHash className="font-medium" />
                  </td>
                  <td className="px-6 py-4">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        charmManager.remove({ "/": id! });
                      }}
                      className="text-gray-400 hover:text-red-500 transition-colors"
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
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {hoveredCharm && hoveredCharmInstance && (
        <HoverPreview
          charm={hoveredCharmInstance}
          position={previewPosition}
          replicaName={replicaName}
        />
      )}
    </div>
  );
};

export default function CharmList() {
  const { replicaName } = useParams<{ replicaName: string }>();
  const { charmManager } = useCharmManager();
  const [pinned] = useCell(charmManager.getPinned());
  const [charms] = useCell(charmManager.getCharms());
  const [trash] = useCell(charmManager.getTrash());

  const { lastSyncTime } = useSyncedStatus();

  if (lastSyncTime == null) {
    return <div>Trying to connect, please wait</div>;
  }

  if (!charms || charms.length === 0) {
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
    <div className="p-2">
      <h1 className="text-2xl font-bold">Pinned</h1>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8 p-8">
        {replicaName && pinned &&
          pinned.map((charm) => (
            <CharmPreview
              key={charmId(charm)}
              charm={charm}
              replicaName={replicaName}
            />
          ))}
      </div>
      <h1 className="text-2xl font-bold">All Charms</h1>
      <div className="p-8">
        {replicaName && charms && (
          <CharmTable
            charms={charms}
            replicaName={replicaName}
            charmManager={charmManager}
          />
        )}
      </div>

      <details className="mb-4">
        <summary className="text-2xl font-bold cursor-pointer">
          Trash
        </summary>
        <div className="p-8">
          {replicaName && trash && trash.length > 0
            ? (
              <>
                <div className="mb-4 flex justify-end">
                  <button
                    onClick={async () => {
                      if (
                        confirm(
                          "Are you sure you want to empty the trash? This action cannot be undone.",
                        )
                      ) {
                        await charmManager.emptyTrash();
                      }
                    }}
                    className="px-4 py-2 bg-red-500 text-white rounded hover:bg-red-600 transition-colors"
                    type="button"
                  >
                    Empty Trash
                  </button>
                </div>
                <CharmTable
                  charms={trash}
                  replicaName={replicaName}
                  charmManager={charmManager}
                />
              </>
            )
            : <div className="text-gray-500 italic">Trash is empty</div>}
        </div>
      </details>
    </div>
  );
}
