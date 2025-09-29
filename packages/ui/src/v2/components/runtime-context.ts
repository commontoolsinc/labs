import { createContext } from "@lit/context";

// Runtime context for providing a runtime instance to UI components.
// The concrete type is intentionally loose to avoid coupling UI to
// shell internals. Providers can pass their runtime object, and
// consumers can narrow as needed.
export const runtimeContext = createContext<unknown>(
  Symbol("ct.runtime"),
);

