import { useDrag } from "@use-gesture/react";
import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { createClusters, Cluster } from "@/utils/clustering-utils.ts";
import { JsonTable } from "@/components/BlobViewer.tsx";
import { animated, useSprings } from "@react-spring/web";

// Constants for grid and layout
const GRID_SIZE = 8;
const CARD_WIDTH = 200;
const CARD_HEIGHT = 150;
const GRID_COLS = 4;
const GRID_PADDING = GRID_SIZE * 4;

// Physics constants
const THROW_TENSION = 250;
const THROW_FRICTION = 15;
const TILT_FACTOR = 0.25;
const MAX_TILT = 15;

// Z-index layers
const Z_INDEX = {
  BASE: 1,
  SELECTED: 50,
  DRAGGING: 100,
  FOCUSED: 1000,
  UI: 10000,
} as const;

interface SelectionBox {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
}

interface FocusedLayout {
  x: number;
  y: number;
  width: number;
  height: number;
  transform: string;
  zIndex: number;
}

interface BlobSet {
  id: string;
  name: string;
  items: string[];
  createdAt: Date;
}

interface NavigationEntry {
  type: "item" | "cluster";
  id: string;
  timestamp: number;
}

interface Suggestion {
  id: string;
  type: "item" | "cluster";
  label: string;
  relationship: "same-cluster" | "different-cluster";
}

export type BlobItem = {
  id: string;
  data: unknown;
  x: number;
  y: number;
  scale: number;
  zIndex: number;
  isDragging: boolean;
  velocityX?: number;
  velocityY?: number;
  rotateX?: number;
  rotateY?: number;
};

