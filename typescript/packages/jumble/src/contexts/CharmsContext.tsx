import React, { createContext, useContext, useState, useCallback } from "react";
import { type Charm } from "@commontools/lookslike-high-level";

export type CharmsContextType = {
  charms: Charm[];
  focusedCharm: Charm | null;
  addCharm: (charm: Charm) => void;
  removeCharm: (entityId: string) => void;
  runCharm: (charm: Charm) => Promise<void>;
};

const CharmsContext = createContext<CharmsContextType>(null!);

export const CharmsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [charms, setCharms] = useState<Charm[]>([]);
  const [focusedCharm, setFocusedCharm] = useState<Charm | null>(null);

  const addCharm = useCallback((charm: Charm) => {
    console.log("addCharm", charm);
    setCharms((prev) => {
      if (prev.some((c) => c.entityId === charm.entityId)) return prev;
      return [...prev, charm];
    });
    setFocusedCharm(charm);
  }, []);

  const removeCharm = useCallback((entityId: string) => {
    setCharms((prev) => prev.filter((c) => c.entityId !== entityId));
    setFocusedCharm((prev) => (prev?.entityId === entityId ? null : prev));
  }, []);

  const runCharm = useCallback(
    async (charm: Charm) => {
      // Stub: runs charm asynchronously and then adds it
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          addCharm(charm);
          resolve();
        }, 300);
      });
    },
    [addCharm],
  );

  return (
    <CharmsContext.Provider value={{ charms, focusedCharm, addCharm, removeCharm, runCharm }}>
      {children}
    </CharmsContext.Provider>
  );
};

export const useCharms = () => useContext(CharmsContext);
