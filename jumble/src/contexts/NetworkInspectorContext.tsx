import React, { createContext, ReactNode, useContext } from "react";
import { useNetworkInspector } from "@/hooks/use-network-inspector.ts";

interface NetworkInspectorContextType {
  visible: boolean;
  toggleVisibility: (value?: boolean) => void;
  show: () => void;
  hide: () => void;
}

const NetworkInspectorContext = createContext<
  NetworkInspectorContextType | null
>(null);

export function NetworkInspectorProvider(
  { children }: { children: ReactNode },
) {
  const inspector = useNetworkInspector();

  return (
    <NetworkInspectorContext.Provider value={inspector}>
      {children}
    </NetworkInspectorContext.Provider>
  );
}

export function useNetworkInspectorContext() {
  const context = useContext(NetworkInspectorContext);
  if (!context) {
    throw new Error(
      "useNetworkInspectorContext must be used within a NetworkInspectorProvider",
    );
  }
  return context;
}
