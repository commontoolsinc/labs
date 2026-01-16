import { createContext } from "@lit/context";
import type { RuntimeClient } from "@commontools/runtime-client";
import { DID } from "@commontools/identity";

export const runtimeContext = createContext<RuntimeClient | undefined>(
  "runtime",
);
export const spaceContext = createContext<DID | undefined>("space");
