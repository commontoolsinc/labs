import { createContext } from "@lit/context";
import type { MemorySpace, Runtime } from "@commontools/runner";

export const runtimeContext = createContext<Runtime | undefined>("runtime");
export const spaceContext = createContext<MemorySpace | undefined>("space");
