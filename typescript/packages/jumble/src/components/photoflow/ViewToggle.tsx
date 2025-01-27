import { ViewType } from "@/types/photoflow";

interface ViewToggleProps {
  view: ViewType;
  setView: (view: ViewType) => void;
  showTimeline?: boolean;
}

export default function ViewToggle({ view, setView, showTimeline = false }: ViewToggleProps) {
  return (
    <div className="inline-flex rounded-lg border bg-white shadow-sm">
      <button
        onClick={() => setView("grid")}
        className={`px-3 py-2 text-sm rounded-l-lg ${
          view === "grid"
            ? "bg-gray-100 text-gray-900 font-medium"
            : "text-gray-600 hover:text-gray-900"
        }`}
      >
        Grid
      </button>
      <button
        onClick={() => setView("table")}
        className={`px-3 py-2 text-sm border-l ${
          view === "table"
            ? "bg-gray-100 text-gray-900 font-medium"
            : "text-gray-600 hover:text-gray-900"
        } ${showTimeline ? "" : "rounded-r-lg"}`}
      >
        Table
      </button>
      {showTimeline && (
        <button
          onClick={() => setView("timeline")}
          className={`px-3 py-2 text-sm rounded-r-lg border-l ${
            view === "timeline"
              ? "bg-gray-100 text-gray-900 font-medium"
              : "text-gray-600 hover:text-gray-900"
          }`}
        >
          Timeline
        </button>
      )}
    </div>
  );
}
