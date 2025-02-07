import { useCell } from "@/hooks/use-charm";
import { NavLink } from "react-router-dom";
import { NAME, UI } from "@commontools/builder";
import { useCharmManager } from "@/contexts/CharmManagerContext";

function charmId(charm: Charm) {
  if (typeof charm.cell.entityId['/'] === 'string') {
    return charm.cell.entityId['/'];
  } else {
    return charm.cell.toJSON()['/'];
  }
}

export default function CharmList() {``
  console.log("CharmList");
  const { charmManager } = useCharmManager();
  const [charms] = useCell(charmManager.getCharms());

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8 p-8">
      {charms.map((charm, index) => (
        <div
          key={index}
          className="bg-white border border-gray-100 rounded-lg overflow-hidden cursor-pointer hover:border-gray-300 transition-colors duration-200"
        >
          <NavLink to={`/charm/${charmId(charm)}`}>
            <div className="p-4">
              <h3 className="text-xl font-semibold text-gray-800 mb-4">
                {charm.cell.get()[NAME] || "Unnamed Charm"}
              </h3>
              <div className="w-full bg-gray-50 rounded border border-gray-100 p-3">
                <pre className="w-full h-24 overflow-hidden whitespace-pre-wrap text-xs text-gray-500">
                  {JSON.stringify(charm.cell.get()[UI], null, 2)}
                </pre>
              </div>
            </div>
          </NavLink>
        </div>
      ))}
    </div>
  );
}
