import "@commontools/ui";
import { useLocation, useParams } from "react-router-dom";
import { MdEdit, MdOutlineStar, MdShare } from "react-icons/md";

import { useAction } from "@/contexts/ActionManagerContext.tsx";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useCharmManager } from "@/contexts/CharmManagerContext.tsx";
import { NAME } from "@commontools/builder";

export function useGlobalActions() {
  const { charmId, replicaName } = useParams();
  const location = useLocation();

  const isDetailActive = location.pathname.endsWith("/detail");
  const togglePath = isDetailActive
    ? `/${replicaName}/${charmId}`
    : `/${replicaName}/${charmId}/detail`;

  // Command palette action (always available)
  useAction(
    useMemo(
      () => ({
        id: "command-palette",
        label: "Commands",
        icon: <MdOutlineStar fill="black" size={28} />,
        onClick: () => {
          window.dispatchEvent(new CustomEvent("open-command-center"));
        },
        priority: 100,
      }),
      [],
    ),
  );

  const hasCharmId = useCallback(() => Boolean(charmId), [charmId]);

  const { charmManager } = useCharmManager();
  const [charmName, setCharmName] = useState<string | null>(null);
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

  useAction(
    useMemo(
      () => ({
        id: "publish",
        label: "Publish",
        icon: <MdShare fill="black" size={28} />,
        onClick: () => {
          window.dispatchEvent(
            new CustomEvent("publish-charm", {
              detail: { charmId, charmName },
            }),
          );
        },
        predicate: hasCharmId,
        priority: 100,
      }),
      [hasCharmId, charmId, charmName],
    ),
  );

  // Edit action (conditional)
  useAction(
    useMemo(
      () => ({
        id: "link:edit-charm",
        label: "Edit",
        icon: <MdEdit size={28} />,
        to: togglePath,
        onClick: () => {},
        predicate: hasCharmId,
        priority: 50,
      }),
      [hasCharmId, togglePath],
    ),
  );
}
