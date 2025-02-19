import "@commontools/ui";

import { useCallback } from "react";
import { Outlet, useParams, useLocation } from "react-router-dom";
import { animated } from "@react-spring/web";
import { MdOutlineStar } from "react-icons/md";

import ShellHeader from "@/components/ShellHeader";
import { CommandCenter } from "@/components/CommandCenter";


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

  return (
    <div className="shell h-full bg-gray-50 border-2 border-black">
      <ShellHeader
        replicaName={replicaName}
        charmId={charmId}
        isDetailActive={isDetailActive}
        togglePath={togglePath}
      />

      <div className="relative h-full">
        <Outlet />
      </div>

      <animated.button
        className="
          flex items-center justify-center fixed bottom-2 right-2 w-12 h-12 z-50
          border-2 border-black shadow-[2px_2px_0px_0px_rgba(0,0,0,0.5)]
          hover:translate-y-[-2px] hover:shadow-[2px_2px_0px_0px_rgba(0,0,0,0.7)]
          transition-[border,box-shadow,transform] duration-100 ease-in-out
          bg-white cursor-pointer
        "
        onClick={onLaunchCommand}
      >
        <MdOutlineStar fill="black" size={24} />
      </animated.button>

      <CommandCenter />
    </div>
  );
}
