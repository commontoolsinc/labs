import "@commontools/ui";
import { Outlet, useParams, useLocation } from "react-router-dom";
import { MdEdit, MdOutlineStar, MdShare } from "react-icons/md";
import { LuPencil } from "react-icons/lu";

import ShellHeader from "@/components/ShellHeader.tsx";
import { CommandCenter } from "@/components/CommandCenter.tsx";
import { useAuthentication } from "@/contexts/AuthenticationContext.tsx";
import { AuthenticationView } from "@/views/AuthenticationView.tsx";
import { ActionBar } from "@/components/ActionBar";
import { useAction } from "@/contexts/ActionManagerContext";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CharmPublisher } from "@/components/Publish";
import { useCharmManager } from "@/contexts/CharmManagerContext";
import { NAME } from "@commontools/builder";

function useActions() {
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

export default function Shell() {
  const { charmId, replicaName } = useParams();
  useActions();
  const { user } = useAuthentication();

  if (!user) {
    return <AuthenticationView />;
  }

  return (
    <div className="flex flex-col shell h-full bg-gray-50 border-2 border-black">
      <ShellHeader replicaName={replicaName} charmId={charmId} />

      <div className="relative h-full">
        <Outlet />
      </div>

      <ActionBar />
      <CharmPublisher />
      <CommandCenter />
    </div>
  );
}
