import { useAuthentication } from "@/contexts/AuthenticationContext.tsx";
import {
  ConsumerCommandInvocation,
  Protocol,
  ProviderCommand,
  UCAN,
} from "@commontools/memory";
import * as Inspector from "@commontools/runner/storage/inspector";
import { FaArrowDown, FaArrowUp, FaExclamationTriangle } from "react-icons/fa";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  useStatusMonitor,
  useStorageBroadcast,
} from "@/components/NetworkInspector.tsx";
import { useAnimationSmoothing } from "@/hooks/use-animation-smoothing.ts";
import { useTheme } from "@/contexts/ThemeContext.tsx";

// Constants
const COLORS = {
  BLUE: "#4285F4",
  GREEN: "#00BF57",
  RED: "#FF0000",
};

const MIN_ANIMATION_DURATION = 800;

// Safe palette colors (avoiding red and green)
const AVATAR_COLORS = [
  "#4285F4", // Blue
  "#FBBC05", // Yellow
  "#9C27B0", // Purple
  "#FF6D00", // Orange
  "#3949AB", // Indigo
  "#00ACC1", // Cyan
  "#8D6E63", // Brown
  "#5E35B1", // Deep Purple
  "#FB8C00", // Dark Orange
  "#039BE5", // Light Blue
  "#C0CA33", // Lime
  "#F06292", // Pink
  "#546E7A", // Blue Grey
];

// SVG shape templates
const AVATAR_SHAPES = [
  // Rounded square
  (color: string) => `
    <svg width="30" height="30" viewBox="0 0 30 30">
      <rect x="3" y="3" width="24" height="24" rx="8" fill="${color}" />
    </svg>
  `,
  // Pudgy Star shape
  (color: string) => `
    <svg width="30" height="30" viewBox="0 0 30 30">
      <path d="M15 5 L17.5 12 L25 12 L19.5 17 L21.5 24 L15 20 L8.5 24 L10.5 17 L5 12 L12.5 12 Z" fill="${color}" />
      <circle cx="15" cy="15" r="7" fill="${color}" />
    </svg>
  `,
  // Flower/Sun shape
  (color: string) => `
    <svg width="30" height="30" viewBox="0 0 30 30">
      <circle cx="15" cy="15" r="9" fill="${color}" />
      <circle cx="15" cy="4" r="3" fill="${color}" />
      <circle cx="15" cy="26" r="3" fill="${color}" />
      <circle cx="4" cy="15" r="3" fill="${color}" />
      <circle cx="26" cy="15" r="3" fill="${color}" />
      <circle cx="7" cy="7" r="3" fill="${color}" />
      <circle cx="23" cy="23" r="3" fill="${color}" />
      <circle cx="7" cy="23" r="3" fill="${color}" />
      <circle cx="23" cy="7" r="3" fill="${color}" />
    </svg>
  `,
  // Cloud shape
  (color: string) => `
    <svg width="30" height="30" viewBox="0 0 30 30">
      <path d="M10 20 Q5 20 5 15 Q5 10 10 10 Q10 5 15 5 Q20 5 20 10 Q25 10 25 15 Q25 20 20 20 Z" fill="${color}" />
    </svg>
  `,
  // Pudgy Hexagon
  (color: string) => `
    <svg width="30" height="30" viewBox="0 0 30 30">
      <path d="M15 4 L25 9.5 L25 20.5 L15 26 L5 20.5 L5 9.5 Z" fill="${color}" />
      <path d="M15 6 L23 10.5 L23 19.5 L15 24 L7 19.5 L7 10.5 Z" fill="${color}" stroke="${color}" stroke-width="2" stroke-linejoin="round" />
    </svg>
  `,
];

function useAvatarGenerator(did: string | undefined) {
  const [avatarColor, setAvatarColor] = useState("");
  const [avatarShape, setAvatarShape] = useState("");

  useEffect(() => {
    if (!did) return;

    // Deterministic but random-looking selection
    const hashSum = Array.from(did).reduce(
      (sum, char, i) => sum + char.charCodeAt(0) * (i + 1),
      0,
    );

    // Select color from palette
    const colorIndex = hashSum % AVATAR_COLORS.length;
    const selectedColor = AVATAR_COLORS[colorIndex];
    setAvatarColor(selectedColor);

    // Select shape
    const shapeIndex = Math.floor(hashSum / AVATAR_COLORS.length) %
      AVATAR_SHAPES.length;
    const selectedShape = AVATAR_SHAPES[shapeIndex](selectedColor);
    setAvatarShape(selectedShape);
  }, [did]);

  return { avatarColor, avatarShape };
}

