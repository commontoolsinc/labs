import React, { createContext, useContext, useEffect, useRef } from "react";
import { CharmManager } from "@commontools/charm";
import { replica } from "@/views/state";
import { effect } from "@commontools/runner";

export type CharmManagerContextType = {
  charmManager: CharmManager;
};

const CharmManagerContext = createContext<CharmManagerContextType>(null!);

const defaultManager = new CharmManager(undefined, "memory");

export const CharmsManagerProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [charmManager, setCharmManager] = React.useState<CharmManager>(defaultManager);

  useEffect(() => {
    const cleanup = effect(replica, (currentReplica) => {
      // Create new charm manager instance with updated replica
      const storageType = (import.meta as any).env.VITE_STORAGE_TYPE ?? "remote";
      const manager = new CharmManager(currentReplica, storageType);
      manager.init();
      console.log("Started CharmManager for replica " + currentReplica, manager);
      setCharmManager(manager);
    });

    return () => {
      cleanup();
    };
  }, [setCharmManager]);

  return (
    <CharmManagerContext.Provider value={{ charmManager: charmManager! }}>
      {children}
    </CharmManagerContext.Provider>
  );
};

export const useCharmManager = () => useContext(CharmManagerContext);
