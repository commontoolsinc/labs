import type {
  IRemoteStorageProviderSettings,
  IStorageManager,
} from "./interface.ts";
import { StorageManager as RemoteStorageManager } from "./cache.ts";
import { StorageManager as DenoStorageManager } from "./cache.deno.ts";
import { NewStorageManager } from "../storage-new/manager.ts";

/**
 * Returns true if ENABLE_NEW_STORAGE looks enabled in the environment.
 * Safe in environments without env permission.
 */
function isNewStorageEnabled(): boolean {
  try {
    const v = Deno.env.get("ENABLE_NEW_STORAGE");
    if (!v) return false;
    const s = v.toLowerCase();
    return s === "1" || s === "true" || s === "on";
  } catch {
    return false;
  }
}

/**
 * Open the default storage manager for remote operation (WS/HTTP backed).
 * When ENABLE_NEW_STORAGE is set, this will later return the new adapter.
 * For now, it returns the existing remote StorageManager to preserve behavior.
 */
export function openRemote(options: {
  as: unknown;
  address: URL;
  id?: string;
  settings?: IRemoteStorageProviderSettings;
  /** Optional base API url for new storage (e.g., http://localhost:8002). */
  apiUrl?: URL;
}): IStorageManager {
  if (isNewStorageEnabled()) {
    // For now, wrap the existing manager with a placeholder NewStorageManager
    const legacy = (RemoteStorageManager as unknown as {
      open: (o: typeof options) => IStorageManager;
    }).open(options);
    // Derive API URL from env if not provided
    const apiUrl = (() => {
      if (options.apiUrl) return options.apiUrl;
      try {
        const v = Deno.env.get("API_URL");
        if (v) return new URL(v);
      } catch {
        // ignore env access failures
      }
      return undefined;
    })();
    const logLevel = (() => {
      try {
        const v = Deno.env.get("LOG_LEVEL");
        if (!v) return undefined;
        const s = v.toLowerCase();
        return (s === "off" || s === "error" || s === "warn" || s === "info" ||
            s === "debug")
          ? s
          : undefined;
      } catch {
        return undefined;
      }
    })();
    return new NewStorageManager(legacy, { apiUrl, logLevel } as any);
  }
  return (RemoteStorageManager as unknown as {
    open: (o: typeof options) => IStorageManager;
  }).open(options);
}

/**
 * Open an emulated storage manager (in-process, for CLIs/tests).
 * When ENABLE_NEW_STORAGE is set, this will later return the new adapter.
 * For now, it returns the existing emulated StorageManager.
 */
export function emulate(
  options: { as: unknown; id?: string },
): IStorageManager {
  if (isNewStorageEnabled()) {
    const legacy = (DenoStorageManager as unknown as {
      emulate: (o: { as: unknown; id?: string }) => IStorageManager;
    }).emulate(options);
    return new NewStorageManager(legacy);
  }
  return (DenoStorageManager as unknown as {
    emulate: (o: { as: unknown; id?: string }) => IStorageManager;
  }).emulate(options);
}

export const storageFactory = {
  isNewStorageEnabled,
  openRemote,
  emulate,
};
