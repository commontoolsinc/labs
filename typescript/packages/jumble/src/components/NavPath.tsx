import { useSpaceManager } from "@/contexts/SpaceManagerContext";
import { NAME } from "@commontools/builder";
import React, { useEffect } from "react";
import { NavLink } from "react-router-dom";

type NavPathProps = {
  replicaId: string | undefined;
  charmId: string | undefined;
};

export function NavPath({ replicaId, charmId }: NavPathProps) {
  const { spaceManager: charmManager } = useSpaceManager();

  const [charmName, setCharmName] = React.useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    let cancel: (() => void) | undefined;

    async function getCharm() {
      if (charmId) {
        const charm = await charmManager.get(charmId);
        cancel = charm?.key(NAME).sink((value) => {
          if (mounted) setCharmName(value ?? null);
        });
      }
    }
    getCharm();

    return () => {
      mounted = false;
      cancel?.();
    };
  }, [charmId, charmManager]);

  return (
    <nav className="flex" aria-label="Breadcrumb">
      <ol className="inline-flex items-center space-x-3 text-md gap-2">
        <li>
          <NavLink
            to={`/${replicaId}`}
            className={charmId ? "text-gray-500" : "text-black font-bold"}
          >
            {replicaId}
          </NavLink>
        </li>

        {charmId && (
          <>
            <li>
              <span className="text-gray-500">/</span>
            </li>
            <li>
              <NavLink to={`/${replicaId}/${charmId}`} className="text-gray-700 font-bold">
                {charmName}
              </NavLink>
            </li>
          </>
        )}
      </ol>
    </nav>
  );
}
