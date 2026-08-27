import { createContext } from "@lit/context";
import type { RuntimeClient } from "@commonfabric/runtime-client";
import { DID } from "@commonfabric/identity";

export const runtimeContext = createContext<RuntimeClient | undefined>(
  "runtime",
);
export const spaceContext = createContext<DID | undefined>("space");

/** Optional host default for ephemeral editor co-presence WebSockets. */
export const presenceUrlContext = createContext<string | undefined>(
  "presence-url",
);
