import React, { createContext, useContext, useEffect, useState } from "react";
import { CharmManager } from "@commontools/charm";
import { useNavigate, useParams } from "react-router-dom";
import { useAuthentication } from "./AuthenticationContext.tsx";
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
  const { replicaName: spaceName } = useParams<{ replicaName: string }>();
  const { user } = useAuthentication();

  useEffect(() => {
    console.log("CharmManagerProvider", spaceName);

    // I have no idea what is this used by or what is it for, but I got a
    // feeling this is very brittle and perhaps need to be removed.
    if (spaceName) {
      localStorage.setItem("lastReplica", spaceName);
    }
  }, [spaceName]);

  console.log(user);

  const charmManager = useMemo(
    () =>
      user
        ? new CharmManager(
          user.did(),
          user,
        )
        : null,
    [user],
  );

  return (
    <CharmManagerContext.Provider
      value={{ charmManager, currentReplica: spaceName || "" }}
    >
      {children}
    </CharmManagerContext.Provider>
  );
};

export const useCharmManager = () => useContext(CharmManagerContext);
