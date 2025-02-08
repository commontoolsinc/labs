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
  const previousReplicaRef = useRef<string | undefined>();

  useEffect(() => {

    const cleanup = effect(replica, (newReplica) => {
      // FIXME(ja): bug where effect calls multiple times even when replica 
      // hasn't changed can result in multiple charm managers being created
      // also this doesn't clean up the previous charm manager
      if (previousReplicaRef.current === newReplica) {
        return;
      }
      previousReplicaRef.current = newReplica;

      // Create new charm manager instance with updated replica
      const storageType = (import.meta as any).env.VITE_STORAGE_TYPE ?? "remote";
      const manager = new CharmManager(newReplica, storageType);
      manager.init();
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
