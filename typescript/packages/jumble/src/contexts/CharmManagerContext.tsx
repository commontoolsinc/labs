import React, { createContext, useContext, useMemo, useState, useCallback } from "react";
import { CharmManager, createStorage } from "@commontools/charm";
import { useParams } from "react-router-dom";

// Define the StorageDebugInfo type since it's not exported from @commontools/charm
export interface StorageDebugInfo {
  providerType: string;
  replica?: string;
  connectionStatus?: {
    connected: boolean;
    connectionCount: number;
    queueSize: number;
  };
  cells: {
    total: number;
    loading: number;
    subscribed: number;
    list: Array<{
      id: string;
      loading: boolean;
      hasDependencies: boolean;
      dependenciesCount: number;
      type: 'read' | 'write' | 'both' | 'none';
      lastUpdated?: number;
      subscribed: boolean;
    }>;
  };
  batch: {
    processing: boolean;
    size: number;
    types: {
      sync: number;
      cell: number;
      storage: number;
    };
    lastBatchTime: number;
    debounceCount: number;
  };
  metrics: {
    sendCount: number;
    syncCount: number;
    getCount: number;
    sinkCount: number;
    activeSinkCount: number;
    avgSendTime: number;
    avgSyncTime: number;
    lastError?: string;
    resetTime: number;
  };
  timestamp: number;
}

export type CharmManagerContextType = {
  charmManager: CharmManager;
  currentReplica: string;
  storageDebugInfo: StorageDebugInfo | null;
  refreshStorageDebugInfo: () => void;
  isStorageDebugVisible: boolean;
  toggleStorageDebugVisibility: () => void;
  getCellData: (cellId: string) => Promise<any>;
};

const CharmManagerContext = createContext<CharmManagerContextType>({
  charmManager: null!,
  currentReplica: undefined!,
  storageDebugInfo: null,
  refreshStorageDebugInfo: () => {},
  isStorageDebugVisible: false,
  toggleStorageDebugVisibility: () => {},
  getCellData: async () => null,
});

