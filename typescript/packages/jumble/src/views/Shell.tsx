import "@commontools/ui";

import { useCallback, useEffect, useRef, useState } from "react";
import { Outlet, useParams, useLocation } from "react-router-dom";
import { animated } from "@react-spring/web";
import { MdOutlineStar, MdOutlineStorage } from "react-icons/md";

import ShellHeader from "@/components/ShellHeader";
import { CommandCenter } from "@/components/CommandCenter";
import { useAuthentication } from "@/contexts/AuthenticationContext";
import { AuthenticationView } from "@/views/AuthenticationView";
import { useCharmManager } from "@/contexts/CharmManagerContext";
import { useSyncedStatus } from "@/hooks/use-synced-status";
import StorageDebugPanel from "@/components/StorageDebugPanel";

export default function Shell() {
  const { charmId, replicaName } = useParams();
  const location = useLocation();
  const { 
    isStorageDebugVisible, 
    toggleStorageDebugVisibility, 
    refreshStorageDebugInfo 
  } = useCharmManager();
  
  // Use a ref to track the interval
  const intervalRef = useRef<number | null>(null);

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
  
  // Refresh debug info periodically when the panel is visible
  useEffect(() => {
    // Clear any existing interval when effect runs
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    
    if (isStorageDebugVisible) {
      // Initial refresh
      refreshStorageDebugInfo();
      
      // Set up interval
      intervalRef.current = window.setInterval(() => {
        refreshStorageDebugInfo();
      }, 1000);
    }
    
    // Cleanup function
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [isStorageDebugVisible, refreshStorageDebugInfo]);
  
  const { user } = useAuthentication();

  if (!user) {
    return <AuthenticationView />;
  }

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
        
        {/* Storage Debug Panel */}
        {isStorageDebugVisible && <StorageDebugPanel />}
      </div>

      {/* Command Button */}
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
      
      {/* Storage Debug Button */}
      <animated.button
        className="
          flex items-center justify-center fixed bottom-2 right-16 w-12 h-12 z-50
          border-2 border-black shadow-[2px_2px_0px_0px_rgba(0,0,0,0.5)]
          hover:translate-y-[-2px] hover:shadow-[2px_2px_0px_0px_rgba(0,0,0,0.7)]
          transition-[border,box-shadow,transform] duration-100 ease-in-out
          bg-white cursor-pointer
        "
        onClick={toggleStorageDebugVisibility}
      >
        <MdOutlineStorage fill="black" size={24} />
      </animated.button>

      <CommandCenter />
    </div>
  );
}
