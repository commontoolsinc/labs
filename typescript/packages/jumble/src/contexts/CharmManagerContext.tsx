import React, { createContext, useContext, useMemo } from "react";
import { CharmManager, createStorage } from "@commontools/charm";
import { useParams } from "react-router-dom";

export type CharmManagerContextType = {
  charmManager: CharmManager;
  currentReplica: string;
};

const CharmManagerContext = createContext<CharmManagerContextType>({
  charmManager: null!,
  currentReplica: undefined!,
});

export const CharmsManagerProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { replicaName } = useParams<{ replicaName: string }>();

  console.log("CharmManagerProvider", replicaName);

  let effectiveReplica: string;
  if (replicaName) {
    // When a replica is provided in the URL, use it and save it as the last visited
    effectiveReplica = replicaName;
    localStorage.setItem("lastReplica", replicaName);
  } else {
    // Otherwise, pull the last visited replica from local storage.
    // Falling back to "common-knowledge" if nothing was stored.
    effectiveReplica = localStorage.getItem("lastReplica") || "common-knowledge";
  }

  const charmManager = useMemo(() => {
    const storageType = (import.meta as any).env.VITE_STORAGE_TYPE ?? "remote";
    const storage =
      storageType === "remote"
        ? createStorage({
            type: "remote",
            replica: effectiveReplica,
            url: new URL(location.href),
          })
        : createStorage({ type: storageType as "memory" | "local" });
    return new CharmManager(storage);
  }, [effectiveReplica]);

  return (
    <CharmManagerContext.Provider value={{ charmManager, currentReplica: effectiveReplica }}>
      {children}
    </CharmManagerContext.Provider>
  );
};

export const useCharmManager = () => useContext(CharmManagerContext);
