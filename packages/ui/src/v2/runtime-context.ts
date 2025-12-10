import { createContext } from "@lit/context";
import type { RuntimeWorker } from "@commontools/runner/worker";
import { DID } from "@commontools/identity";

export const runtimeContext = createContext<RuntimeWorker | undefined>(
  "runtime",
);
export const spaceContext = createContext<DID | undefined>("space");
