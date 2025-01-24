import { useSprings, animated } from '@react-spring/web'
import { useDrag } from '@use-gesture/react'
import { useState, useEffect, useRef } from 'react'

const GRID_SIZE = 8 // 8px grid
const CARD_WIDTH = 200
const CARD_HEIGHT = 150
const CARDS_PER_ROW = 4
const FOCUS_PADDING = 32

type Blob = {
  id: string
  data: any
  x: number
  y: number
  scale: number
  zIndex: number
  isDragging: boolean
  isOpen: boolean
}

// Snap coordinate to grid
const snapToGrid = (value: number) => Math.round(value / GRID_SIZE) * GRID_SIZE

// Calculate initial grid position
const getGridPosition = (index: number) => {
  const row = Math.floor(index / CARDS_PER_ROW)
  const col = index % CARDS_PER_ROW
  return {
    x: col * (CARD_WIDTH + GRID_SIZE * 2) + GRID_SIZE * 4,
    y: row * (CARD_HEIGHT + GRID_SIZE * 2) + GRID_SIZE * 4
  }
}

const BlobCanvas: React.FC<{ blobs: [string, any][] }> = ({ blobs }) => {
  const positionedItems = useRef<Record<string, { x: number, y: number }>>({})
  const [items, setItems] = useState<Blob[]>(() =>
    createInitialItems(blobs, positionedItems.current)
  )
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerBounds, setContainerBounds] = useState({ width: 0, height: 0 })

  useEffect(() => {
    const updateBounds = () => {
      if (containerRef.current) {
        setContainerBounds({
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight
        })
      }
    }

    updateBounds()
    window.addEventListener('resize', updateBounds)
    return () => window.removeEventListener('resize', updateBounds)
  }, [])

  // Create grid background pattern
  const gridPattern = (
    <svg className="absolute inset-0 w-full h-full opacity-10 pointer-events-none">
      <pattern id="grid" width={GRID_SIZE} height={GRID_SIZE} patternUnits="userSpaceOnUse">
        <circle cx={1} cy={1} r={1} fill="currentColor" />
      </pattern>
      <rect width="100%" height="100%" fill="url(#grid)" />
    </svg>
  )

  useEffect(() => {
    setItems(current => {
      const newItems = blobs.map(([id, data], i) => {
        const existingItem = current.find(item => item.id === id)
        if (existingItem) {
          return { ...existingItem, data }
        }

        const savedPosition = positionedItems.current[id]
        const gridPosition = getGridPosition(i)

        return {
          id,
          data,
          x: savedPosition?.x ?? gridPosition.x,
          y: savedPosition?.y ?? gridPosition.y,
          scale: 1,
          zIndex: current.length + i,
          isDragging: false,
          isOpen: false
        }
      })
      return newItems
    })
  }, [blobs])

  const [springs, api] = useSprings(items.length, i => ({
    x: items[i].x,
    y: items[i].y,
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    scale: 1,
    zIndex: items[i].zIndex,
    opacity: 1,
    config: { tension: 300, friction: 30 }
  }))

  useEffect(() => {
    api.start(i => {
      const item = items[i]
      if (item.isOpen) {
        const focusedWidth = containerBounds.width - (FOCUS_PADDING * 2)
        const focusedHeight = containerBounds.height - (FOCUS_PADDING * 2)

        return {
          immediate: false,
          x: FOCUS_PADDING,
          y: FOCUS_PADDING,
          width: focusedWidth,
          height: focusedHeight,
          scale: 1,
          zIndex: 1000,
          opacity: 1
        }
      }

      return {
        immediate: false,
        x: item.x,
        y: item.y,
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
        scale: item.isDragging ? 1.1 : 1,
        zIndex: item.zIndex,
        opacity: items.some(other => other.isOpen && other.id !== item.id) ? 0.1 : 1
      }
    })
  }, [items, api, containerBounds])

  const bind = useDrag(({ args: [index], active, movement: [mx, my], first, last }) => {
    if (first) {
      setItems(items =>
        items.map((item, i) => ({
          ...item,
          zIndex: i === index ? items.length : item.zIndex,
          isDragging: i === index
        }))
      )
    }

    api.start(i => {
      if (i !== index) return
      return {
        x: items[i].x + mx,
        y: items[i].y + my,
        scale: active ? 1.1 : 1,
        immediate: active
      }
    })

    if (last) {
      setItems(items => {
        const newItems = items.map((item, i) => {
          if (i !== index) return item
          const newX = snapToGrid(item.x + mx)
          const newY = snapToGrid(item.y + my)

          positionedItems.current[item.id] = { x: newX, y: newY }

          return {
            ...item,
            x: newX,
            y: newY,
            isDragging: false
          }
        })
        return newItems
      })
    }
  })

  const toggleOpen = (index: number) => {
    setItems(items =>
      items.map((item, i) => ({
        ...item,
        isOpen: i === index ? !item.isOpen : false,
        zIndex: i === index ? items.length : item.zIndex
      }))
    )
  }

  return (
    <div ref={containerRef} className="relative w-full h-[600px] bg-gray-100 rounded-lg overflow-hidden">
      {gridPattern}
      {springs.map((spring, i) => (
        <animated.div
          {...(items[i].isOpen ? {} : bind(i))}
          key={items[i].id}
          style={{
            ...spring,
            position: 'absolute',
            touchAction: 'none',
            userSelect: 'none',
          }}
          className={`transition-[backdrop-filter] duration-200
            ${items[i].isOpen ? 'backdrop-blur-sm' : ''}`}
        >
          <animated.div
            className={`bg-white rounded-lg shadow-lg overflow-hidden
              ${items[i].isOpen ? 'ring-2 ring-blue-500' : ''}`}
            style={{
              width: spring.width,
              height: spring.height,
            }}
          >
            <div className="p-4">
              <div className="font-medium mb-2 flex justify-between items-center">
                <span>{items[i].id}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    toggleOpen(i)
                  }}
                  className="text-gray-500 hover:text-gray-700 p-1 hover:bg-gray-100 rounded"
                >
                  {items[i].isOpen ? '×' : '⤢'}
                </button>
              </div>
              <animated.pre
                className="text-xs overflow-auto"
                style={{
                  height: spring.height.to(h => h - 80)
                }}
              >
                {JSON.stringify(items[i].data, null, 2)}
              </animated.pre>
            </div>
          </animated.div>
        </animated.div>
      ))}
    </div>
  )
}

function createInitialItems(
  blobs: [string, any][],
  savedPositions: Record<string, { x: number, y: number }>
): Blob[] {
  return blobs.map(([id, data], i) => {
    const savedPosition = savedPositions[id]
    const gridPosition = getGridPosition(i)
    return {
      id,
      data,
      x: savedPosition?.x ?? gridPosition.x,
      y: savedPosition?.y ?? gridPosition.y,
      scale: 1,
      zIndex: i,
      isDragging: false,
      isOpen: false
    }
  })
}

export default BlobCanvas
