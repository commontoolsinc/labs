import { useSprings, animated } from '@react-spring/web'
import { useDrag } from '@use-gesture/react'
import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { createClusters, Cluster } from './clustering-utils'
import { ClusterStats } from './clustering-stats'

// Constants for grid and layout
const GRID_SIZE = 8
const CARD_WIDTH = 200
const CARD_HEIGHT = 150
const GRID_COLS = 4
const GRID_PADDING = GRID_SIZE * 4

// Z-index layers
const Z_INDEX = {
  BASE: 1,
  SELECTED: 50,
  DRAGGING: 100,
  FOCUSED: 1000,
  UI: 10000
} as const

interface SelectionBox {
  startX: number
  startY: number
  currentX: number
  currentY: number
}

interface FocusedLayout {
  x: number
  y: number
  width: number
  height: number
  transform: string
  zIndex: number
}

type Blob = {
  id: string
  data: unknown
  x: number
  y: number
  scale: number
  zIndex: number
  isDragging: boolean
}

const BlobCanvas: React.FC<{ blobs: [string, unknown][] }> = ({ blobs }) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [selectionBox, setSelectionBox] = useState<SelectionBox | null>(null)
  const positionedItems = useRef<Record<string, { x: number, y: number }>>({})
  const [searchQuery, setSearchQuery] = useState('')
  const [clusters, setClusters] = useState<Cluster[]>([])
  const [clusteringEnabled, setClusteringEnabled] = useState(false)
  const [focusedClusterId, setFocusedClusterId] = useState<string | null>(null)
  const [focusedItemId, setFocusedItemId] = useState<string | null>(null)

  const [items, setItems] = useState<Blob[]>(() =>
    createInitialItems(blobs, positionedItems.current)
  )

  const focusedItems = useMemo(() =>
    focusedItemId
      ? [focusedItemId]
      : focusedClusterId
        ? clusters.find(c => c.id === focusedClusterId)?.items || []
        : []
    , [focusedItemId, focusedClusterId, clusters])

  const filteredItems = items.map(item => ({
    ...item,
    visible: searchQuery === '' ||
      JSON.stringify(item.data).toLowerCase().includes(searchQuery.toLowerCase()) ||
      item.id.toLowerCase().includes(searchQuery.toLowerCase())
  }))

  const calculateFocusedLayout = (itemIds: string[]): Map<string, FocusedLayout> => {
    if (!containerRef.current || itemIds.length === 0) return new Map()

    const container = containerRef.current
    const margin = 40
    const viewportWidth = container.clientWidth - (margin * 2)
    const viewportHeight = container.clientHeight - (margin * 2)

    // Single item focus
    if (itemIds.length === 1) {
      const targetAspectRatio = CARD_WIDTH / CARD_HEIGHT
      const viewportAspectRatio = viewportWidth / viewportHeight

      let width: number
      let height: number

      if (viewportAspectRatio > targetAspectRatio) {
        height = viewportHeight
        width = height * targetAspectRatio
      } else {
        width = viewportWidth
        height = width / targetAspectRatio
      }

      const x = margin + (viewportWidth - width) / 2
      const y = margin + (viewportHeight - height) / 2

      return new Map([
        [itemIds[0], {
          x,
          y,
          width,
          height,
          transform: 'translate(0px, 0px) scale(1)',
          zIndex: Z_INDEX.FOCUSED
        }]
      ])
    }

    // Multiple items (cluster) focus
    const itemCount = itemIds.length
    const targetAspectRatio = CARD_WIDTH / CARD_HEIGHT

    const cols = Math.ceil(Math.sqrt(itemCount * (viewportWidth / viewportHeight)))
    const rows = Math.ceil(itemCount / cols)

    const itemWidth = (viewportWidth / cols)
    const itemHeight = (viewportHeight / rows)

    let finalItemWidth: number
    let finalItemHeight: number

    if (itemWidth / itemHeight > targetAspectRatio) {
      finalItemHeight = itemHeight * 0.9
      finalItemWidth = finalItemHeight * targetAspectRatio
    } else {
      finalItemWidth = itemWidth * 0.9
      finalItemHeight = finalItemWidth / targetAspectRatio
    }

    return new Map(
      itemIds.map((id, index) => {
        const col = index % cols
        const row = Math.floor(index / cols)

        const cellX = margin + (col * itemWidth)
        const cellY = margin + (row * itemHeight)
        const x = cellX + (itemWidth - finalItemWidth) / 2
        const y = cellY + (itemHeight - finalItemHeight) / 2

        return [id, {
          x,
          y,
          width: finalItemWidth,
          height: finalItemHeight,
          transform: 'translate(0px, 0px) scale(1)',
          zIndex: Z_INDEX.FOCUSED
        }]
      })
    )
  }

  const [springs, api] = useSprings(items.length, i => ({
    x: items[i].x,
    y: items[i].y,
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    transform: 'translate(0px, 0px) scale(1)',
    zIndex: Z_INDEX.BASE,
    opacity: 1,
    config: { tension: 300, friction: 30 }
  }))

  useEffect(() => {
    const focusedLayout = calculateFocusedLayout(focusedItems)

    api.start(i => {
      const item = items[i]
      const layout = focusedLayout.get(item.id)

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
          config: { tension: 300, friction: 40 }
        }
      }

      return {
        x: item.x,
        y: item.y,
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
        transform: 'translate(0px, 0px) scale(1)',
        zIndex: selectedIds.has(item.id) ? Z_INDEX.SELECTED : Z_INDEX.BASE,
        opacity: focusedItems.length > 0 ? 0.2 : 1,
        immediate: false,
        config: { tension: 300, friction: 40 }
      }
    })
  }, [focusedClusterId, focusedItemId, items, clusters, api, focusedItems, selectedIds])

  const handleItemDoubleClick = (itemId: string) => {
    if (focusedItemId === itemId) {
      setFocusedItemId(null)
    } else {
      setFocusedItemId(itemId)
      setFocusedClusterId(null)
    }
  }

  const clusterColors = useMemo(() =>
    clusters.reduce((acc, cluster) => ({
      ...acc,
      [cluster.id]: `hsl(${Math.random() * 360}, 70%, 85%)`
    }), {} as Record<string, string>)
    , [clusters])

  const getClusterBounds = useCallback((cluster: Cluster) => {
    const clusterItems = items.filter(item => cluster.items.includes(item.id))
    const positions = clusterItems.map(item => ({ x: item.x, y: item.y }))
    return {
      left: Math.min(...positions.map(p => p.x)) - GRID_SIZE,
      top: Math.min(...positions.map(p => p.y)) - GRID_SIZE,
      right: Math.max(...positions.map(p => p.x + CARD_WIDTH)) + GRID_SIZE,
      bottom: Math.max(...positions.map(p => p.y + CARD_HEIGHT)) + GRID_SIZE,
    }
  }, [items])

  const applyClustering = () => {
    const newClusters = createClusters(items)
    setClusters(newClusters)

    setItems(items => {
      const newItems = [...items]

      clusters.forEach(cluster => {
        const radius = Math.max(30, cluster.items.length * 20)
        cluster.items.forEach((itemId, index) => {
          const angle = (index / cluster.items.length) * 2 * Math.PI
          const itemIndex = items.findIndex(item => item.id === itemId)

          if (itemIndex !== -1) {
            newItems[itemIndex] = {
              ...newItems[itemIndex],
              x: snapToGrid(cluster.centerX + Math.cos(angle) * radius),
              y: snapToGrid(cluster.centerY + Math.sin(angle) * radius)
            }
          }
        })
      })

      return newItems
    })
  }

  useEffect(() => {
    setItems(current => {
      const newItems = blobs.map(([id, data], i) => {
        const existingItem = current.find(item => item.id === id)

        if (existingItem) {
          return {
            ...existingItem,
            data
          }
        }

        const savedPosition = positionedItems.current[id]
        const gridPosition = getInitialGridPosition(i)

        return {
          id,
          data,
          x: savedPosition?.x ?? gridPosition.x,
          y: savedPosition?.y ?? gridPosition.y,
          scale: 1,
          zIndex: Z_INDEX.BASE,
          isDragging: false
        }
      })

      return newItems
    })
  }, [blobs])

  useEffect(() => {
    api.start(i => ({
      x: items[i].x,
      y: items[i].y,
      width: CARD_WIDTH,
      height: CARD_HEIGHT,
      transform: 'translate(0px, 0px) scale(1)',
      zIndex: selectedIds.has(items[i].id) ? Z_INDEX.SELECTED : Z_INDEX.BASE
    }))
  }, [items, api, selectedIds])

  useEffect(() => {
    api.start(i => ({
      opacity: filteredItems[i].visible ? 1 : 0.3,
      config: { tension: 300, friction: 30 }
    }))
  }, [searchQuery, filteredItems, api])

  const normalizedSelection = useMemo(() => selectionBox ? {
    left: Math.min(selectionBox.startX, selectionBox.currentX),
    top: Math.min(selectionBox.startY, selectionBox.currentY),
    width: Math.abs(selectionBox.currentX - selectionBox.startX),
    height: Math.abs(selectionBox.currentY - selectionBox.startY)
  } : null, [selectionBox])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const handleMouseDown = (e: MouseEvent) => {
      if (e.target !== container) return
      const rect = container.getBoundingClientRect()
      const startX = e.clientX - rect.left
      const startY = e.clientY - rect.top
      setSelectionBox({ startX, startY, currentX: startX, currentY: startY })
    }

    const handleMouseMove = (e: MouseEvent) => {
      if (!selectionBox) return
      const rect = container.getBoundingClientRect()
      setSelectionBox(prev => ({
        ...prev!,
        currentX: e.clientX - rect.left,
        currentY: e.clientY - rect.top
      }))

      if (normalizedSelection) {
        const newSelected = new Set<string>()
        items.forEach(item => {
          if (isIntersecting(item, normalizedSelection)) {
            newSelected.add(item.id)
          }
        })
        setSelectedIds(newSelected)
      }
    }

    const handleMouseUp = () => {
      setSelectionBox(null)
    }

    container.addEventListener('mousedown', handleMouseDown)
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)

    return () => {
      container.removeEventListener('mousedown', handleMouseDown)
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [selectionBox, items, normalizedSelection])

  const bind = useDrag(({ args: [index], active, movement: [mx, my], first, last }) => {
    if (first) {
      const clickedId = items[index].id
      if (!selectedIds.has(clickedId)) {
        setSelectedIds(new Set([clickedId]))
      }
    }

    api.start(i => {
      const item = items[i]
      if (!selectedIds.has(item.id)) return
      return {
        x: item.x + mx,
        y: item.y + my,
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
        transform: active ? 'translate(0px, 0px) scale(1.1)' : 'translate(0px, 0px) scale(1)',
        zIndex: Z_INDEX.DRAGGING,
        immediate: active
      }
    })

    if (last) {
      setItems(items =>
        items.map(item => {
          if (!selectedIds.has(item.id)) return item
          const newX = snapToGrid(item.x + mx)
          const newY = snapToGrid(item.y + my)
          positionedItems.current[item.id] = { x: newX, y: newY }
          return { ...item, x: newX, y: newY }
        })
      )
    }
  })

  return (
    <div className="relative">
      <div className="absolute top-4 right-4 z-[10000] flex gap-2">
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search..."
          className="px-4 py-2 rounded-lg border shadow-sm"
        />
        <button
          onClick={() => {
            setClusteringEnabled(!clusteringEnabled)
            if (!clusteringEnabled) applyClustering()
          }}
          className={`px-4 py-2 rounded-lg shadow-sm ${clusteringEnabled
            ? 'bg-blue-500 text-white'
            : 'bg-white text-gray-700'
            }`}
        >
          {clusteringEnabled ? 'Disable Clustering' : 'Enable Clustering'}
        </button>
      </div>

      <div ref={containerRef} className="relative w-full h-[600px] bg-gray-100 rounded-lg overflow-hidden">
        <svg className="absolute inset-0 w-full h-full opacity-10 pointer-events-none">
          <pattern id="grid" width={GRID_SIZE} height={GRID_SIZE} patternUnits="userSpaceOnUse">
            <circle cx={1} cy={1} r={1} fill="currentColor" className="text-gray-400" />
          </pattern>
          <rect width="100%" height="100%" fill="url(#grid)" />
        </svg>

        {(focusedItemId || focusedClusterId) && (
          <div
            className="absolute inset-0 bg-white/50 backdrop-blur-sm z-[2]"
            onClick={() => {
              setFocusedItemId(null)
              setFocusedClusterId(null)
            }}
          />
        )}

        {clusteringEnabled && clusters.map(cluster => {
          const bounds = getClusterBounds(cluster)
          const isSelected = cluster.id === focusedClusterId
          const zIndex = isSelected ? Z_INDEX.FOCUSED - 1 : Z_INDEX.BASE

          return (
            <div
              key={cluster.id}
              className={`absolute rounded-lg border-2 transition-all duration-200
                ${isSelected ? 'ring-2 ring-offset-2' : 'hover:ring-1 hover:ring-offset-1'}
                ${focusedItemId || (focusedClusterId && focusedClusterId !== cluster.id)
                  ? 'opacity-20'
                  : 'opacity-100'}
              `}
              style={{
                left: bounds.left,
                top: bounds.top,
                width: bounds.right - bounds.left,
                height: bounds.bottom - bounds.top,
                borderColor: clusterColors[cluster.id],
                backgroundColor: `${clusterColors[cluster.id]}66`,
                cursor: 'pointer',
                zIndex,
              }}
              onClick={() => {
                if (isSelected) {
                  setFocusedClusterId(null)
                } else {
                  setFocusedClusterId(cluster.id)
                  setFocusedItemId(null)
                }
              }}
            >
              <div className="absolute -top-6 left-2 text-xs bg-white px-2 py-1 rounded shadow-sm">
                Cluster {cluster.id} ({cluster.items.length})
              </div>
            </div>
          )
        })}

        {normalizedSelection && (
          <div
            className="absolute border-2 border-blue-500 bg-blue-500/10 pointer-events-none z-[5]"
            style={{
              left: normalizedSelection.left,
              top: normalizedSelection.top,
              width: normalizedSelection.width,
              height: normalizedSelection.height
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
              position: 'absolute',
              touchAction: 'none',
              userSelect: 'none',
              width: spring.width,
              height: spring.height,
              transform: spring.transform,
            }}
            className={`
              cursor-grab active:cursor-grabbing
              transition-shadow duration-200 overflow-hidden
              ${items[i].id === focusedItemId ? 'ring-2 ring-blue-500 shadow-lg' : ''}
              ${selectedIds.has(items[i].id) ? 'ring-2 ring-blue-500' : ''}
              ${(focusedItemId || focusedClusterId) &&
                !focusedItems.includes(items[i].id) ? 'opacity-20' : ''}
            `}
          >
            <div className="w-full h-full bg-white p-4 rounded-lg shadow-lg overflow-auto">
              <div className="font-medium mb-2 flex justify-between items-center">
                <span>{items[i].id}</span>
                {(focusedItemId === items[i].id || focusedClusterId) && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      setFocusedItemId(null)
                      setFocusedClusterId(null)
                    }}
                    className="text-gray-500 hover:text-gray-700 p-1 hover:bg-gray-100 rounded"
                  >
                    ×
                  </button>
                )}
              </div>
              <pre className="text-xs overflow-hidden">
                {JSON.stringify(items[i].data, null, 2)}
              </pre>
            </div>
          </animated.div>
        ))}
      </div>
    </div>
  )
}

