import { useCharmManager } from "@/contexts/CharmManagerContext.tsx";
import { NAME } from "@commontools/builder";
import React, { useEffect } from "react";
import { NavLink } from "react-router-dom";
import { CharmLink } from "@/components/CharmLink.tsx";

type NavPathProps = {
  replicaId: string | undefined;
  charmId: string | undefined;
};

export function NavPath({ replicaId, charmId }: NavPathProps) {
  const { charmManager } = useCharmManager();

  const [charmName, setCharmName] = React.useState<string | null>("Loading...");

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
      setCharmName(" ");
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
              <CharmLink
                charm={{ "/": charmId }}
                replicaName={replicaId}
                showHash={false}
                className="text-gray-700 font-bold"
              >
                {charmName}
              </CharmLink>
            </li>
          </>
        )}
      </ol>
    </nav>
  );
}
