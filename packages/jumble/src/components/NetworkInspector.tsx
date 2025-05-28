import * as Inspector from "@commontools/runner/storage/inspector";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useResizableDrawer } from "@/hooks/use-resizeable-drawer.ts";
import JsonViewImport from "@uiw/react-json-view";
import { githubDarkTheme } from "@uiw/react-json-view/githubDark";
import { useRuntime } from "@/contexts/RuntimeContext.tsx";
// Type assertion to help TypeScript understand this is a valid React component
const JsonView: React.FC<{
  value: any;
  style: any;
  collapsed?: number | boolean;
}> = JsonViewImport as any;
import { useAnimationSmoothing } from "@/hooks/use-animation-smoothing.ts";

// Custom hooks
export function useStorageBroadcast(
  scope: string,
  callback: (data: Inspector.BroadcastCommand) => void,
) {
  useEffect(() => {
    const channel = new Inspector.Channel(scope, callback);
    return () => channel.close();
  }, [scope, callback]);
}

export function useStatusMonitor() {
  const status = useRef(Inspector.create());

  const updateStatus = useCallback((command: Inspector.BroadcastCommand) => {
    if (!status.current) {
      throw new Error("Status is not initialized");
    }
    const state = Inspector.update(status.current, command);
    status.current = state;
  }, []);

  return { status, updateStatus };
}

// Example usage with dummy data
export const DummyModelInspector: React.FC = () => {
  const runtime = useRuntime();
  const { status, updateStatus } = useStatusMonitor();
  useStorageBroadcast(runtime.id, updateStatus);
  if (!status.current) return null;

  return <ModelInspector model={status.current} />;
};

const NETWORK_INSPECTOR_OPEN = "networkInspectorOpen";

export const ToggleableNetworkInspector: React.FC<
  { fullscreen?: boolean; visible: boolean }
> = (
  { visible, fullscreen = false },
) => {
  const runtime = useRuntime();
  const { status, updateStatus } = useStatusMonitor();
  const scope = fullscreen ? "" : runtime.id;
  useStorageBroadcast(scope, updateStatus);

  if (!visible || !status.current) return null;

  const initiallyOpen = localStorage.getItem(NETWORK_INSPECTOR_OPEN) === "true";

  return (
    <ModelInspector
      model={status.current}
      initiallyOpen={initiallyOpen}
      fullscreen={fullscreen}
    />
  );
};
const ModelInspector: React.FC<
  { model: Inspector.Model; initiallyOpen?: boolean; fullscreen?: boolean }