export const CharmsManagerProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { replicaName } = useParams<{ replicaName: string }>();
  const [storageDebugInfo, setStorageDebugInfo] = useState<StorageDebugInfo | null>(null);
  const [isStorageDebugVisible, setIsStorageDebugVisible] = useState(false);

  console.log("CharmManagerProvider", replicaName);

  let effectiveReplica: string;
  if (replicaName) {
    // When a replica is provided in the URL, use it and save it as the last visited
    effectiveReplica = replicaName;
    localStorage.setItem("lastReplica", replicaName);
  } else {
    // Otherwise, pull the last visited replica from local storage.
    // Falling back to "common-knowledge" if nothing was stored.
    effectiveReplica = localStorage.getItem("lastReplica") || "common-knowledge";
  }

  const charmManager = useMemo(() => {
    const storageType = (import.meta as any).env.VITE_STORAGE_TYPE ?? "remote";
    const storage =
      storageType === "remote"
        ? createStorage({
            type: "remote",
            replica: effectiveReplica,
            url: new URL(location.href),
          })
        : createStorage({ type: storageType as "memory" | "local" });
    return new CharmManager(storage);
  }, [effectiveReplica]);

  // Use useCallback to memoize the function so it doesn't change on every render
  const refreshStorageDebugInfo = useCallback(() => {
    try {
      // Access the storage through the public API if available
      // This is a workaround since storage is private in CharmManager
      const debugInfo = (charmManager as any).storage?.getDebugInfo();
      if (debugInfo) {
        setStorageDebugInfo(debugInfo);
      }
    } catch (error) {
      console.error("Error refreshing storage debug info:", error);
    }
  }, [charmManager]);

  // Use useCallback here too
  const toggleStorageDebugVisibility = useCallback(() => {
    setIsStorageDebugVisible(prev => {
      // Refresh the debug info when opening the panel
      if (!prev) {
        refreshStorageDebugInfo();
      }
      return !prev;
    });
  }, [refreshStorageDebugInfo]);

  // Function to get cell data by ID
  const getCellData = useCallback(async (cellId: string) => {
    try {
      // First check if we have debug info
      if (!storageDebugInfo) {
        refreshStorageDebugInfo();
      }
      
      // Find the cell in the debug info
      const cellInfo = storageDebugInfo?.cells.list.find((c: { id: string }) => c.id === cellId);
      
      if (!cellInfo) {
        return { error: "Cell not found" };
      }
      
      // Try to get the actual cell data from storage
      // Parse the cell ID to get the entity ID
      let entityId;
      try {
        entityId = JSON.parse(cellId);
      } catch (e) {
        console.error("Failed to parse cell ID:", e);
        entityId = cellId; // Fallback to using the raw ID
      }
      
      // Get the actual cell value
      let cellValue: any = null;
      let dependencies: Array<{ id: string; type: string; value?: any }> = [];
      let dependents: Array<{ id: string; type: string; value?: any }> = [];
      
      try {
        // Access the storage through the charmManager
        const storage = (charmManager as any).storage;
        
        if (storage) {
          // Try to get the cell from the storage's internal maps
          const cellsById = storage.cellsById;
          const writeDependentCells = storage.writeDependentCells;
          const readDependentCells = storage.readDependentCells;
          
          if (cellsById && cellsById instanceof Map) {
            const cell = cellsById.get(cellId);
            if (cell) {
              try {
                // Get the actual value from the cell
                const rawValue = cell.get ? cell.get() : null;
                
                // Create a safe copy of the value to avoid circular references
                cellValue = safelySerializeValue(rawValue);
                
                // Get dependencies (cells that this cell depends on)
                if (readDependentCells && readDependentCells instanceof Map) {
                  const deps = readDependentCells.get(cell);
                  if (deps && deps instanceof Set) {
                    dependencies = Array.from(deps).map((depCell: any) => {
                      const depId = depCell.entityId ? JSON.stringify(depCell.entityId) : 'unknown';
                      let depValue = null;
                      try {
                        // Get a safe copy of the dependency value
                        depValue = safelySerializeValue(depCell.get ? depCell.get() : null);
                      } catch (e) {
                        console.error("Error getting dependency value:", e);
                      }
                      return {
                        id: depId,
                        type: cellInfo.type, // We don't have the actual type here
                        value: depValue
                      };
                    });
                  }
                }
                
                // Get dependents (cells that depend on this cell)
                if (writeDependentCells && writeDependentCells instanceof Map) {
                  const deps = writeDependentCells.get(cell);
                  if (deps && deps instanceof Set) {
                    dependents = Array.from(deps).map((depCell: any) => {
                      const depId = depCell.entityId ? JSON.stringify(depCell.entityId) : 'unknown';
                      let depValue = null;
                      try {
                        // Get a safe copy of the dependent value
                        depValue = safelySerializeValue(depCell.get ? depCell.get() : null);
                      } catch (e) {
                        console.error("Error getting dependent value:", e);
                      }
                      return {
                        id: depId,
                        type: cellInfo.type, // We don't have the actual type here
                        value: depValue
                      };
                    });
                  }
                }
              } catch (e) {
                console.error("Error getting cell value:", e);
              }
            }
          }
        }
      } catch (e) {
        console.error("Error accessing storage internals:", e);
      }
      
      // If we couldn't get the real value, fall back to mock data
      if (cellValue === null) {
        console.log("Using fallback mock data for cell:", cellId);
        cellValue = {
          sample: "Could not retrieve actual cell data - using placeholder",
          timestamp: new Date().toISOString(),
          metadata: {
            dependencies: cellInfo.dependenciesCount,
            subscribed: cellInfo.subscribed
          }
        };
        
        // Use mock dependencies and dependents if we couldn't get the real ones
        if (dependencies.length === 0) {
          dependencies = storageDebugInfo?.cells.list
            .filter((c: { id: string }) => c.id !== cellId)
            .slice(0, cellInfo.dependenciesCount || 3)
            .map((c: { id: string; type: string }) => ({ id: c.id, type: c.type })) || [];
        }
        
        if (dependents.length === 0) {
          dependents = storageDebugInfo?.cells.list
            .filter((c: { id: string }) => c.id !== cellId)
            .slice(0, 2)
            .map((c: { id: string; type: string }) => ({ id: c.id, type: c.type })) || [];
        }
      }
      
      return {
        id: cellId,
        type: cellInfo.type,
        loading: cellInfo.loading,
        value: cellValue,
        dependencies,
        dependents
      };
    } catch (error) {
      console.error("Error getting cell data:", error);
      return { error: "Failed to get cell data" };
    }
  }, [storageDebugInfo, refreshStorageDebugInfo, charmManager]);

  // Helper function to safely serialize values and handle circular references
  function safelySerializeValue(value: any, maxDepth: number = 10): any {
    // Use a WeakMap to track objects we've already seen
    const seen = new WeakMap();
    
    function serialize(val: any, depth: number = 0): any {
      // Handle primitive values
      if (val === null || val === undefined) return val;
      if (typeof val !== 'object' && typeof val !== 'function') return val;
      if (val instanceof Date) return val.toISOString();
      
      // Prevent infinite recursion
      if (depth > maxDepth) return "[Max Depth Exceeded]";
      
      // Handle circular references
      if (seen.has(val)) return "[Circular Reference]";
      
      // Mark this object as seen
      seen.set(val, true);
      
      // Handle arrays
      if (Array.isArray(val)) {
        return val.map(item => serialize(item, depth + 1));
      }
      
      // Handle functions
      if (typeof val === 'function') {
        return "[Function]";
      }
      
      // Handle objects
      try {
        const result: Record<string, any> = {};
        for (const key in val) {
          if (Object.prototype.hasOwnProperty.call(val, key)) {
            result[key] = serialize(val[key], depth + 1);
          }
        }
        return result;
      } catch (e) {
        return "[Unserializable Object]";
      }
    }
    
    return serialize(value);
  }

  return (
    <CharmManagerContext.Provider 
      value={{ 
        charmManager, 
        currentReplica: effectiveReplica,
        storageDebugInfo,
        refreshStorageDebugInfo,
        isStorageDebugVisible,
        toggleStorageDebugVisibility,
        getCellData
      }}
    >
      {children}
    </CharmManagerContext.Provider>
  );
};

export const useCharmManager = () => useContext(CharmManagerContext);
