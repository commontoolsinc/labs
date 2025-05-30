import React, { createContext, useContext, useMemo } from "react";
import { CharmManager } from "@commontools/charm";
import { useParams } from "react-router-dom";
import { type CharmRouteParams } from "@/routes.ts";
import { useAuthentication } from "@/contexts/AuthenticationContext.tsx";
import { useRuntime } from "@/contexts/RuntimeContext.tsx";

export type CharmManagerContextType = {
  charmManager: CharmManager;
  currentReplica: string;
};

const CharmManagerContext = createContext<CharmManagerContextType>({
  charmManager: null!,
  currentReplica: "",
});

export const CharmsManagerProvider: React.FC<{ children: React.ReactNode }> = (
  { children },
) => {
  const { replicaName } = useParams<CharmRouteParams>();
  const { session } = useAuthentication();
  const runtime = useRuntime();

  if (!replicaName) {
    throw new Error("No space name found, cannot create CharmManager");
  }
  if (!session) {
    throw new Error(
      "Not authorization session found, cannot create CharmManager",
    );
  }

  const charmManager = useMemo(() => {
    console.log("CharmManagerProvider", replicaName);

    if (replicaName) {
      localStorage.setItem("lastReplica", replicaName);
    }

    return new CharmManager(session, runtime);
  }, [replicaName, session, runtime]);

  return (
    <CharmManagerContext.Provider
      value={{ charmManager, currentReplica: replicaName }}
    >
      {children}
    </CharmManagerContext.Provider>
  );
};

export const useCharmManager = () => useContext(CharmManagerContext);
