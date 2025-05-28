import { createContext, useContext, ReactNode } from "react";
import { Runtime } from "@commontools/runner";

interface RuntimeContextType {
  runtime: Runtime;
}

const RuntimeContext = createContext<RuntimeContextType | undefined>(undefined);

export function RuntimeProvider({ 
  children, 
  runtime 
}: { 
  children: ReactNode; 
  runtime: Runtime;
}) {
  return (
    <RuntimeContext.Provider value={{ runtime }}>
      {children}
    </RuntimeContext.Provider>
  );
}

export function useRuntime(): Runtime {
  const context = useContext(RuntimeContext);
  if (!context) {
    throw new Error("useRuntime must be used within a RuntimeProvider");
  }
  return context.runtime;
}