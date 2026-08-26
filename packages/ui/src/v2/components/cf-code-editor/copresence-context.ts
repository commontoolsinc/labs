/**
 * Host configuration context for the optional editor co-presence service.
 *
 * @module
 */

import { createContext } from "@lit/context";

/**
 * Supplies the default WebSocket service URL for descendant `cf-code-editor`
 * elements. An editor's explicit `presenceUrl` property takes precedence.
 */
export const copresenceUrlContext = createContext<string | undefined>(
  "cf-code-editor-copresence-url",
);
