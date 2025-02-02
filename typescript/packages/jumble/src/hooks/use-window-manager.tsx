import { createContext, useContext, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";

type Charm = {
  entityId: string;
  name: string;
  ui: React.ReactNode;
  recipeId?: string;
  minimized?: boolean;
};

type WindowManagerContextType = {
  charms: Charm[];
  focusedCharm: Charm | null;
  openCharm: (charmId: string | Charm, data?: any) => Promise<void>;
  closeCharm: (charmId: string) => void;
  syncCharm: (charmId: string) => Promise<void>;
};

const WindowManagerContext = createContext<WindowManagerContextType>(null!);

export function WindowManagerProvider({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();

  const [charms, setCharms] = useState<Charm[]>([]);
  const [focusedCharm, setFocusedCharm] = useState<Charm | null>(null);

  const openCharm = useCallback(async (charmId: string | Charm, data?: any) => {
    // Simplified version of original syncCharm/openCharm logic
    const charm = typeof charmId === "string" ? await fetchCharm(charmId) : charmId;

    setCharms((prev) => {
      const exists = prev.some((c) => c.entityId === charm.entityId);
      return exists ? prev : [...prev, charm];
    });

    setFocusedCharm(charm);
    navigate(`/charm/${charm.entityId}`);
  }, []);

  const closeCharm = useCallback((entityId: string) => {
    setCharms((prev) => prev.filter((c) => c.entityId !== entityId));
    setFocusedCharm((prev) => (prev?.entityId === entityId ? null : prev));
  }, []);

  return (
    <WindowManagerContext.Provider
      value={{ charms, focusedCharm, openCharm, closeCharm, syncCharm }}
    >
      {children}
    </WindowManagerContext.Provider>
  );
}

export const useWindowManager = () => useContext(WindowManagerContext);
