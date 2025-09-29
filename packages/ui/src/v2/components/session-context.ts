import { createContext } from "@lit/context";

/**
 * Minimal session details UI components may need without coupling to shell.
 */
export interface UISessionInfo {
  spaceName?: string;
  identityDid?: string;
  apiUrl?: URL;
}

export const sessionContext = createContext<UISessionInfo>(
  Symbol("ct.session-info"),
);

export type { UISessionInfo as SessionInfo };

