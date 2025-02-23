import React, { createContext, useContext, useMemo } from "react";
import { CharmManager, createStorage } from "@commontools/charm";
import { useParams } from "react-router-dom";

export type CharmManagerContextType = {
  charmManager: CharmManager;
  currentReplica: string;
};

const CharmManagerContext = createContext<CharmManagerContextType>(null!);

export const CharmsManagerProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { replicaName } = useParams<{ replicaName: string }>();

  // Save the current replica as the last visited
  if (replicaName) {
    localStorage.setItem("lastReplica", replicaName);
  }

  const charmManager = useMemo(() => {
    const storageType = (import.meta as any).env.VITE_STORAGE_TYPE ?? "remote";
    const storage =
      storageType === "remote"
        ? createStorage({
            type: "remote",
            replica: replicaName!,
            url: new URL(location.href),
          })
        : createStorage({ type: storageType as "memory" | "local" });
    return new CharmManager(storage);
  }, [replicaName]);

  return (
    <CharmManagerContext.Provider value={{ charmManager, currentReplica: replicaName! }}>
      {children}
    </CharmManagerContext.Provider>
  );
};

export const useCharmManager = () => useContext(CharmManagerContext);
