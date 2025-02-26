import React from "react";
import { useCharmManager } from "@/contexts/CharmManagerContext";

const StorageDebugPanel: React.FC = () => {
  const { storageDebugInfo, refreshStorageDebugInfo, toggleStorageDebugVisibility } = useCharmManager();

  if (!storageDebugInfo) {
    return (
      <div className="fixed top-16 right-0 w-96 h-[calc(100vh-4rem)] bg-white border-l-2 border-black p-4 overflow-auto z-40">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg font-bold">Storage Debug</h2>
          <button 
            className="px-2 py-1 bg-gray-200 hover:bg-gray-300 rounded"
            onClick={toggleStorageDebugVisibility}
          >
            Close
          </button>
        </div>
        <p>Loading debug information...</p>
        <button 
          className="mt-4 px-3 py-1 bg-blue-500 text-white rounded hover:bg-blue-600"
          onClick={refreshStorageDebugInfo}
        >
          Refresh
        </button>
      </div>
    );
  }

  return (
    <div className="fixed top-16 right-0 w-96 h-[calc(100vh-4rem)] bg-white border-l-2 border-black p-4 overflow-auto z-40">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-lg font-bold">Storage Debug</h2>
        <div>
          <button 
            className="px-2 py-1 bg-blue-500 text-white rounded hover:bg-blue-600 mr-2"
            onClick={refreshStorageDebugInfo}
          >
            Refresh
          </button>
          <button 
            className="px-2 py-1 bg-gray-200 hover:bg-gray-300 rounded"
            onClick={toggleStorageDebugVisibility}
          >
            Close
          </button>
        </div>
      </div>
      
      <section className="mb-4 p-3 border border-gray-300 rounded">
        <h3 className="font-bold mb-2">Provider: {storageDebugInfo.providerType}</h3>
        <p className="text-sm">Replica: {storageDebugInfo.replica || "none"}</p>
        {storageDebugInfo.connectionStatus && (
          <div className="mt-2 text-sm">
            <p>Connected: {storageDebugInfo.connectionStatus.connected ? "Yes" : "No"}</p>
            <p>Connection Count: {storageDebugInfo.connectionStatus.connectionCount}</p>
            <p>Queue Size: {storageDebugInfo.connectionStatus.queueSize}</p>
          </div>
        )}
      </section>
      
      <section className="mb-4 p-3 border border-gray-300 rounded">
        <h3 className="font-bold mb-2">Batch Processing</h3>
        <div className="text-sm">
          <p>Processing: {storageDebugInfo.batch.processing ? "Yes" : "No"}</p>
          <p>Size: {storageDebugInfo.batch.size}</p>
          <p>
            Types: Sync: {storageDebugInfo.batch.types.sync}, 
            Cell: {storageDebugInfo.batch.types.cell}, 
            Storage: {storageDebugInfo.batch.types.storage}
          </p>
          <p>Last Batch: {new Date(storageDebugInfo.batch.lastBatchTime).toLocaleTimeString()}</p>
          <p>Debounce Count: {storageDebugInfo.batch.debounceCount}</p>
        </div>
      </section>
      
      <section className="mb-4 p-3 border border-gray-300 rounded">
        <h3 className="font-bold mb-2">Metrics</h3>
        <div className="text-sm">
          <p>Send Count: {storageDebugInfo.metrics.sendCount}</p>
          <p>Sync Count: {storageDebugInfo.metrics.syncCount}</p>
          <p>Get Count: {storageDebugInfo.metrics.getCount}</p>
          <p>Sink Count: {storageDebugInfo.metrics.sinkCount}</p>
          <p>Active Sinks: {storageDebugInfo.metrics.activeSinkCount}</p>
          <p>Avg Send Time: {storageDebugInfo.metrics.avgSendTime.toFixed(2)}ms</p>
          <p>Avg Sync Time: {storageDebugInfo.metrics.avgSyncTime.toFixed(2)}ms</p>
          {storageDebugInfo.metrics.lastError && (
            <p className="text-red-500">Last Error: {storageDebugInfo.metrics.lastError}</p>
          )}
          <p className="text-xs text-gray-500">
            Reset: {new Date(storageDebugInfo.metrics.resetTime).toLocaleTimeString()}
          </p>
        </div>
      </section>
      
      <section className="mb-4">
        <div className="flex justify-between items-center mb-2">
          <h3 className="font-bold">Cells ({storageDebugInfo.cells.total})</h3>
          <span className="text-sm bg-yellow-100 px-2 py-0.5 rounded">
            Loading: {storageDebugInfo.cells.loading}
          </span>
        </div>
        
        <div className="max-h-64 overflow-auto border border-gray-300 rounded">
          <table className="w-full text-xs">
            <thead className="bg-gray-100 sticky top-0">
              <tr>
                <th className="p-1 text-left">ID</th>
                <th className="p-1 text-left">Status</th>
                <th className="p-1 text-left">Type</th>
                <th className="p-1 text-left">Deps</th>
                <th className="p-1 text-left">Updated</th>
              </tr>
            </thead>
            <tbody>
              {storageDebugInfo.cells.list.map(cell => (
                <tr key={cell.id} className={cell.loading ? "bg-yellow-50" : ""}>
                  <td className="p-1 truncate max-w-[100px]" title={cell.id}>{cell.id}</td>
                  <td className="p-1">{cell.loading ? "Loading" : "Loaded"}</td>
                  <td className="p-1">{cell.type}</td>
                  <td className="p-1">{cell.dependenciesCount}</td>
                  <td className="p-1">
                    {cell.lastUpdated 
                      ? new Date(cell.lastUpdated).toLocaleTimeString() 
                      : "N/A"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      
      <div className="text-xs text-gray-500 text-right">
        Updated: {new Date(storageDebugInfo.timestamp).toLocaleTimeString()}
      </div>
    </div>
  );
};

export default StorageDebugPanel; 