> = ({ model, initiallyOpen = false, fullscreen = false }) => {
  const [isOpen, setIsOpen] = useState(initiallyOpen);
  const [activeTab, setActiveTab] = useState<"actions" | "subscriptions">(
    "actions",
  );
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [filterText, setFilterText] = useState("");
  const [, setRenderTrigger] = useState(0);
  const lastRenderTimeRef = useRef(0);
  const buttonTextRef = useRef<HTMLSpanElement>(null);

  // Use our animation smoothing hook
  const { updateValue, getValue, rafRef } = useAnimationSmoothing();

  // Persist inspector status across sessions.
  useEffect(() => {
    localStorage.setItem(NETWORK_INSPECTOR_OPEN, String(isOpen));
  }, [isOpen]);

  // Set up render loop with requestAnimationFrame when inspector is open
  useEffect(() => {
    if (!isOpen) {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      return;
    }

    const renderLoop = () => {
      const now = performance.now();
      // Limit to ~10 FPS when not actively receiving updates
      if (now - lastRenderTimeRef.current > 100) {
        setRenderTrigger((prev) => (prev + 1) % 1000); // Force re-render
        lastRenderTimeRef.current = now;
      }
      rafRef.current = requestAnimationFrame(renderLoop);
    };

    rafRef.current = requestAnimationFrame(renderLoop);

    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [isOpen, rafRef]);

  // Update button text with counts using requestAnimationFrame
  useEffect(() => {
    const updateCounts = () => {
      if (!buttonTextRef.current) {
        rafRef.current = requestAnimationFrame(updateCounts);
        return;
      }

      // Count calculations
      const actualPushCount = Object.values(model.push).filter((v) =>
        v.ok
      ).length;
      const actualPullCount =
        Object.values(model.pull).filter((v) => v.ok).length;
      const pushErrorCount =
        Object.values(model.push).filter((v) => v.error).length;
      const pullErrorCount =
        Object.values(model.pull).filter((v) => v.error).length;
      const actualErrorCount = pushErrorCount + pullErrorCount;

      // Update values with easing
      const pushResult = updateValue("push", actualPushCount);
      const pullResult = updateValue("pull", actualPullCount);
      const errorResult = updateValue("error", actualErrorCount);

      // Create status text
      const statusParts = [];
      if (pushResult.value > 0) statusParts.push(`↑${pushResult.value}`);
      if (pullResult.value > 0) statusParts.push(`↓${pullResult.value}`);
      if (errorResult.value > 0) statusParts.push(`!${errorResult.value}`);

      const statusText = statusParts.length > 0
        ? `Inspector ${statusParts.join(" ")} ${isOpen ? "▼" : "▲"}`
        : `Inspector ${isOpen ? "▼" : "▲"}`;

      buttonTextRef.current.textContent = statusText;

      // Continue animation
      rafRef.current = requestAnimationFrame(updateCounts);
    };

    // Start updating counts
    rafRef.current = requestAnimationFrame(updateCounts);

    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, [model, isOpen, updateValue, rafRef]);

  const formatTime = (time: number) => {
    const date = new Date(time);
    return `${date.toLocaleTimeString()}.${
      date.getMilliseconds().toString().padStart(3, "0")
    }`;
  };

  const toggleRowExpand = (id: string) => {
    setExpandedRows((prev) => {
      const newSet = new Set(prev);
      prev.has(id) ? newSet.delete(id) : newSet.add(id);
      return newSet;
    });
  };

  const connectionStatus = () => {
    if (model.connection.pending) {
      return model.connection.pending.ok
        ? (
          <span className="text-blue-500">
            Conn: A{model.connection.pending.ok.attempt}
          </span>
        )
        : (
          <span className="text-red-500">
            Err: {model.connection.pending.error?.message}
          </span>
        );
    }
    return (
      <span className="text-green-500">
        Conn: A{model.connection.ready?.ok?.attempt}
      </span>
    );
  };

  // Helper function to extract changes fields from transaction
  const extractTransactionDetails = (result: any) => {
    try {
      if (
        result.ok?.invocation?.cmd === "/memory/transact" &&
        result.ok?.invocation?.args?.changes
      ) {
        const changes = result.ok.invocation.args.changes;
        // Extract of, the, cause
        const ofs = Object.keys(changes);
        if (ofs.length > 0) {
          const of = ofs[0];
          const thes = Object.keys(changes[of]);
          if (thes.length > 0) {
            const the = thes[0];
            const causes = Object.keys(changes[of][the]);
            if (causes.length > 0) {
              const cause = causes[0];
              return { of, the, cause };
            }
          }
        }
      }
      return null;
    } catch (e) {
      return null;
    }
  };

  const getActionItems = useCallback(() => {
    const pushItems = Object.entries(model.push).map(([id, result]) => ({
      id,
      type: "push",
      result,
      time: result.error?.time || model.connection.time,
      details: extractTransactionDetails(result),
      hasError: !!result.error,
    }));

    const pullItems = Object.entries(model.pull).map(([id, result]) => ({
      id,
      type: "pull",
      result,
      time: result.error?.time || model.connection.time,
      details: null, // pulls don't have of/the/cause
      hasError: !!result.error,
    }));

    const items = [...pushItems, ...pullItems].sort((a, b) => b.time - a.time);

    if (!filterText) return items;

    try {
      const regex = new RegExp(filterText, "i");
      return items.filter((item) => {
        return regex.test(item.id) ||
          regex.test(item.type) ||
          regex.test(JSON.stringify(item.result));
      });
    } catch (e) {
      // If regex is invalid, fallback to simple string search
      return items.filter((item) => {
        const itemStr = JSON.stringify(item);
        return itemStr.toLowerCase().includes(filterText.toLowerCase());
      });
    }
  }, [model, filterText]);

  // Define helper functions for filtering to avoid circular dependencies
  const filterItems = useCallback((items: any[], filter: string) => {
    try {
      const regex = new RegExp(filter, "i");
      return items.filter((item) => {
        return regex.test(item.id) ||
          regex.test(item.type) ||
          regex.test(JSON.stringify(item.result));
      });
    } catch (e) {
      // If regex is invalid, fallback to simple string search
      return items.filter((item) => {
        const itemStr = JSON.stringify(item);
        return itemStr.toLowerCase().includes(filter.toLowerCase());
      });
    }
  }, []);

  // Functions to count items efficiently
  const getActionCount = useCallback(() => {
    if (!filterText) {
      // If no filter, just count the keys
      return Object.keys(model.push).length + Object.keys(model.pull).length;
    } else {
      // If filter is applied, we need a quick filtered count
      const pushItems = Object.entries(model.push).map(([id, result]) => ({
        id,
        type: "push",
        result,
      }));
      const pullItems = Object.entries(model.pull).map(([id, result]) => ({
        id,
        type: "pull",
        result,
      }));
      const allItems = [...pushItems, ...pullItems];
      return filterItems(allItems, filterText).length;
    }
  }, [model.push, model.pull, filterText, filterItems]);

  const getSubscriptionCount = useCallback(() => {
    if (!filterText) {
      // If no filter, just count the keys
      return Object.keys(model.subscriptions).length;
    } else {
      // If filter is applied, we need to check filtered items
      const subEntries = Object.entries(model.subscriptions).map((
        [id, sub],
      ) => ({
        id,
        sub,
        type: "subscription",
      }));
      return filterItems(subEntries, filterText).length;
    }
  }, [model.subscriptions, filterText, filterItems]);

  const getFilteredSubscriptions = useCallback(() => {
    if (!filterText) return Object.entries(model.subscriptions);

    try {
      const regex = new RegExp(filterText, "i");
      return Object.entries(model.subscriptions).filter(([id, sub]) => {
        return regex.test(id) ||
          regex.test(sub.source.cmd) ||
          regex.test(JSON.stringify(sub));
      });
    } catch (e) {
      // Fallback to simple string search
      return Object.entries(model.subscriptions).filter(([id, sub]) => {
        const subStr = JSON.stringify({ id, ...sub });
        return subStr.toLowerCase().includes(filterText.toLowerCase());
      });
    }
  }, [model.subscriptions, filterText]);

  const {
    drawerHeight,
    isResizing,
    handleResizeStart,
    handleTouchResizeStart,
  } = useResizableDrawer({
    initialHeight: 240,
    resizeDirection: "down", // Resize from bottom up (for bottom drawer)
  });

  // Icons for action types
  const getActionIcon = (type: string, hasError: boolean) => {
    if (hasError) return "⁈";
    return type === "push" ? "↑" : "↓";
  };

  const computedDrawerHeight = fullscreen ? "100vh" : `${drawerHeight}px`;

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="absolute top-0 left-4 transform -translate-y-full bg-gray-800 text-white px-2 py-0.5 rounded-t-md text-xs"
      >
        <span ref={buttonTextRef}>Inspector {isOpen ? "▼" : "▲"}</span>
      </button>

      {isOpen && (
        <div
          className="bg-gray-900 text-white shadow-lg border-t border-gray-700 text-xs flex flex-col"
          style={{ height: `${computedDrawerHeight}` }}
        >
          {/* Resize Handle */}
          <div
            className="resize-handle h-6 w-full cursor-ns-resize flex items-center justify-center border-b border-gray-700 flex-shrink-0"
            onMouseDown={handleResizeStart}
            onTouchStart={handleTouchResizeStart}
          >
            <div className="w-16 h-1 bg-gray-600 rounded-full"></div>
          </div>

          {/* Tab Navigation with Filter Box */}
          <div className="flex justify-between items-center px-4 py-2 border-b border-gray-700">
            <div className="flex space-x-2">
              <button
                type="button"
                className={`px-2 py-0.5 ${
                  activeTab === "actions"
                    ? "bg-gray-700 rounded"
                    : "text-gray-400 hover:text-gray-300"
                }`}
                onClick={() => setActiveTab("actions")}
              >
                Actions ({getActionCount()})
              </button>
              <button
                type="button"
                className={`px-2 py-0.5 ${
                  activeTab === "subscriptions"
                    ? "bg-gray-700 rounded"
                    : "text-gray-400 hover:text-gray-300"
                }`}
                onClick={() => setActiveTab("subscriptions")}
              >
                Subscriptions ({getSubscriptionCount()})
              </button>
            </div>
            <div className="flex items-center space-x-2">
              <div className="relative">
                <input
                  type="text"
                  placeholder="Filter..."
                  value={filterText}
                  onChange={(e) => setFilterText(e.target.value)}
                  className={`w-32 px-2 py-0.5 text-xs bg-gray-800 border border-gray-700 rounded text-white ${
                    filterText ? "border-blue-500" : ""
                  }`}
                />
                {filterText && (
                  <button
                    type="button"
                    className="absolute right-1 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-white"
                    onClick={() => setFilterText("")}
                  >
                    ×
                  </button>
                )}
              </div>
              <div>{connectionStatus()}</div>
            </div>
          </div>

          {/* Content Area - This is the scrollable container */}
          <div
            className={`flex-1 overflow-auto p-2 ${
              isResizing ? "pointer-events-none" : ""
            }`}
          >
            {activeTab === "actions" && (
              <div className="space-y-1">
                {getActionItems().length > 0
                  ? (
                    getActionItems().map((
                      { id, type, result, time, details, hasError },
                    ) => (
                      <div key={id} className="p-1 bg-gray-800 rounded-md">
                        <div
                          className="flex justify-between items-center cursor-pointer"
                          onClick={() => toggleRowExpand(id)}
                        >
                          <div className="flex items-center space-x-1">
                            <span
                              className={`${
                                hasError
                                  ? "text-red-400"
                                  : type === "push"
                                  ? "text-blue-400"
                                  : "text-purple-400"
                              }`}
                            >
                              {getActionIcon(type, hasError)}
                            </span>
                            <code className="font-mono text-xs truncate max-w-xs">
                              {id}
                            </code>
                            {details && (
                              <span className="text-xs bg-gray-700 px-1 rounded ml-1">
                                <span className="text-yellow-300">
                                  {details.of}
                                </span>
                                .<span className="text-green-300">
                                  {details.the}
                                </span>
                                .<span className="text-blue-300">
                                  {details.cause}
                                </span>
                              </span>
                            )}
                          </div>
                          <div className="flex items-center">
                            <span className="text-xs opacity-70">
                              {formatTime(time)}
                            </span>
                            <span className="ml-1">
                              {expandedRows.has(id) ? "▼" : "▶"}
                            </span>
                          </div>
                        </div>

                        {result.error
                          ? (
                            <div className="text-red-400 text-xs pl-4">
                              {result.error.message}
                              {(result.error as any).reason &&
                                (
                                  <span className="opacity-70 ml-1">
                                    ({(result.error as any).reason})
                                  </span>
                                )}
                            </div>
                          )
                          : (
                            <div className="text-green-400 text-xs pl-4 truncate">
                              {result.ok?.invocation.cmd}
                            </div>
                          )}

                        {expandedRows.has(id) && (
                          <div className="mt-1 rounded overflow-auto max-h-40">
                            <JsonView
                              value={result}
                              style={{
                                ...githubDarkTheme,
                                background: "transparent",
                              }}
                              collapsed={2}
                            />
                          </div>
                        )}
                      </div>
                    ))
                  )
                  : (
                    <div className="text-gray-500 italic text-center p-1">
                      No actions {filterText && "matching filter"}
                    </div>
                  )}
              </div>
            )}

            {activeTab === "subscriptions" && (
              <div className="overflow-auto">
                {getFilteredSubscriptions().length > 0
                  ? (
                    <table className="w-full border-collapse text-xs">
                      <thead>
                        <tr className="border-b border-gray-700">
                          <th className="text-left p-1">ID</th>
                          <th className="text-left p-1">Command</th>
                          <th className="text-left p-1">Age</th>
                          <th className="text-left p-1"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {getFilteredSubscriptions().map((
                          [id, sub],
                        ) => (
                          <React.Fragment key={id}>
                            <tr className="border-b border-gray-700 hover:bg-gray-800">
                              <td className="p-1 font-mono truncate max-w-[8rem]">
                                {id}
                              </td>
                              <td className="p-1 truncate max-w-[10rem]">
                                {sub.source.cmd}
                              </td>
                              <td className="p-1 whitespace-nowrap">
                                {Math.floor((Date.now() - sub.opened) / 1000)}s
                                {sub.updated && (
                                  <span className="text-gray-400">
                                    (+{Math.floor(
                                      (Date.now() - sub.updated) / 1000,
                                    )}s)
                                  </span>
                                )}
                              </td>
                              <td className="p-1">
                                <button
                                  type="button"
                                  className="text-blue-400 px-1"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    toggleRowExpand(id);
                                  }}
                                >
                                  {expandedRows.has(id) ? "▼" : "▶"}
                                </button>
                              </td>
                            </tr>
                            {expandedRows.has(id) && (
                              <tr className="bg-gray-800">
                                <td colSpan={4} className="p-1">
                                  <div className="rounded overflow-auto max-h-40">
                                    <JsonView
                                      value={sub}
                                      style={githubDarkTheme}
                                      collapsed={2}
                                    />
                                  </div>
                                </td>
                              </tr>
                            )}
                          </React.Fragment>
                        ))}
                      </tbody>
                    </table>
                  )
                  : (
                    <div className="text-gray-500 italic text-center p-1">
                      No subscriptions {filterText && "matching filter"}
                    </div>
                  )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
