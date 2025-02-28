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
  const { replicaName: spaceURI } = useParams<{ replicaName: string }>();
  const [effectiveSpaceURI, setEffectiveSpaceURI] = React.useState<string>(
    () => localStorage.getItem("@common:lastSpaceURI") || "common-knowledge",
  );

  React.useEffect(() => {
    console.log("SpaceManagerProvider", spaceURI);

    if (spaceURI) {
      // When a replica is provided in the URL, use it and save it as the last visited
      setEffectiveSpaceURI(spaceURI);
      localStorage.setItem("@common:lastSpaceURI", spaceURI);
    }
  }, [spaceURI]);

  const spaceManager = useMemo(() => {
    return new SpaceManager(effectiveSpaceURI);
  }, [effectiveSpaceURI]);

  return (
    <SpaceManagerContext.Provider value={{ spaceManager, currentSpaceURI: effectiveSpaceURI }}>
      {children}
    </SpaceManagerContext.Provider>
  );
};

export const useSpaceManager = () => useContext(SpaceManagerContext);
