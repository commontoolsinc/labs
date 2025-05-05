import { useCallback, useMemo, useRef, useState } from "react";

interface HoverPosition {
  x: number;
  y: number;
}

interface UseCharmHoverResult {
  hoveredCharm: string | null;
  previewPosition: HoverPosition;
  handleMouseMove: (e: React.MouseEvent, id: string) => void;
  handleMouseLeave: () => void;
}

/**
 * Hook for managing charm hover state and preview positioning
 */
export function useCharmHover(): UseCharmHoverResult {
  const [hoveredCharm, setHoveredCharm] = useState<string | null>(null);
  const [previewPosition, setPreviewPosition] = useState<HoverPosition>({
    x: 0,
    y: 0,
  });
  // Use a ref to cache the last hovered charm to prevent unnecessary re-renders
  const hoveredCharmRef = useRef<string | null>(null);

  const handleMouseMove = useCallback((e: React.MouseEvent, id: string) => {
    // Only update state if the hovered charm has changed
    if (hoveredCharmRef.current !== id) {
      hoveredCharmRef.current = id;
      setHoveredCharm(id);
    }

    // Position the preview card relative to the cursor
    setPreviewPosition({
      x: e.clientX - 32, // offset to the right of cursor
      y: e.clientY - 32, // offset above the cursor
    });
  }, []);

  const handleMouseLeave = useCallback(() => {
    hoveredCharmRef.current = null;
    setHoveredCharm(null);
  }, []);

  return useMemo(() => ({
    hoveredCharm,
    previewPosition,
    handleMouseMove,
    handleMouseLeave,
  }), [hoveredCharm, previewPosition, handleMouseMove, handleMouseLeave]);
}
