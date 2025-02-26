import React, { createContext, useContext, useMemo } from "react";
import { SpaceManager } from "@commontools/charm";
import { useParams } from "react-router-dom";

export type SpaceManagerContextType = {
  spaceManager: SpaceManager;
  currentSpaceURI: string;
};

const SpaceManagerContext = createContext<SpaceManagerContextType>({
  spaceManager: null!,
  currentSpaceURI: undefined!,
});

export const CharmsManagerProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { replicaName: spaceId } = useParams<{ replicaName: string }>();

  console.log("SpaceManagerProvider", spaceId);

  let effectiveSpaceId: string;
  if (spaceId) {
    // When a replica is provided in the URL, use it and save it as the last visited
    effectiveSpaceId = spaceId;
    localStorage.setItem("@common/lastSpace", spaceId);
  } else {
    // Otherwise, pull the last visited replica from local storage.
    // Falling back to "common-knowledge" if nothing was stored.
    effectiveSpaceId = localStorage.getItem("@common/lastSpace") || "common-knowledge";
  }

  const spaceManager = useMemo(() => {
    return new SpaceManager(effectiveSpaceId);
  }, [effectiveSpaceId]);

  return (
    <SpaceManagerContext.Provider
      value={{ spaceManager: spaceManager, currentSpaceURI: effectiveSpaceId }}
    >
      {children}
    </SpaceManagerContext.Provider>
  );
};

export const useSpaceManager = () => useContext(SpaceManagerContext);
