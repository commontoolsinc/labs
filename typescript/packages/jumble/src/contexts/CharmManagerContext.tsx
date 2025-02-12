import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { CharmManager } from "@commontools/charm";
import { useParams } from "react-router-dom";
import { createStorage } from "@commontools/charm";

export type CharmManagerContextType = {
  charmManager: CharmManager;
  currentReplica: string;
};

const CharmManagerContext = createContext<CharmManagerContextType>(null!);

const defaultManager = new CharmManager(createStorage({ type: "memory" }));

export const CharmsManagerProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { replicaName } = useParams<{ replicaName: string }>();
  const effectiveReplica = replicaName || "common-knowledge";

  const [charmManager, setCharmManager] = useState<CharmManager>(defaultManager);
  const previousReplicaRef = useRef<string | undefined>();

  useEffect(() => {
    if (previousReplicaRef.current === effectiveReplica) {
      return;
    }
    previousReplicaRef.current = effectiveReplica;

    // Create new charm manager instance with updated replica
    const storageType = (import.meta as any).env.VITE_STORAGE_TYPE ?? "remote";
    const storage = storageType === "remote" ?
      createStorage({ type: "remote", replica: effectiveReplica, url: new URL(location.href) }) :
      createStorage({ type: storageType as "memory" | "local" });
    const manager = new CharmManager(storage);
    setCharmManager(manager);
  }, [effectiveReplica]);

  return (
    <CharmManagerContext.Provider value={{ charmManager, currentReplica: effectiveReplica }}>
      {children}
    </CharmManagerContext.Provider>
  );
};

export const useCharmManager = () => useContext(CharmManagerContext);
