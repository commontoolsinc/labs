import React, { createContext, useContext, useMemo } from "react";
import { CharmManager } from "@commontools/charm";
import { CharmRouteParams, useParams } from "react-router-dom";
import { useAuthentication } from "./AuthenticationContext.tsx";

export type CharmManagerContextType = {
  charmManager: CharmManager | null;
  currentReplica: string;
};

const CharmManagerContext = createContext<CharmManagerContextType>({
  charmManager: null,
  currentReplica: "",
});

export const CharmsManagerProvider: React.FC<{ children: React.ReactNode }> = (
  { children },
) => {
  const { replicaName } = useParams<CharmRouteParams>();
  const { user } = useAuthentication();

  const charmManager = useMemo(() => {
    console.log("CharmManagerProvider", replicaName);

    if (replicaName) {
      localStorage.setItem("lastReplica", replicaName);
    }
    return user && replicaName ? new CharmManager(replicaName, user) : null;
  }, [replicaName, user]);

  return (
    <CharmManagerContext.Provider
      value={{ charmManager, currentReplica: replicaName || "" }}
    >
      {children}
    </CharmManagerContext.Provider>
  );
};

export const useCharmManager = () => useContext(CharmManagerContext);
