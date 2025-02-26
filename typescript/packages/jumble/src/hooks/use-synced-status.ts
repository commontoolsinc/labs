import { CharmManager } from "@commontools/charm";
import { useEffect, useState } from "react";

export function useSyncedStatus(charmManager: CharmManager, intervalMs = 5000) {
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSyncTime, setLastSyncTime] = useState<Date | null>(null);
  useEffect(() => {
    let isMounted = true;
    let isCheckingSync = false;

    const checkSyncStatus = async () => {
      if (!isMounted || isCheckingSync) return;

      isCheckingSync = true;
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
        isCheckingSync = false;
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
