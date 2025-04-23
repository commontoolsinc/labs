import { Charm, charmId } from "@commontools/charm";
import { useState } from "react";
import { Cell } from "@commontools/runner";
import { useCharmHover } from "@/hooks/use-charm-hover.ts";
import CharmLink from "@/components/CharmLink.tsx";

interface ActionConfig {
  buttonAction: (ids: string[]) => Promise<void>;
  buttonText: string;
  buttonColor: string;
  buttonHoverColor: string;
  buttonIcon: React.ReactNode;
}

type ViewMode = "trash" | "standard";

interface CharmTableProps {
  charms: Cell<Charm>[];
  replicaName: string;
  charmManager: any;
  viewMode?: ViewMode;
}

const TrashIcon = () => (
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
);

const RestoreIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
  >
    <path d="M3 12h18M12 3v18" />
  </svg>
);

export const CharmTable = ({
  charms,
  charmManager,
  viewMode = "standard",
}: CharmTableProps) => {
  const [selectedCharms, setSelectedCharms] = useState<string[]>([]);
  const isTrashView = viewMode === "trash";

  const toggleCharmSelection = (id: string) => {
    setSelectedCharms((prev) =>
      prev.includes(id)
        ? prev.filter((charmId) => charmId !== id)
        : [...prev, id]
    );
  };

  const handleBulkRestore = async (ids: string[]) => {
    if (ids.length === 0) return;

    const confirmMessage =
      `Are you sure you want to restore ${ids.length} charm${
        ids.length > 1 ? "s" : ""
      } from trash?`;

    if (confirm(confirmMessage)) {
      for (const id of ids) {
        await charmManager.restoreFromTrash({ "/": id });
      }
      setSelectedCharms([]);
    }
  };

  const handleBulkTrash = async (ids: string[]) => {
    if (ids.length === 0) return;

    const confirmMessage = `Are you sure you want to move ${ids.length} charm${
      ids.length > 1 ? "s" : ""
    } to trash?`;

    if (confirm(confirmMessage)) {
      for (const id of ids) {
        await charmManager.remove({ "/": id });
      }
      setSelectedCharms([]);
    }
  };

  const actionConfigs: Record<ViewMode, ActionConfig> = {
    "trash": {
      buttonAction: handleBulkRestore,
      buttonText: "Restore",
      buttonColor: "bg-green-500",
      buttonHoverColor: "hover:bg-green-600",
      buttonIcon: <RestoreIcon />,
    },
    "standard": {
      buttonAction: handleBulkTrash,
      buttonText: "Move to Trash",
      buttonColor: "bg-red-500",
      buttonHoverColor: "hover:bg-red-600",
      buttonIcon: <TrashIcon />,
    },
  };

  const bulkAction = actionConfigs[viewMode];

  const renderActionButton = (id: string) => {
    const buttonConfig = isTrashView
      ? {
        action: () => charmManager.restoreFromTrash({ "/": id }),
        className: "text-gray-400 hover:text-green-500 transition-colors",
        icon: <RestoreIcon />,
      }
      : {
        action: () => charmManager.remove({ "/": id }),
        className: "text-gray-400 hover:text-red-500 transition-colors",
        icon: <TrashIcon />,
      };

    return (
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          buttonConfig.action();
        }}
        className={buttonConfig.className}
      >
        {buttonConfig.icon}
      </button>
    );
  };

  const selectAllCharms = () => {
    setSelectedCharms(
      selectedCharms.length === charms.length
        ? []
        : charms.map((charm) => charmId(charm)!),
    );
  };

  const allSelected = selectedCharms.length > 0 &&
    selectedCharms.length === charms.length;
  const pluralSuffix = selectedCharms.length !== 1 ? "s" : "";

  return (
    <div className="
      border border-black shadow-[4px_4px_0px_0px_rgba(0,0,0,0.5)] rounded-[4px] transition-all
      transition-[border,box-shadow,transform] duration-100 ease-in-out
      group relative
    ">
      {selectedCharms.length > 0 && (
        <div className="bg-gray-100 p-4 border-b flex justify-between items-center">
          <div className="text-sm">
            {selectedCharms.length} charm{pluralSuffix} selected
          </div>
          <button
            type="button"
            onClick={() => bulkAction.buttonAction(selectedCharms)}
            className={`px-4 py-2 ${bulkAction.buttonColor} text-white rounded ${bulkAction.buttonHoverColor} transition-colors`}
          >
            {bulkAction.buttonText} {selectedCharms.length}
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
                  checked={allSelected}
                />
              </th>
              <th scope="col" className="px-6 py-3">Name</th>
              <th scope="col" className="px-6 py-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {charms.map((charm) => {
              const id = charmId(charm);
              const isSelected = selectedCharms.includes(id!);

              return (
                <tr
                  key={id}
                  className={`bg-white border-b hover:bg-gray-50 relative ${
                    isSelected ? "bg-blue-50" : ""
                  }`}
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
                    {renderActionButton(id!)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};
