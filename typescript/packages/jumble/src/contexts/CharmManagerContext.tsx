import React, { createContext, useContext, useMemo } from "react";
import { CharmManager, createStorage, type Charm } from "@commontools/charm";
import { useParams } from "react-router-dom";
import { iterateCharm, fixItCharm } from "@/utils/charm-operations";

export type CharmManagerContextType = {
  charmManager: CharmManager;
  currentReplica: string;
  iterate: typeof iterateCharm;
  fixIt: typeof fixItCharm;
};

const CharmManagerContext = createContext<CharmManagerContextType>(null!);

export const CharmsManagerProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { replicaName } = useParams<{ replicaName: string }>();

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

  const contextValue = useMemo(
    () => ({
      charmManager,
      currentReplica: effectiveReplica,
      iterate: (
        charmManager: CharmManager,
        focusedCharmId: string,
        focusedReplicaId: string,
        input: string,
        variants: boolean,
        preferredModel?: string,
      ) =>
        iterateCharm(
          charmManager,
          focusedCharmId,
          focusedReplicaId,
          input,
          variants,
          preferredModel,
        ),
      fixIt: (charm: Charm, error: Error, model?: string) =>
        fixItCharm(charmManager, charm, error, model),
    }),
    [charmManager, effectiveReplica],
  );

  return (
    <CharmManagerContext.Provider value={contextValue}>{children}</CharmManagerContext.Provider>
  );
};

export const useCharmManager = () => useContext(CharmManagerContext);