// Helper functions
const ease = (current: number, target: number, factor: number = 0.1) => {
  return current + (target - current) * factor;
};

const getCircleStyle = (
  color: string,
  dashArray: string | "none",
  width: string | number,
) => ({
  stroke: color,
  strokeDasharray: dashArray,
  strokeWidth: width,
});

const applyCircleStyle = (circle: SVGElement, style: {
  stroke: string;
  strokeDasharray: string | "none";
  strokeWidth: string | number;
}) => {
  circle.setAttribute("stroke", style.stroke);
  circle.setAttribute(
    "stroke-dasharray",
    style.strokeDasharray === "none" ? "" : style.strokeDasharray,
  );
  circle.setAttribute("stroke-width", style.strokeWidth.toString());
};

// Main component
export function User() {
  const { session, clearAuthentication } = useAuthentication();
  const [did, setDid] = useState<string | undefined>(undefined);
  const { status, updateStatus } = useStatusMonitor();
  const { avatarShape } = useAvatarGenerator(did);
  const { isDarkMode } = useTheme();

  // Define avatar size constant
  const AVATAR_SIZE = 24;
  // Calculate SVG size (avatar size + padding)
  const SVG_SIZE = AVATAR_SIZE + 8;
  // SVG center coordinate
  const SVG_CENTER = SVG_SIZE / 2;
  // SVG radius
  const SVG_RADIUS = SVG_CENTER - 2;

  // Refs
  const tooltipRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const avatarRef = useRef<HTMLDivElement>(null);
  const pushErrorRef = useRef<HTMLDivElement>(null);
  const pullErrorRef = useRef<HTMLDivElement>(null);

  // Animation state refs
  const rotationRef = useRef(0);
  const opacityRef = useRef(0);
  const bounceRef = useRef(0);
  const easedPushCountRef = useRef(0);
  const easedPullCountRef = useRef(0);

  // Use our shared animation smoothing hook
  const { updateValue, getValue, rafRef } = useAnimationSmoothing();

  // Get DID from session
  useEffect(() => {
    if (!session) return;
    console.log("User DID:", session.as.did());
    setDid(session.as.did());
    return () => setDid(undefined);
  }, [session]);

  // Listen for events
  useStorageBroadcast(updateStatus);

  // Animation logic
  useEffect(() => {
    const animate = () => {
      if (!svgRef.current || !avatarRef.current || !tooltipRef.current) {
        rafRef.current = requestAnimationFrame(animate);
        return;
      }

      const circle = svgRef.current.querySelector("circle");
      if (!circle) {
        rafRef.current = requestAnimationFrame(animate);
        return;
      }

      const now = Date.now();
      const currentStatus = status.current;

      // Count calculations
      const actualPushCount = Object.values(currentStatus.push).filter((v) =>
        v.ok
      ).length;
      const actualPullCount =
        Object.values(currentStatus.pull).filter((v) => v.ok).length;
      const pushErrorCount =
        Object.values(currentStatus.push).filter((v) => v.error).length;
      const pullErrorCount =
        Object.values(currentStatus.pull).filter((v) => v.error).length;
      const actualErrorCount = pushErrorCount + pullErrorCount;

      // Use our shared hook to update values with easing
      const pushResult = updateValue("push", actualPushCount);
      const pullResult = updateValue("pull", actualPullCount);
      const errorResult = updateValue("error", actualErrorCount);

      // Update our refs with the eased values
      easedPushCountRef.current = pushResult.value;
      easedPullCountRef.current = pullResult.value;

      // Use the more detailed states from our animation hook
      // hasActualValue = currently has a real value > 0
      // hadRecentActivity = had activity within the min animation duration window
      const pushActive = pushResult.hasActualValue;
      const pullActive = pullResult.hasActualValue;
      const errorActive = errorResult.hasActualValue;

      // If we have actual activity or recent activity with a positive value, animate
      const hasPushValues = pushResult.value > 0;
      const hasPullValues = pullResult.value > 0;
      const animatingPush = pushActive ||
        (pushResult.hadRecentActivity && hasPushValues && !pullActive);
      const animatingPull = pullActive ||
        (pullResult.hadRecentActivity && hasPullValues && !pushActive);

      // Display counts (the hook now handles minimum values)
      const displayPushCount = pushResult.value;
      const displayPullCount = pullResult.value;
      const displayErrorCount = errorResult.value;

      // Default status message
      let statusMessage = "Click to log out";

      // Connection state handling
      if (currentStatus.connection.pending) {
        const pulseIntensity = (Math.sin(now / 100) + 1) / 2;
        const isReconnection =
          currentStatus.connection.pending.error !== undefined;

        if (isReconnection) {
          // Reconnection state
          opacityRef.current = 0.3 + (pulseIntensity * 0.6);
          rotationRef.current = 0;

          applyCircleStyle(
            circle,
            getCircleStyle(
              COLORS.RED,
              "none",
              2 + pulseIntensity,
            ),
          );

          if (avatarRef.current) {
            avatarRef.current.style.boxShadow = `0 0 ${
              8 * pulseIntensity
            }px ${COLORS.RED}`;
          }

          statusMessage = "Reconnecting...";
        } else {
          // Initial connection
          opacityRef.current = 0.3 + (pulseIntensity * 0.4);
          rotationRef.current += 2;

          applyCircleStyle(
            circle,
            getCircleStyle(
              COLORS.BLUE,
              "6 6",
              "2.5",
            ),
          );

          if (avatarRef.current) {
            avatarRef.current.style.boxShadow = "none";
          }

          statusMessage = "Connecting...";
        }
      } else if (
        currentStatus.connection.ready && currentStatus.connection.ready.ok
      ) {
        // Connected state
        const baseOpacity = 0.6;
        const statusParts = [];

        if (displayPushCount > 0) statusParts.push(`↑${displayPushCount}`);
        if (displayPullCount > 0) statusParts.push(`↓${displayPullCount}`);
        if (displayErrorCount > 0) statusParts.push(`!${displayErrorCount}`);

        statusMessage = statusParts.length > 0 ? statusParts.join(" ") : "Idle";

        if (animatingPush) {
          // Push events
          const intensity = Math.max(easedPushCountRef.current, 0.3);
          opacityRef.current = Math.min(opacityRef.current + 0.1, 0.9);

          const speed = Math.min(intensity * 3, 12);
          rotationRef.current -= speed;

          applyCircleStyle(
            circle,
            getCircleStyle(
              COLORS.GREEN,
              "6 6",
              "3",
            ),
          );

          bounceRef.current = Math.min(bounceRef.current + 0.4, 1.5);

          const scaleAmount = 1 +
            (Math.sin(now / 100) * 0.02 * bounceRef.current);
          avatarRef.current.style.transform = `scale(${scaleAmount})`;
          avatarRef.current.style.boxShadow = `0 0 ${
            bounceRef.current * 3
          }px ${COLORS.GREEN}`;
        } else if (animatingPull) {
          // Pull events
          const intensity = Math.max(easedPullCountRef.current, 0.3);
          opacityRef.current = Math.min(opacityRef.current + 0.1, 0.9);

          const speed = Math.min(intensity * 3, 12);
          rotationRef.current += speed;

          applyCircleStyle(
            circle,
            getCircleStyle(
              COLORS.GREEN,
              "6 6",
              "2.5",
            ),
          );

          bounceRef.current = Math.max(bounceRef.current - 0.2, 0);

          avatarRef.current.style.transform = "scale(1)";
          avatarRef.current.style.boxShadow = "none";
        } else if (errorActive) {
          // Error state
          const pulseIntensity = (Math.sin(now / 300) + 1) / 2;
          opacityRef.current = Math.min(opacityRef.current + 0.1, 0.9);
          rotationRef.current += Math.sin(now / 200) * 0.5;

          applyCircleStyle(
            circle,
            getCircleStyle(
              COLORS.RED,
              "3 3",
              2 + pulseIntensity,
            ),
          );

          avatarRef.current.style.boxShadow = `0 0 ${
            4 * pulseIntensity
          }px ${COLORS.RED}`;

          // Handle error indicators
          if (pushErrorRef.current && pushErrorCount > 0) {
            pushErrorRef.current.style.opacity =
              (Math.sin(now / 200) + 1) / 2 > 0.5 ? "1" : "0.7";
            pushErrorRef.current.style.display = "flex";
          } else if (pushErrorRef.current) {
            pushErrorRef.current.style.display = "none";
          }

          if (pullErrorRef.current && pullErrorCount > 0) {
            pullErrorRef.current.style.opacity =
              (Math.sin(now / 200) + 1) / 2 > 0.5 ? "1" : "0.7";
            pullErrorRef.current.style.display = "flex";
          } else if (pullErrorRef.current) {
            pullErrorRef.current.style.display = "none";
          }
        } else {
          // Stable connection
          opacityRef.current = baseOpacity;
          rotationRef.current *= 0.9;

          applyCircleStyle(
            circle,
            getCircleStyle(
              COLORS.GREEN,
              "none",
              "2",
            ),
          );

          bounceRef.current = Math.max(bounceRef.current - 0.2, 0);

          avatarRef.current.style.transform = "scale(1)";
          avatarRef.current.style.boxShadow = "none";

          if (pushErrorRef.current) pushErrorRef.current.style.display = "none";
          if (pullErrorRef.current) pullErrorRef.current.style.display = "none";
        }
      } else {
        // Default state
        opacityRef.current = Math.max(opacityRef.current - 0.1, 0);
        rotationRef.current *= 0.9;

        applyCircleStyle(
          circle,
          getCircleStyle(
            COLORS.BLUE,
            "6 6",
            "2.5",
          ),
        );

        bounceRef.current = Math.max(bounceRef.current - 0.2, 0);

        avatarRef.current.style.transform = "scale(1)";
        avatarRef.current.style.boxShadow = "none";

        statusMessage = "Click to log out";
      }

      // Update UI
      tooltipRef.current.textContent = statusMessage;
      svgRef.current.style.opacity = opacityRef.current.toString();
      circle.setAttribute(
        "transform",
        `rotate(${rotationRef.current}, ${SVG_CENTER}, ${SVG_CENTER})`,
      );

      // Continue animation
      rafRef.current = requestAnimationFrame(animate);
    };

    // Start animation using our shared RAF reference
    rafRef.current = requestAnimationFrame(animate);

    // Cleanup
    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [updateValue, rafRef]);

  return (
    <div className="relative group">
      <div
        ref={avatarRef}
        className="user-avatar flex items-center justify-center cursor-pointer overflow-hidden bg-white dark:bg-gray-700 hover:bg-gray-100 dark:hover:bg-gray-600 rounded-full"
        style={{ width: AVATAR_SIZE, height: AVATAR_SIZE }}
        onClick={() => clearAuthentication()}
      >
        <div
          className="w-full h-full flex items-center justify-center"
          dangerouslySetInnerHTML={{ __html: avatarShape }}
        >
        </div>
      </div>

      <svg
        ref={svgRef}
        className="absolute"
        style={{
          width: SVG_SIZE,
          height: SVG_SIZE,
          left: -4,
          top: -4,
          transform: `rotate(${rotationRef.current}deg)`,
        }}
      >
        <circle
          cx={SVG_CENTER}
          cy={SVG_CENTER}
          r={SVG_RADIUS}
          fill="none"
          stroke={COLORS.BLUE}
          strokeWidth="1.5"
          strokeDasharray="0"
        />
      </svg>

      {/* Activity indicators */}
      <div
        ref={pushErrorRef}
        className={`absolute -top-1 -right-1 w-3 h-3 bg-red-500 rounded-full ${
          bounceRef.current > 0 ? "scale-110" : "scale-100"
        } transition-transform`}
        style={{ opacity: opacityRef.current }}
      >
        <div className="absolute inset-0 bg-red-500 rounded-full animate-ping opacity-75">
        </div>
      </div>

      <div
        ref={pullErrorRef}
        className={`absolute -bottom-1 -right-1 w-3 h-3 bg-orange-500 rounded-full ${
          bounceRef.current > 0 ? "scale-110" : "scale-100"
        } transition-transform`}
        style={{ opacity: opacityRef.current }}
      >
        <div className="absolute inset-0 bg-orange-500 rounded-full animate-ping opacity-75">
        </div>
      </div>

      {/* Tooltip */}
      <div
        ref={tooltipRef}
        className="absolute right-0 top-full mt-2 p-2 rounded-md shadow-lg z-10 text-xs whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity bg-white dark:bg-dark-bg-tertiary text-black dark:text-dark-text-primary border border-gray-200 dark:border-dark-border"
      >
        <div className="text-center user-status">Status: Connected</div>
        <div className="flex gap-1 items-center">
          <FaArrowUp className="text-blue-500" />
          <span className="push-count">0</span>
          <FaArrowDown className="text-purple-500 ml-1" />
          <span className="pull-count">0</span>
          <FaExclamationTriangle className="text-orange-500 ml-1" />
          <span className="error-count">0</span>
        </div>
      </div>
    </div>
  );
}
