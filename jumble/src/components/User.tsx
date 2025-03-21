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

// Custom hooks
export function useStorageBroadcast(callback: (data: any) => void) {
  useEffect(() => {
    const messages = new BroadcastChannel("storage/remote");
    messages.onmessage = ({ data }) => callback(data);
    return () => messages.close();
  }, [callback]);
}

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

function useStatusMonitor() {
  const status = useRef(Inspector.create());

  const updateStatus = useCallback((command: Inspector.Command) => {
    if (!status.current) {
      throw new Error("Status is not initialized");
    }
    const state = Inspector.update(status.current, command);
    status.current = state;
  }, []);

  return { status, updateStatus };
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
  const animationRef = useRef<number | null>(null);
  const rotationRef = useRef(0);
  const opacityRef = useRef(0);
  const bounceRef = useRef(0);
  const easedPushCountRef = useRef(0);
  const easedPullCountRef = useRef(0);
  const easedErrorCountRef = useRef(0);
  const lastPushTimestampRef = useRef(0);
  const lastPullTimestampRef = useRef(0);
  const lastErrorTimestampRef = useRef(0);

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
        animationRef.current = requestAnimationFrame(animate);
        return;
      }

      const circle = svgRef.current.querySelector("circle");
      if (!circle) {
        animationRef.current = requestAnimationFrame(animate);
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

      // Update timestamps for animation duration
      if (actualPushCount > Math.round(easedPushCountRef.current)) {
        lastPushTimestampRef.current = now;
      }
      if (actualPullCount > Math.round(easedPullCountRef.current)) {
        lastPullTimestampRef.current = now;
      }
      if (actualErrorCount > Math.round(easedErrorCountRef.current)) {
        lastErrorTimestampRef.current = now;
      }

      // Activity states
      const pushActive = actualPushCount > 0 ||
        (now - lastPushTimestampRef.current < MIN_ANIMATION_DURATION);
      const pullActive = actualPullCount > 0 ||
        (now - lastPullTimestampRef.current < MIN_ANIMATION_DURATION);
      const errorActive = actualErrorCount > 0 ||
        (now - lastErrorTimestampRef.current < MIN_ANIMATION_DURATION);

      // Ease count values
      const easingFactor = 0.06;
      easedPushCountRef.current = ease(
        easedPushCountRef.current,
        pushActive ? Math.max(actualPushCount, 0.01) : 0,
        easingFactor,
      );
      easedPullCountRef.current = ease(
        easedPullCountRef.current,
        pullActive ? Math.max(actualPullCount, 0.01) : 0,
        easingFactor,
      );
      easedErrorCountRef.current = ease(
        easedErrorCountRef.current,
        errorActive ? Math.max(actualErrorCount, 0.01) : 0,
        easingFactor,
      );

      // Display counts - even if count is 0 but animation is active, show at least 1
      const displayPushCount =
        pushActive && Math.round(easedPushCountRef.current) === 0
          ? 1
          : Math.round(easedPushCountRef.current);
      const displayPullCount =
        pullActive && Math.round(easedPullCountRef.current) === 0
          ? 1
          : Math.round(easedPullCountRef.current);
      const displayErrorCount =
        errorActive && Math.round(easedErrorCountRef.current) === 0
          ? 1
          : Math.round(easedErrorCountRef.current);

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

        if (pushActive) {
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
        } else if (pullActive) {
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
      animationRef.current = requestAnimationFrame(animate);
    };

    // Start animation
    animationRef.current = requestAnimationFrame(animate);

    // Cleanup
    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, []);

  return (
    <div className="relative">
      {/* SVG Ring with requestAnimationFrame animation */}
      <svg
        ref={svgRef}
        width={SVG_SIZE}
        height={SVG_SIZE}
        viewBox={`0 0 ${SVG_SIZE} ${SVG_SIZE}`}
        style={{
          position: "absolute",
          top: "-4px",
          left: "-4px",
          opacity: 0,
          pointerEvents: "none",
          backgroundColor: "white",
          borderRadius: "50%",
        }}
      >
        <circle
          cx={SVG_CENTER}
          cy={SVG_CENTER}
          r={SVG_RADIUS}
          fill="none"
          stroke={COLORS.BLUE}
          strokeWidth="2.5"
          strokeDasharray="6 6"
          strokeLinecap="round"
        />
      </svg>

      {/* User Avatar Container */}
      <div
        id="user-avatar"
        onClick={clearAuthentication}
        className="relative group cursor-pointer"
        style={{ width: `${AVATAR_SIZE}px`, height: `${AVATAR_SIZE}px` }}
      >
        <div
          ref={avatarRef}
          style={{
            width: `${AVATAR_SIZE}px`,
            height: `${AVATAR_SIZE}px`,
            transition: "box-shadow 0.2s ease",
            transformOrigin: "center center",
            borderRadius: "50%",
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
          }}
          dangerouslySetInnerHTML={{ __html: avatarShape }}
        />

        {/* Push Error Indicator */}
        <div
          ref={pushErrorRef}
          style={{
            display: "none",
            position: "absolute",
            top: "-8px",
            right: "-8px",
            backgroundColor: "red",
            borderRadius: "50%",
            width: "18px",
            height: "18px",
            alignItems: "center",
            justifyContent: "center",
            boxShadow: "0 0 5px rgba(255,0,0,0.7)",
            zIndex: 10,
          }}
        >
          <div className="flex items-center">
            <FaExclamationTriangle size={8} color="white" />
            <FaArrowUp size={6} color="white" />
          </div>
        </div>

        {/* Pull Error Indicator */}
        <div
          ref={pullErrorRef}
          style={{
            display: "none",
            position: "absolute",
            bottom: "-8px",
            right: "-8px",
            backgroundColor: "red",
            borderRadius: "50%",
            width: "18px",
            height: "18px",
            alignItems: "center",
            justifyContent: "center",
            boxShadow: "0 0 5px rgba(255,0,0,0.7)",
            zIndex: 10,
          }}
        >
          <div className="flex items-center">
            <FaExclamationTriangle size={8} color="white" />
            <FaArrowDown size={6} color="white" />
          </div>
        </div>

        <div
          ref={tooltipRef}
          className="absolute top-8 left-1/2 -translate-x-1/2 bg-gray-800 text-white px-2 py-1 rounded text-sm opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-[9999]"
        >
          Click to log out
        </div>
      </div>
    </div>
  );
}