function createInitialItems(
  blobs: [string, unknown][],
  savedPositions: Record<string, { x: number, y: number }>
): Blob[] {
  return blobs.map(([id, data], i) => {
    const savedPosition = savedPositions[id]
    const gridPosition = getInitialGridPosition(i)
    return {
      id,
      data,
      x: savedPosition?.x ?? gridPosition.x,
      y: savedPosition?.y ?? gridPosition.y,
      scale: 1,
      zIndex: Z_INDEX.BASE,
      isDragging: false
    }
  })
}

const snapToGrid = (value: number) => Math.round(value / GRID_SIZE) * GRID_SIZE

const getInitialGridPosition = (index: number) => ({
  x: (index % GRID_COLS) * (CARD_WIDTH + GRID_SIZE * 2) + GRID_PADDING,
  y: Math.floor(index / GRID_COLS) * (CARD_HEIGHT + GRID_SIZE * 2) + GRID_PADDING
})

const isIntersecting = (item: Blob, selection: { left: number, top: number, width: number, height: number }) => {
  const itemRight = item.x + CARD_WIDTH
  const itemBottom = item.y + CARD_HEIGHT
  return !(
    item.x > selection.left + selection.width ||
    itemRight < selection.left ||
    item.y > selection.top + selection.height ||
    itemBottom < selection.top
  )
}

export default BlobCanvas
