import { CharmManager } from "@commontools/charm";
import { useEffect, useState } from "react";

export function useSyncedStatus(charmManager: CharmManager, intervalMs = 3000) {
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSyncTime, setLastSyncTime] = useState<Date | null>(null);

  useEffect(() => {
    let isMounted = true;

    const checkSyncStatus = async () => {
      if (!isMounted) return;

      setIsSyncing(true);
      try {
        await charmManager.synced();
        if (isMounted) {
          setLastSyncTime(new Date());
        }
      } catch (error) {
        console.error("Sync error:", error);
      } finally {
        if (isMounted) {
          setIsSyncing(false);
        }
      }
    };

    // Initial check
    checkSyncStatus();

    // Set up polling interval
    const intervalId = setInterval(checkSyncStatus, intervalMs);

    return () => {
      isMounted = false;
      clearInterval(intervalId);
    };
  }, [charmManager, intervalMs]);

  return { isSyncing, lastSyncTime };
}
