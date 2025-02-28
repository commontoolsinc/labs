import React, { createContext, useContext, useMemo } from "react";
import { CharmManager } from "@commontools/charm";
import { useParams } from "react-router-dom";

export type CharmManagerContextType = {
  charmManager: CharmManager;
  currentReplica: string;
};

const CharmManagerContext = createContext<CharmManagerContextType>({
  charmManager: null!,
  currentReplica: undefined!,
});

export const CharmsManagerProvider: React.FC<{ children: React.ReactNode }> = (
  { children },
) => {
  const { replicaName } = useParams<{ replicaName: string }>();
  const [effectiveReplica, setEffectiveReplica] = React.useState<string>(
    () => localStorage.getItem("lastReplica") || "common-knowledge",
  );

  React.useEffect(() => {
    console.log("CharmManagerProvider", replicaName);

    if (replicaName) {
      // When a replica is provided in the URL, use it and save it as the last visited
      setEffectiveReplica(replicaName);
      localStorage.setItem("lastReplica", replicaName);
    }
  }, [replicaName]);

  const charmManager = useMemo(() => {
    return new CharmManager(effectiveReplica);
  }, [effectiveReplica]);

  return (
    <CharmManagerContext.Provider
      value={{ charmManager, currentReplica: effectiveReplica }}
    >
      {children}
    </CharmManagerContext.Provider>
  );
};

export const useCharmManager = () => useContext(CharmManagerContext);
