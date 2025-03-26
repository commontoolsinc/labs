import { useCallback, useRef, useState } from "react";

// A shared hook for resizable drawers that could be imported in both components
export function useResizableDrawer({
  initialHeight = 240,
  minHeight = 150,
  maxHeightFactor = 0.8,
  resizeDirection = "up", // 'up' for Inspector (resize from bottom to top), 'down' for CharmDetailView (resize from top to bottom)
} = {}) {
  const [drawerHeight, setDrawerHeight] = useState<number>(initialHeight);
  const [isResizing, setIsResizing] = useState(false);
  const resizeStartY = useRef<number | null>(null);
  const startHeight = useRef<number | null>(null);

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      resizeStartY.current = e.clientY;
      startHeight.current = drawerHeight;
      setIsResizing(true);

      // Add a layer over the entire document to capture events
      const overlay = document.createElement("div");
      overlay.id = "resize-overlay";
      overlay.style.position = "fixed";
      overlay.style.top = "0";
      overlay.style.left = "0";
      overlay.style.width = "100%";
      overlay.style.height = "100%";
      overlay.style.zIndex = "9999";
      overlay.style.cursor = "ns-resize";
      document.body.appendChild(overlay);

      const handleResizeMove = (e: MouseEvent) => {
        if (resizeStartY.current !== null && startHeight.current !== null) {
          // Calculate the difference based on resize direction
          const diff = resizeDirection === "up"
            ? e.clientY - resizeStartY.current // Inspector - moving up increases height
            : resizeStartY.current - e.clientY; // CharmDetailView - moving down increases height

          const newHeight = Math.max(
            minHeight,
            Math.min(
              globalThis.innerHeight * maxHeightFactor,
              startHeight.current + diff,
            ),
          );
          setDrawerHeight(newHeight);
        }
      };

      const handleResizeEnd = () => {
        resizeStartY.current = null;
        startHeight.current = null;
        setIsResizing(false);

        // Remove overlay
        const overlay = document.getElementById("resize-overlay");
        if (overlay) {
          document.body.removeChild(overlay);
        }

        document.removeEventListener("mousemove", handleResizeMove);
        document.removeEventListener("mouseup", handleResizeEnd);
      };

      document.addEventListener("mousemove", handleResizeMove);
      document.addEventListener("mouseup", handleResizeEnd);
    },
    [drawerHeight, resizeDirection, minHeight, maxHeightFactor],
  );

  const handleTouchResizeStart = useCallback(
    (e: React.TouchEvent) => {
      e.preventDefault();
      if (e.touches.length === 1) {
        resizeStartY.current = e.touches[0].clientY;
        startHeight.current = drawerHeight;
        setIsResizing(true);
      }

      const handleTouchMove = (e: TouchEvent) => {
        if (
          resizeStartY.current !== null &&
          startHeight.current !== null &&
          e.touches.length === 1
        ) {
          // Calculate the difference based on resize direction
          const diff = resizeDirection === "up"
            ? e.touches[0].clientY - resizeStartY.current // Inspector
            : resizeStartY.current - e.touches[0].clientY; // CharmDetailView

          const newHeight = Math.max(
            minHeight,
            Math.min(
              globalThis.innerHeight * maxHeightFactor,
              startHeight.current + diff,
            ),
          );
          setDrawerHeight(newHeight);
        }
      };

      const handleTouchEnd = () => {
        resizeStartY.current = null;
        startHeight.current = null;
        setIsResizing(false);
        document.removeEventListener("touchmove", handleTouchMove);
        document.removeEventListener("touchend", handleTouchEnd);
      };

      document.addEventListener("touchmove", handleTouchMove, {
        passive: false,
      });
      document.addEventListener("touchend", handleTouchEnd);
    },
    [drawerHeight, resizeDirection, minHeight, maxHeightFactor],
  );

  return {
    drawerHeight,
    isResizing,
    handleResizeStart,
    handleTouchResizeStart,
  };
}
