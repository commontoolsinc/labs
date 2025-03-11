import React, { createContext, useContext, useEffect, useMemo } from "react";
import { CharmManager } from "@commontools/charm";
import { useNavigate, useParams } from "react-router-dom";
import { type CharmRouteParams } from "@/routes.ts";
import { useAuthentication } from "@/contexts/AuthenticationContext.tsx";
import { useMemo } from "react";

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
  const { replicaName: spaceName } = useParams<CharmRouteParams>();
  const { user } = useAuthentication();

  if (!spaceName) {
    throw new Error("No space name found, cannot create CharmManager");
  }
  if (!user) {
    throw new Error("No user found, cannot create CharmManager");
  }

  useEffect(() => {
    console.log("CharmManagerProvider", spaceName);

    // I have no idea what is this used by or what is it for, but I got a
    // feeling this is very brittle and perhaps need to be removed.
    if (spaceName) {
      localStorage.setItem("lastReplica", spaceName);
    }
  }, [spaceName]);

  const charmManager = useMemo(() => {
    console.log("CharmManagerProvider", spaceName);

    if (spaceName) {
      localStorage.setItem("lastReplica", spaceName);
    }

    return new CharmManager(spaceName, user);
  }, [spaceName, user]);

  return (
    <CharmManagerContext.Provider
      value={{ charmManager, currentReplica: spaceName }}
    >
      {children}
    </CharmManagerContext.Provider>
  );
};

export const useCharmManager = () => useContext(CharmManagerContext);
