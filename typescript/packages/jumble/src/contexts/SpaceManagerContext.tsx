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
  const [effectiveSpaceId, setEffectiveSpaceId] = React.useState<string>(
    () => localStorage.getItem("@common:lastSpaceId") || "common-knowledge",
  );

  React.useEffect(() => {
    console.log("SpaceManagerProvider", spaceId);

    if (spaceId) {
      // When a replica is provided in the URL, use it and save it as the last visited
      setEffectiveSpaceId(spaceId);
      localStorage.setItem("@common:lastSpaceId", spaceId);
    }
  }, [spaceId]);

  const spaceManager = useMemo(() => {
    return new SpaceManager(effectiveSpaceId);
  }, [effectiveSpaceId]);

  return (
    <SpaceManagerContext.Provider value={{ spaceManager, currentSpaceURI: effectiveSpaceId }}>
      {children}
    </SpaceManagerContext.Provider>
  );
};

export const useSpaceManager = () => useContext(SpaceManagerContext);
