import React, { createContext, useContext, useEffect, useState } from "react";
import { CharmManager } from "@commontools/charm";
import { useParams } from "react-router-dom";
import { useAuthentication } from "./AuthenticationContext.tsx";
import { Identity } from "../../../identity/src/index.ts";
import { useMemo } from "react";

export type CharmManagerContextType = {
  charmManager: CharmManager | null;
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
  const { root } = useAuthentication();
  const [user, setUser] = useState<Identity>();

  useEffect(() => {
    console.log("CharmManagerProvider", replicaName);

    // 😅 Maybe we can let this go
    if (replicaName) {
      localStorage.setItem("lastReplica", replicaName);
    }

    if (root && replicaName) {
      root.derive(replicaName).then(setUser, (error) => {
        console.error(`💥 Space key derivation failed`, error);
      });
    }
  }, [replicaName, root]);

  const charmManager = useMemo(
    () => user ? new CharmManager(replicaName!, user) : null,
    [user],
  );

  return (
    <CharmManagerContext.Provider
      value={{ charmManager, currentReplica: replicaName || "" }}
    >
      {children}
    </CharmManagerContext.Provider>
  );
};

export const useCharmManager = () => useContext(CharmManagerContext);
