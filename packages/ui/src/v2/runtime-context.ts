import { createContext } from "@lit/context";
import type { IRuntime, MemorySpace } from "@commontools/runner";

export const runtimeContext = createContext<IRuntime | undefined>("runtime");
export const spaceContext = createContext<MemorySpace | undefined>("space");
