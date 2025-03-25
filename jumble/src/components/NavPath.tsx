import { useCharmManager } from "@/contexts/CharmManagerContext.tsx";
import { NAME } from "@commontools/builder";
import React, { useEffect } from "react";
import { NavLink } from "react-router-dom";
import { CharmLink } from "@/components/CharmLink.tsx";
import { useTheme } from "@/contexts/ThemeContext.tsx";

type NavPathProps = {
  replicaId: string | undefined;
  charmId: string | undefined;
};

export function NavPath({ replicaId, charmId }: NavPathProps) {
  const { charmManager } = useCharmManager();
  const { isDarkMode } = useTheme();

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
            className={({ isActive }) =>
              isActive
                ? "text-black dark:text-dark-text-primary font-bold"
                : "text-gray-500 dark:text-dark-text-secondary"}
          >
            {replicaId}
          </NavLink>
        </li>

        {charmId && (
          <>
            <li>
              <span className="text-gray-500 dark:text-dark-text-secondary">
                /
              </span>
            </li>
            <li>
              <CharmLink
                charm={{ "/": charmId }}
                replicaName={replicaId}
                showHash={false}
                className="text-gray-700 dark:text-dark-text-primary font-bold"
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
