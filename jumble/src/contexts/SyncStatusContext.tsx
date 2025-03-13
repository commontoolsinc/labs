import React, {
  createContext,
  ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useCharmManager } from "@/contexts/CharmManagerContext.tsx";

interface SyncStatusContextType {
  isSyncing: boolean;
  lastSyncTime: Date | null;
}

const SyncStatusContext = createContext<SyncStatusContextType | undefined>(
  undefined,
);

interface SyncStatusProviderProps {
  children: ReactNode;
  intervalMs?: number;
}

export function SyncStatusProvider({
  children,
  intervalMs = 50,
}: SyncStatusProviderProps) {
  const [isSyncing, setIsSyncing] = useState(true);
  const [lastSyncTime, setLastSyncTime] = useState<Date | null>(null);
  const { charmManager } = useCharmManager();
  const isCheckingSyncRef = useRef(false);

  useEffect(() => {
    console.log("sync status useEffect", charmManager);
    let isMounted = true;

    const checkSyncStatus = async () => {
      console.log("check sync status", {
        charmManager,
        isMounted,
        isCheckingSyncRef,
      });
      if (!isMounted || isCheckingSyncRef.current || !charmManager) return;

      isCheckingSyncRef.current = true;
      setIsSyncing(true);

      try {
        console.log("sync status provider");
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
        isCheckingSyncRef.current = false;
      }
    };

    // Initial check
    checkSyncStatus();

    // Set up polling interval - now we only have one shared interval
    const intervalId = setInterval(checkSyncStatus, intervalMs);

    return () => {
      isMounted = false;
      clearInterval(intervalId);
    };
  }, [charmManager, intervalMs]);

  const value = { isSyncing, lastSyncTime };

  return (
    <SyncStatusContext.Provider value={value}>
      {children}
    </SyncStatusContext.Provider>
  );
}

// Hook to use the sync status
export function useSyncedStatus() {
  const context = useContext(SyncStatusContext);

  if (context === undefined) {
    throw new Error("useSyncedStatus must be used within a SyncStatusProvider");
  }

  return context;
}
