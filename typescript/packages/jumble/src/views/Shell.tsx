import "@commontools/ui";

import { useCallback, useEffect, useState } from "react";
import { Outlet, useParams, useLocation, NavLink } from "react-router-dom";
import { animated } from "@react-spring/web";
import { MdOutlineStar } from "react-icons/md";

import ShellHeader from "@/components/ShellHeader.tsx";
import { CommandCenter } from "@/components/CommandCenter.tsx";
import { useAuthentication } from "@/contexts/AuthenticationContext.tsx";
import { AuthenticationView } from "@/views/AuthenticationView.tsx";
import { useCharmManager } from "@/contexts/CharmManagerContext";
import { useSyncedStatus } from "@/hooks/use-synced-status";
import { LuPencil } from "react-icons/lu";

export default function Shell() {
  const { charmId, replicaName } = useParams();
  const location = useLocation();

  // TOOLBAR START
  // NOTE(jake): We will want to move this into a Toolbar component at some point
  const isDetailActive = location.pathname.endsWith("/detail");
  const togglePath = isDetailActive
    ? `/${replicaName}/${charmId}`
    : `/${replicaName}/${charmId}/detail`;
  // TOOLBAR END

  const onLaunchCommand = useCallback(() => {
    window.dispatchEvent(new CustomEvent("open-command-center"));
  }, []);

  const { user } = useAuthentication();

  if (!user) {
    return <AuthenticationView />;
  }

  return (
    <div className="flex flex-col shell h-full bg-gray-50 border-2 border-black">
      <ShellHeader
        replicaName={replicaName}
        charmId={charmId}
        isDetailActive={isDetailActive}
        togglePath={togglePath}
      />

      <div className="relative h-full">
        <Outlet />
      </div>

      <div className="fixed bottom-2 right-2 z-50 flex flex-row gap-2">
        {charmId && (
          <NavLink
            to={togglePath}
            className={`
              flex items-center justify-center w-12 h-12
              border-2 border-black shadow-[2px_2px_0px_0px_rgba(0,0,0,0.5)]
              hover:translate-y-[-2px] hover:shadow-[2px_2px_0px_0px_rgba(0,0,0,0.7)]
              transition-[border,box-shadow,transform] duration-100 ease-in-out
              bg-white cursor-pointer relative group
              ${isDetailActive ? "bg-gray-200" : ""}
              touch-action-manipulation tap-highlight-color-transparent
            `}
            style={{ touchAction: "manipulation", WebkitTapHighlightColor: "transparent" }}
          >
            <LuPencil size={20} />
            <div className="absolute top-[-40px] left-1/2 -translate-x-1/2 bg-gray-800 text-white px-2 py-1 rounded text-sm opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
              Edit
            </div>
          </NavLink>
        )}

        <animated.button
          className="
            flex items-center justify-center w-12 h-12
            border-2 border-black shadow-[2px_2px_0px_0px_rgba(0,0,0,0.5)]
            hover:translate-y-[-2px] hover:shadow-[2px_2px_0px_0px_rgba(0,0,0,0.7)]
            transition-[border,box-shadow,transform] duration-100 ease-in-out
            bg-white cursor-pointer
            touch-action-manipulation tap-highlight-color-transparent
          "
          style={{ touchAction: "manipulation", WebkitTapHighlightColor: "transparent" }}
          onClick={onLaunchCommand}
        >
          <MdOutlineStar fill="black" size={28} />
        </animated.button>
      </div>

      <CommandCenter />
    </div>
  );
}
