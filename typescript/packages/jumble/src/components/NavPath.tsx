import { useCharmManager } from "@/contexts/CharmManagerContext";
import { NAME } from "@commontools/builder";
import React, { useEffect } from "react";
import { NavLink } from "react-router-dom";

type NavPathProps = {
  replicaId: string;
  charmId: string | null;
};

export function NavPath({ replicaId, charmId }: NavPathProps) {
  const { charmManager } = useCharmManager();

  const [charmName, setCharmName] = React.useState<string | null>(null);

  useEffect(() => {
    async function getCharm() {
      if (charmId) {
        const charm = await charmManager.get(charmId);
        if (charm) {
          setCharmName(charm.getAsQueryResult()[NAME]);
        }
      }
    }
    getCharm();
  }, [charmId, charmManager]);

  return (
    <nav className="flex" aria-label="Breadcrumb">
      <ol className="inline-flex items-center space-x-3 text-md gap-2">
        <li>
          <NavLink to={`/${replicaId}`} className="text-gray-700 hover:text-gray-900">
            {replicaId}
          </NavLink>
        </li>

        {charmId && (
          <>
            <li>
              <span className="text-gray-500">/</span>
            </li>
            <li>
              <span className="text-gray-700">{charmName}</span>
            </li>
          </>
        )}
      </ol>
    </nav>
  );
}
