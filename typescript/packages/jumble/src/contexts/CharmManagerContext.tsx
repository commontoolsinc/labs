import React, { createContext, useContext } from "react";
import { CharmManager } from "@commontools/charm";
import { useParams } from "react-router-dom";
import { createStorage } from "@commontools/charm";

export type CharmManagerContextType = {
  charmManager: CharmManager;
  currentReplica: string;
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

  // NOTE(ja): disable switching replicas until
  // https://github.com/commontoolsinc/labs/issues/377 is fixed
  // const [charmManager, setCharmManager] = useState<CharmManager>(defaultManager);
  // const previousReplicaRef = useRef<string | undefined>();

  // useEffect(() => {
  //   if (previousReplicaRef.current === effectiveReplica) {
  //     return;
  //   }
  //   previousReplicaRef.current = effectiveReplica;

  // Create new charm manager instance with updated replica
  const storageType = (import.meta as any).env.VITE_STORAGE_TYPE ?? "remote";
  const storage = storageType === "remote" ?
    createStorage({ type: "remote", replica: effectiveReplica, url: new URL(location.href) }) :
    createStorage({ type: storageType as "memory" | "local" });
  const charmManager = new CharmManager(storage);
  // setCharmManager(manager);
  // }, [effectiveReplica]);

  return (
    <CharmManagerContext.Provider value={{ charmManager, currentReplica: effectiveReplica }}>
      {children}
    </CharmManagerContext.Provider>
  );
};

export const useCharmManager = () => useContext(CharmManagerContext);