const BlobCanvas: React.FC<{ blobs: [string, unknown][] }> = ({ blobs }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectionBox, setSelectionBox] = useState<SelectionBox | null>(null);
  const positionedItems = useRef<Record<string, { x: number; y: number }>>({});
  const [searchQuery, setSearchQuery] = useState("");
  const [clusters, setClusters] = useState<Cluster[]>([]);
  const [clusteringEnabled, setClusteringEnabled] = useState(false);
  const [focusedClusterId, setFocusedClusterId] = useState<string | null>(null);
  const [focusedItemId, setFocusedItemId] = useState<string | null>(null);
  const [sets, setSets] = useState<BlobSet[]>([]);
  const [isCreateSetModalOpen, setIsCreateSetModalOpen] = useState(false);
  const [newSetName, setNewSetName] = useState("");
  const [navigationHistory, setNavigationHistory] = useState<NavigationEntry[]>(
    [],
  );
  const [currentHistoryIndex, setCurrentHistoryIndex] = useState<number>(-1);

  const [items, setItems] = useState<BlobItem[]>(() =>
    createInitialItems(blobs, positionedItems.current),
  );

  const focusedItems = useMemo(
    () =>
      focusedItemId
        ? [focusedItemId]
        : focusedClusterId
          ? clusters.find(c => c.id === focusedClusterId)?.items || []
          : [],
    [focusedItemId, focusedClusterId, clusters],
  );

  const filteredItems = items.map(item => ({
    ...item,
    visible:
      searchQuery === "" ||
      JSON.stringify(item.data)
        .toLowerCase()
        .includes(searchQuery.toLowerCase()) ||
      item.id.toLowerCase().includes(searchQuery.toLowerCase()),
  }));

  const navigateTo = (type: "item" | "cluster", id: string) => {
    const newEntry: NavigationEntry = {
      type,
      id,
      timestamp: Date.now(),
    };

    setNavigationHistory(prev => {
      // Remove any forward history if we're not at the end
      const newHistory = prev.slice(0, currentHistoryIndex + 1);
      return [...newHistory, newEntry];
    });
    setCurrentHistoryIndex(prev => prev + 1);

    if (type === "item") {
      setFocusedItemId(id);
      setFocusedClusterId(null);
    } else {
      setFocusedClusterId(id);
      setFocusedItemId(null);
    }
  };

  const navigateBack = () => {
    if (currentHistoryIndex > 0) {
      const prevEntry = navigationHistory[currentHistoryIndex - 1];
      setCurrentHistoryIndex(prev => prev - 1);

      if (prevEntry.type === "item") {
        setFocusedItemId(prevEntry.id);
        setFocusedClusterId(null);
      } else {
        setFocusedClusterId(prevEntry.id);
        setFocusedItemId(null);
      }
    }
  };

  const navigateForward = () => {
    if (currentHistoryIndex < navigationHistory.length - 1) {
      const nextEntry = navigationHistory[currentHistoryIndex + 1];
      setCurrentHistoryIndex(prev => prev + 1);

      if (nextEntry.type === "item") {
        setFocusedItemId(nextEntry.id);
        setFocusedClusterId(null);
      } else {
        setFocusedClusterId(nextEntry.id);
        setFocusedItemId(null);
      }
    }
  };

  const getSuggestions = useMemo((): Suggestion[] => {
    if (!focusedItemId && !focusedClusterId) return [];

    const suggestions: Suggestion[] = [];

    if (focusedItemId) {
      // Find the cluster containing the focused item
      const containingCluster = clusters.find(c =>
        c.items.includes(focusedItemId),
      );

      if (containingCluster) {
        // Add other items from the same cluster as suggestions
        containingCluster.items
          .filter(id => id !== focusedItemId)
          .forEach(id => {
            suggestions.push({
              id,
              type: "item",
              label: id,
              relationship: "same-cluster",
            });
          });

        // Add the cluster itself as a suggestion
        suggestions.push({
          id: containingCluster.id,
          type: "cluster",
          label: `Cluster ${containingCluster.id}`,
          relationship: "same-cluster",
        });
      }
    }

    return suggestions;
  }, [focusedItemId, focusedClusterId, clusters]);

  const createNewSet = async () => {
    if (!newSetName.trim() || selectedIds.size === 0) return;

    try {
      const newSet: BlobSet = {
        id: crypto.randomUUID(),
        name: newSetName,
        items: Array.from(selectedIds),
        createdAt: new Date(),
      };

      setSets(current => [...current, newSet]);
      setNewSetName("");
      setIsCreateSetModalOpen(false);
      setSelectedIds(new Set());
    } catch (error) {
      console.error("Failed to create set:", error);
    }
  };

  const calculateFocusedLayout = (
    itemIds: string[],
  ): Map<string, FocusedLayout> => {
    if (!containerRef.current || itemIds.length === 0) return new Map();

    const container = containerRef.current;
    const margin = 40;
    const viewportWidth = container.clientWidth - margin * 2;
    const viewportHeight = container.clientHeight - margin * 2;

    // Single item focus
    if (itemIds.length === 1) {
      const targetAspectRatio = CARD_WIDTH / CARD_HEIGHT;
      const viewportAspectRatio = viewportWidth / viewportHeight;

      let width: number;
      let height: number;

      if (viewportAspectRatio > targetAspectRatio) {
        height = viewportHeight;
        width = height * targetAspectRatio;
      } else {
        width = viewportWidth;
        height = width / targetAspectRatio;
      }

      const x = margin + (viewportWidth - width) / 2;
      const y = margin + (viewportHeight - height) / 2;

      return new Map([
        [
          itemIds[0],
          {
            x,
            y,
            width,
            height,
            transform: "translate(0px, 0px) scale(1)",
            zIndex: Z_INDEX.FOCUSED,
          },
        ],
      ]);
    }

    // Multiple items (cluster) focus
    const itemCount = itemIds.length;
    const targetAspectRatio = CARD_WIDTH / CARD_HEIGHT;

    const cols = Math.ceil(
      Math.sqrt(itemCount * (viewportWidth / viewportHeight)),
    );
    const rows = Math.ceil(itemCount / cols);

    const itemWidth = viewportWidth / cols;
    const itemHeight = viewportHeight / rows;

    let finalItemWidth: number;
    let finalItemHeight: number;

    if (itemWidth / itemHeight > targetAspectRatio) {
      finalItemHeight = itemHeight * 0.9;
      finalItemWidth = finalItemHeight * targetAspectRatio;
    } else {
      finalItemWidth = itemWidth * 0.9;
      finalItemHeight = finalItemWidth / targetAspectRatio;
    }

    return new Map(
      itemIds.map((id, index) => {
        const col = index % cols;
        const row = Math.floor(index / cols);

        const cellX = margin + col * itemWidth;
        const cellY = margin + row * itemHeight;
        const x = cellX + (itemWidth - finalItemWidth) / 2;
        const y = cellY + (itemHeight - finalItemHeight) / 2;

        return [
          id,
          {
            x,
            y,
            width: finalItemWidth,
            height: finalItemHeight,
            transform: "translate(0px, 0px) scale(1)",
            zIndex: Z_INDEX.FOCUSED,
          },
        ];
      }),
    );
  };

  const [springs, api] = useSprings<{
    x: number;
    y: number;
    width: number;
    height: number;
    transform: string;
    zIndex: number;
    opacity: number;
  }>(items.length, i => ({
    x: items[i].x,
    y: items[i].y,
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    transform: "translate(0px, 0px) scale(1)",
    zIndex: Z_INDEX.BASE,
    opacity: 1,
    config: { tension: 300, friction: 30 },
  }));

  useEffect(() => {
    const focusedLayout = calculateFocusedLayout(focusedItems);

    api.start(i => {
      const item = items[i];
      const layout = focusedLayout.get(item.id);

      if (layout) {
        return {
          x: layout.x,
          y: layout.y,
          width: layout.width,
          height: layout.height,
          transform: layout.transform,
          zIndex: layout.zIndex,
          opacity: 1,
          immediate: false,
          config: { tension: 300, friction: 40 },
        };
      }

      return {
        x: item.x,
        y: item.y,
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
        transform: "translate(0px, 0px) scale(1)",
        zIndex: selectedIds.has(item.id) ? Z_INDEX.SELECTED : Z_INDEX.BASE,
        opacity: focusedItems.length > 0 ? 0.2 : 1,
        immediate: false,
        config: { tension: 300, friction: 40 },
      };
    });
  }, [
    focusedClusterId,
    focusedItemId,
    items,
    clusters,
    api,
    focusedItems,
    selectedIds,
  ]);

  const handleItemDoubleClick = (itemId: string) => {
    if (focusedItemId === itemId) {
      setFocusedItemId(null);
    } else {
      navigateTo("item", itemId);
    }
  };

  const clusterColors = useMemo(
    () =>
      clusters.reduce(
        (acc, cluster) => ({
          ...acc,
          [cluster.id]: `hsl(${Math.random() * 360}, 70%, 85%)`,
        }),
        {} as Record<string, string>,
      ),
    [clusters],
  );

  const getClusterBounds = useCallback(
    (cluster: Cluster) => {
      const clusterItems = items.filter(item =>
        cluster.items.includes(item.id),
      );
      const positions = clusterItems.map(item => ({ x: item.x, y: item.y }));
      return {
        left: Math.min(...positions.map(p => p.x)) - GRID_SIZE,
        top: Math.min(...positions.map(p => p.y)) - GRID_SIZE,
        right: Math.max(...positions.map(p => p.x + CARD_WIDTH)) + GRID_SIZE,
        bottom: Math.max(...positions.map(p => p.y + CARD_HEIGHT)) + GRID_SIZE,
      };
    },
    [items],
  );

  const applyClustering = () => {
    const newClusters = createClusters(items);
    setClusters(newClusters);

    setItems(items => {
      const newItems = [...items];

      clusters.forEach(cluster => {
        const radius = Math.max(30, cluster.items.length * 20);
        cluster.items.forEach((itemId, index) => {
          const angle = (index / cluster.items.length) * 2 * Math.PI;
          const itemIndex = items.findIndex(item => item.id === itemId);

          if (itemIndex !== -1) {
            newItems[itemIndex] = {
              ...newItems[itemIndex],
              x: snapToGrid(cluster.centerX + Math.cos(angle) * radius),
              y: snapToGrid(cluster.centerY + Math.sin(angle) * radius),
            };
          }
        });
      });

      return newItems;
    });
  };

  useEffect(() => {
    setItems(current => {
      const newItems = blobs.map(([id, data], i) => {
        const existingItem = current.find(item => item.id === id);

        if (existingItem) {
          return {
            ...existingItem,
            data,
          };
        }

        const savedPosition = positionedItems.current[id];
        const gridPosition = getInitialGridPosition(i);

        return {
          id,
          data,
          x: savedPosition?.x ?? gridPosition.x,
          y: savedPosition?.y ?? gridPosition.y,
          scale: 1,
          zIndex: Z_INDEX.BASE,
          isDragging: false,
          velocityX: 0,
          velocityY: 0,
          rotateX: 0,
          rotateY: 0,
        };
      });

      return newItems;
    });
  }, [blobs]);

  useEffect(() => {
    api.start(i => ({
      x: items[i].x,
      y: items[i].y,
      width: CARD_WIDTH,
      height: CARD_HEIGHT,
      transform: "translate(0px, 0px) scale(1)",
      zIndex: selectedIds.has(items[i].id) ? Z_INDEX.SELECTED : Z_INDEX.BASE,
    }));
  }, [items, api, selectedIds]);

  useEffect(() => {
    api.start(i => ({
      opacity: filteredItems[i].visible ? 1 : 0.3,
      config: { tension: 300, friction: 30 },
    }));
  }, [searchQuery, filteredItems, api]);

  const normalizedSelection = useMemo(
    () =>
      selectionBox
        ? {
            left: Math.min(selectionBox.startX, selectionBox.currentX),
            top: Math.min(selectionBox.startY, selectionBox.currentY),
            width: Math.abs(selectionBox.currentX - selectionBox.startX),
            height: Math.abs(selectionBox.currentY - selectionBox.startY),
          }
        : null,
    [selectionBox],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleMouseDown = (e: MouseEvent) => {
      if (e.target !== container) return;
      const rect = container.getBoundingClientRect();
      const startX = e.clientX - rect.left;
      const startY = e.clientY - rect.top;
      setSelectionBox({ startX, startY, currentX: startX, currentY: startY });
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!selectionBox) return;
      const rect = container.getBoundingClientRect();
      setSelectionBox(prev => ({
        ...prev!,
        currentX: e.clientX - rect.left,
        currentY: e.clientY - rect.top,
      }));

      if (normalizedSelection) {
        const newSelected = new Set<string>();
        items.forEach(item => {
          if (isIntersecting(item, normalizedSelection)) {
            newSelected.add(item.id);
          }
        });
        setSelectedIds(newSelected);
      }
    };

    const handleMouseUp = () => {
      setSelectionBox(null);
    };

    container.addEventListener("mousedown", handleMouseDown);
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      container.removeEventListener("mousedown", handleMouseDown);
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [selectionBox, items, normalizedSelection]);

  const bind = useDrag(
    ({
      args: [index],
      active,
      movement: [mx, my],
      velocity: [vx, vy],
      first,
      last,
    }) => {
      if (first) {
        const clickedId = items[index].id;
        if (!selectedIds.has(clickedId)) {
          setSelectedIds(new Set([clickedId]));
        }
      }

      const tiltX = Math.min(
        MAX_TILT,
        Math.max(-MAX_TILT, vy * TILT_FACTOR * -100),
      );
      const tiltY = Math.min(
        MAX_TILT,
        Math.max(-MAX_TILT, vx * TILT_FACTOR * 100),
      );

      api.start(i => {
        const item = items[i];
        if (!selectedIds.has(item.id)) return;

        return {
          x: item.x + mx,
          y: item.y + my,
          width: CARD_WIDTH,
          height: CARD_HEIGHT,
          transform: active
            ? `perspective(1000px) translate3d(0,0,50px) rotateX(${tiltX}deg) rotateY(${tiltY}deg) scale(1.1)`
            : "perspective(1000px) translate3d(0,0,0) rotateX(0deg) rotateY(0deg) scale(1)",
          zIndex: Z_INDEX.DRAGGING,
          immediate: active,
          config: {
            tension: active ? undefined : THROW_TENSION,
            friction: active ? undefined : THROW_FRICTION,
          },
        };
      });

      if (last) {
        setItems(items =>
          items.map(item => {
            if (!selectedIds.has(item.id)) return item;
            const newX = snapToGrid(item.x + mx);
            const newY = snapToGrid(item.y + my);
            positionedItems.current[item.id] = { x: newX, y: newY };
            return {
              ...item,
              x: newX,
              y: newY,
              velocityX: vx,
              velocityY: vy,
              rotateX: tiltX,
              rotateY: tiltY,
            };
          }),
        );
      }
    },
  );

  return (
    <div className="flex flex-col h-screen">
      {/* Top Toolbar */}
      <div className="h-14 border-b flex items-center px-4 gap-4 bg-white">
        <div className="flex gap-2">
          <button
            onClick={navigateBack}
            disabled={currentHistoryIndex <= 0}
            className="px-3 py-1 rounded bg-gray-100 disabled:opacity-50"
          >
            ←
          </button>
          <button
            onClick={navigateForward}
            disabled={currentHistoryIndex >= navigationHistory.length - 1}
            className="px-3 py-1 rounded bg-gray-100 disabled:opacity-50"
          >
            →
          </button>
        </div>

        <input
          type="text"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          placeholder="Search..."
          className="px-4 py-2 rounded-lg border shadow-sm"
        />

        <button
          onClick={() => {
            setClusteringEnabled(!clusteringEnabled);
            if (!clusteringEnabled) applyClustering();
          }}
          className={`px-4 py-2 rounded-lg shadow-sm ${
            clusteringEnabled
              ? "bg-blue-500 text-white"
              : "bg-white text-gray-700"
          }`}
        >
          {clusteringEnabled ? "Disable Clustering" : "Enable Clustering"}
        </button>

        {selectedIds.size > 0 && (
          <button
            onClick={() => setIsCreateSetModalOpen(true)}
            className="px-4 py-2 rounded-lg bg-green-500 text-white shadow-sm"
          >
            Create Set ({selectedIds.size})
          </button>
        )}
      </div>

      <div className="flex-1 flex">
        {/* Main Canvas */}
        <div className="flex-1 relative">
          <div
            ref={containerRef}
            className="absolute inset-0 bg-gray-100 overflow-hidden"
          >
            <svg className="absolute inset-0 w-full h-full opacity-10 pointer-events-none">
              <pattern
                id="grid"
                width={GRID_SIZE}
                height={GRID_SIZE}
                patternUnits="userSpaceOnUse"
              >
                <circle
                  cx={1}
                  cy={1}
                  r={1}
                  fill="currentColor"
                  className="text-gray-400"
                />
              </pattern>
              <rect width="100%" height="100%" fill="url(#grid)" />
            </svg>

            {(focusedItemId || focusedClusterId) && (
              <div
                className="absolute inset-0 bg-white/50 backdrop-blur-sm z-[2]"
                onClick={() => {
                  setFocusedItemId(null);
                  setFocusedClusterId(null);
                }}
              />
            )}

            {clusteringEnabled &&
              clusters.map(cluster => {
                const bounds = getClusterBounds(cluster);
                const isSelected = cluster.id === focusedClusterId;
                const zIndex = isSelected ? Z_INDEX.FOCUSED - 1 : Z_INDEX.BASE;

                return (
                  <div
                    key={cluster.id}
                    className={`absolute rounded-lg border-2 transition-all duration-200
                    ${isSelected ? "ring-2 ring-offset-2" : "hover:ring-1 hover:ring-offset-1"}
                    ${
                      focusedItemId ||
                      (focusedClusterId && focusedClusterId !== cluster.id)
                        ? "opacity-20"
                        : "opacity-100"
                    }
                  `}
                    style={{
                      left: bounds.left,
                      top: bounds.top,
                      width: bounds.right - bounds.left,
                      height: bounds.bottom - bounds.top,
                      borderColor: clusterColors[cluster.id],
                      backgroundColor: `${clusterColors[cluster.id]}66`,
                      cursor: "pointer",
                      zIndex,
                    }}
                    onClick={() => {
                      if (isSelected) {
                        setFocusedClusterId(null);
                      } else {
                        navigateTo("cluster", cluster.id);
                      }
                    }}
                  >
                    <div className="absolute -top-6 left-2 text-xs bg-white px-2 py-1 rounded shadow-sm">
                      Cluster {cluster.id} ({cluster.items.length})
                    </div>
                  </div>
                );
              })}

            {normalizedSelection && (
              <div
                className="absolute border-2 border-blue-500 bg-blue-500/10 pointer-events-none z-[5]"
                style={{
                  left: normalizedSelection.left,
                  top: normalizedSelection.top,
                  width: normalizedSelection.width,
                  height: normalizedSelection.height,
                }}
              />
            )}

            {springs.map((spring, i) => (
              <animated.div
                {...(focusedItemId || focusedClusterId ? {} : bind(i))}
                key={items[i].id}
                onDoubleClick={() => handleItemDoubleClick(items[i].id)}
                style={{
                  ...spring,
                  position: "absolute",
                  touchAction: "none",
                  userSelect: "none",
                  width: spring.width,
                  height: spring.height,
                  transform: spring.transform,
                }}
                className={`
                  cursor-grab active:cursor-grabbing
                  transition-shadow duration-200 overflow-hidden
                  ${items[i].id === focusedItemId ? "ring-2 ring-blue-500 shadow-lg" : ""}
                  ${selectedIds.has(items[i].id) ? "ring-2 ring-blue-500" : ""}
                  ${
                    (focusedItemId || focusedClusterId) &&
                    !focusedItems.includes(items[i].id)
                      ? "opacity-20"
                      : ""
                  }
                `}
              >
                <div className="w-full h-full bg-white p-4 rounded-lg shadow-lg overflow-auto">
                  <div className="font-medium mb-2 flex justify-between items-center">
                    <span>{items[i].id}</span>
                    {(focusedItemId === items[i].id || focusedClusterId) && (
                      <button
                        onClick={e => {
                          e.stopPropagation();
                          setFocusedItemId(null);
                          setFocusedClusterId(null);
                        }}
                        className="text-gray-500 hover:text-gray-700 p-1 hover:bg-gray-100 rounded"
                      >
                        ×
                      </button>
                    )}
                  </div>
                  <JsonTable json={JSON.stringify(items[i].data, null, 2)} />
                  {/* <pre className="text-xs overflow-hidden">
                    {JSON.stringify(items[i].data, null, 2)}
                  </pre> */}
                </div>
              </animated.div>
            ))}
          </div>
        </div>

        {/* Sidebar */}
        <div className="w-80 border-l bg-white overflow-auto transition-all duration-300">
          {focusedItemId || focusedClusterId ? (
            <div className="p-4">
              <h3 className="font-medium mb-4">Related Items</h3>
              <div className="space-y-2">
                {getSuggestions.map(suggestion => (
                  <a
                    href="#"
                    key={`${suggestion.type}-${suggestion.id}`}
                    onClick={() => navigateTo(suggestion.type, suggestion.id)}
                    className="w-full p-3 text-left rounded-lg"
                  >
                    <div className="font-medium">{suggestion.label}</div>
                    <div className="text-sm text-gray-500">
                      {suggestion.relationship === "same-cluster"
                        ? "Same cluster"
                        : "Related"}
                    </div>
                  </a>
                ))}
              </div>
            </div>
          ) : (
            <div className="p-4">
              <h3 className="font-medium mb-4">Saved Sets</h3>
              {sets.length === 0 ? (
                <p className="text-sm text-gray-500">No sets created yet</p>
              ) : (
                <div className="space-y-2">
                  {sets.map(set => (
                    <div
                      key={set.id}
                      className="p-3 bg-gray-50 rounded-lg hover:bg-gray-100 cursor-pointer"
                      onClick={() => setSelectedIds(new Set(set.items))}
                    >
                      <div className="font-medium">{set.name}</div>
                      <div className="text-sm text-gray-500">
                        {set.items.length} items
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Create Set Modal */}
      {isCreateSetModalOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[20000]">
          <div className="bg-white rounded-lg p-6 w-96">
            <h3 className="font-medium mb-4">Create New Set</h3>
            <input
              type="text"
              value={newSetName}
              onChange={e => setNewSetName(e.target.value)}
              placeholder="Set name..."
              className="w-full px-4 py-2 rounded-lg border mb-4"
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setIsCreateSetModalOpen(false)}
                className="px-4 py-2 rounded-lg bg-gray-100 hover:bg-gray-200"
              >
                Cancel
              </button>
              <button
                onClick={createNewSet}
                className="px-4 py-2 rounded-lg bg-blue-500 text-white hover:bg-blue-600"
                disabled={!newSetName.trim() || selectedIds.size === 0}
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

function createInitialItems(
  blobs: [string, unknown][],
  savedPositions: Record<string, { x: number; y: number }>,
): BlobItem[] {
  return blobs.map(([id, data], i) => {
    const savedPosition = savedPositions[id];
    const gridPosition = getInitialGridPosition(i);
    return {
      id,
      data,
      x: savedPosition?.x ?? gridPosition.x,
      y: savedPosition?.y ?? gridPosition.y,
      scale: 1,
      zIndex: Z_INDEX.BASE,
      isDragging: false,
      velocityX: 0,
      velocityY: 0,
      rotateX: 0,
      rotateY: 0,
    };
  });
}

const snapToGrid = (value: number) => Math.round(value / GRID_SIZE) * GRID_SIZE;

const getInitialGridPosition = (index: number) => ({
  x: (index % GRID_COLS) * (CARD_WIDTH + GRID_SIZE * 2) + GRID_PADDING,
  y:
    Math.floor(index / GRID_COLS) * (CARD_HEIGHT + GRID_SIZE * 2) +
    GRID_PADDING,
});

const isIntersecting = (
  item: BlobItem,
  selection: { left: number; top: number; width: number; height: number },
) => {
  const itemRight = item.x + CARD_WIDTH;
  const itemBottom = item.y + CARD_HEIGHT;
  return !(
    item.x > selection.left + selection.width ||
    itemRight < selection.left ||
    item.y > selection.top + selection.height ||
    itemBottom < selection.top
  );
};

export default BlobCanvas;
