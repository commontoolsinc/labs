import type { MemorySpace, URI } from "./interface.ts";
import type { IStorageSubscription } from "./interface.ts";

/**
 * Memory v2 address format. Unlike v1 addresses, v2 addresses do not
 * include a media type field -- the path within the space is sufficient
 * to locate data.
 */
export interface IV2MemoryAddress {
  id: URI;
  space: MemorySpace;
  path: readonly string[];
}

/**
 * Type alias for the notification sink used by v2 storage operations.
 * Re-uses the existing IStorageSubscription interface.
 */
export type IStorageNotificationSink = IStorageSubscription;
