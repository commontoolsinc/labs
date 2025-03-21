import { useAuthentication } from "@/contexts/AuthenticationContext.tsx";
import {
  ConsumerCommandInvocation,
  Protocol,
  ProviderCommand,
  UCAN,
} from "@commontools/memory";
import * as Inspector from "@commontools/runner/storage/inspector";
import { FaArrowDown, FaArrowUp, FaExclamationTriangle } from "react-icons/fa";

import { useEffect, useRef, useState } from "react";

interface MemoryChange {
  post: UCAN<ConsumerCommandInvocation<Protocol>>;

  receipt: ProviderCommand<Protocol>;

  transact?: {
    changes: Record<string, any>;
  };

  commit?: {
    result: { ok: object; error?: void } | { ok?: void; error: Error };
    spaces: number;
    subscriptions: number;
    localChanges: number;
  };
  // send?: {
  //   command: {
  //     cmd: string;
  //   };
  // };
  receive?: {
    the: string;
    of: string;
    is: Record<string, any>;
  };
  connected?: {
    connectionStatus: "connected";
    connectionCount: number;
  };
  disconnected?: {
    connectionStatus: "disconnected";
    reason: string;
  };
  subscription?: {
    entity: string;
    subscriberCount: number;
    totalSubscriptions: number;
  };
  timeout?: {
    connectionStatus: "timeout";
    description: string;
  };
  timestamp: string;
}

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

// SVG shape templates - cute shapes with rounded corners
const AVATAR_SHAPES = [
  // Rounded square
  (color: string) => `
    <svg width="30" height="30" viewBox="0 0 30 30">
      <rect x="3" y="3" width="24" height="24" rx="8" fill="${color}" />
    </svg>
  `,
  // Star shape
  (color: string) => `
    <svg width="30" height="30" viewBox="0 0 30 30">
      <path d="M15 3 L18 12 L27 12 L20 18 L23 27 L15 21 L7 27 L10 18 L3 12 L12 12 Z" fill="${color}" />
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
  // Hexagon
  (color: string) => `
    <svg width="30" height="30" viewBox="0 0 30 30">
      <path d="M15 4 L25 9.5 L25 20.5 L15 26 L5 20.5 L5 9.5 Z" fill="${color}" />
    </svg>
  `,
];

export function useStorageBroadcast(callback: (data: any) => void) {
  useEffect(() => {
    const messages = new BroadcastChannel("storage/remote");
    messages.onmessage = ({ data }) => callback(data);

    return () => {
      messages.close();
    };
  }, [callback]);
}

export function User() {
  const { session, clearAuthentication } = useAuthentication();
  const [did, setDid] = useState<string | undefined>(undefined);
  const status = useRef(Inspector.create());
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [avatarColor, setAvatarColor] = useState<string>("");
  const [avatarShape, setAvatarShape] = useState<string>("");

  // Animation refs
  const svgRef = useRef<SVGSVGElement>(null);
  const animationRef = useRef<number | null>(null);
  const rotationRef = useRef(0);
  const opacityRef = useRef(0);
  const bounceRef = useRef(0);
  const avatarRef = useRef<HTMLDivElement>(null);
  const pushErrorRef = useRef<HTMLDivElement>(null);
  const pullErrorRef = useRef<HTMLDivElement>(null);

  // Avatar generation based on DID
  useEffect(() => {
    if (!session) return;
    setDid(session.as.did());
    return () => setDid(undefined);
  }, [session]);

  // Generate consistent avatar based on DID
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

  // Listen for real events
  useStorageBroadcast((command: Inspector.Command) => {
    if (!status.current) {
      throw new Error("Status is not initialized");
    }

    const state = Inspector.update(status.current, command);
    console.log(command, state);
    status.current = state;
  });

  // Add refs to store the eased count values
  const easedPushCountRef = useRef(0);
  const easedPullCountRef = useRef(0);
  const easedErrorCountRef = useRef(0);

  // Add timestamps for minimum animation durations
  const lastPushTimestampRef = useRef(0);
  const lastPullTimestampRef = useRef(0);
  const lastErrorTimestampRef = useRef(0);

  // Minimum animation duration in milliseconds
  const MIN_ANIMATION_DURATION = 1500;

  // Helper function for easing
  const ease = (current: number, target: number, factor: number = 0.1) => {
    return current + (target - current) * factor;
  };

  // Animation logic with requestAnimationFrame
  useEffect(() => {
    // Animation function
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

      // Get the current status every frame
      const currentStatus = status.current;

      // Calculate actual push, pull, and error counts
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

      // Track when counts change to maintain minimum animation duration
      if (actualPushCount > Math.round(easedPushCountRef.current)) {
        lastPushTimestampRef.current = now;
      }
      if (actualPullCount > Math.round(easedPullCountRef.current)) {
        lastPullTimestampRef.current = now;
      }
      if (actualErrorCount > Math.round(easedErrorCountRef.current)) {
        lastErrorTimestampRef.current = now;
      }

      // Calculate whether we should still show animations based on minimum duration
      const pushActive = actualPushCount > 0 ||
        (now - lastPushTimestampRef.current < MIN_ANIMATION_DURATION);
      const pullActive = actualPullCount > 0 ||
        (now - lastPullTimestampRef.current < MIN_ANIMATION_DURATION);
      const errorActive = actualErrorCount > 0 ||
        (now - lastErrorTimestampRef.current < MIN_ANIMATION_DURATION);

      // Enhanced easing with time-based falloff
      const easingFactor = 0.06; // Slightly slower easing for better visibility
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

      // Round for display - only show integers
      const displayPushCount = Math.round(easedPushCountRef.current);
      const displayPullCount = Math.round(easedPullCountRef.current);
      const displayErrorCount = Math.round(easedErrorCountRef.current);

      // Use these eased counts for animation and display
      let statusMessage = "Click to log out";

      // Check for connection state
      if (currentStatus.connection.pending) {
        // Create pulsing effect using sine wave
        const pulseIntensity = (Math.sin(now / 100) + 1) / 2; // Values between 0 and 1

        // Determine if this is first connection attempt or a reconnection
        const isReconnection =
          currentStatus.connection.pending.error !== undefined;

        if (isReconnection) {
          // This is a reconnection attempt after a failure
          opacityRef.current = 0.3 + (pulseIntensity * 0.6); // Pulse between 0.3 and 0.9 opacity

          // Stop rotation for disconnected state
          rotationRef.current = 0;

          // Set red color for disconnected state
          circle.setAttribute("stroke", "#FF0000");

          // Use solid stroke for disconnected state
          circle.setAttribute("stroke-dasharray", "none");
          circle.setAttribute("stroke-width", String(2 + pulseIntensity)); // Pulse stroke width too

          // Add pulsing red glow to avatar
          if (avatarRef.current) {
            avatarRef.current.style.boxShadow = `0 0 ${
              8 * pulseIntensity
            }px #FF0000`;
          }

          // Update status message for reconnection with error
          statusMessage = "Reconnecting...";
        } else {
          // This is initial connection attempt
          opacityRef.current = 0.3 + (pulseIntensity * 0.4); // Pulse between 0.3 and 0.7 opacity

          // Slow rotation for connecting state
          rotationRef.current += 2;

          // Set blue color for connecting state
          circle.setAttribute("stroke", "#4285F4");

          // Use dashed stroke for connecting state
          circle.setAttribute("stroke-dasharray", "6 6");
          circle.setAttribute("stroke-width", "2.5");

          // No special glow for avatar during initial connection
          if (avatarRef.current) {
            avatarRef.current.style.boxShadow = "none";
          }

          // Update status message for initial connection
          statusMessage = "Connecting...";
        }
      } else if (
        currentStatus.connection.ready && currentStatus.connection.ready.ok
      ) {
        // Connection is ready and established

        // Set a default opacity for a stable connection
        // This will keep the circle visible in a stable state
        const baseOpacity = 0.6; // Increased from 0.3 to make it more visible

        // Update the status parts for the tooltip
        const statusParts = [];

        // Only show whole numbers in the status display
        if (displayPushCount > 0) {
          statusParts.push(`↑${displayPushCount}`);
        }

        if (displayPullCount > 0) {
          statusParts.push(`↓${displayPullCount}`);
        }

        if (displayErrorCount > 0) {
          statusParts.push(`!${displayErrorCount}`);
        }

        statusMessage = statusParts.length > 0
          ? `${statusParts.join(" ")}`
          : "Idle";

        // Use both active state and eased counts for animation properties
        if (pushActive) {
          // Animation intensity based on eased count or minimum value for visibility
          const intensity = Math.max(easedPushCountRef.current, 0.3);

          // Make ring visible with faster increase for push events
          opacityRef.current = Math.min(opacityRef.current + 0.1, 0.9);

          // Spin counter-clockwise for push events
          const speed = Math.min(intensity * 3, 12);
          rotationRef.current -= speed;

          // Set green color for push events (changed from orange to green)
          circle.setAttribute("stroke", "#00BF57");
          // Use dashed stroke for push events (active data transfer)
          circle.setAttribute("stroke-dasharray", "6 6");
          circle.setAttribute("stroke-width", "3");

          // Amplify bounce effect
          bounceRef.current = Math.min(bounceRef.current + 0.4, 1.5);

          // Apply subtle scale bounce to avatar
          const scaleAmount = 1 +
            (Math.sin(now / 100) * 0.02 * bounceRef.current);
          avatarRef.current.style.transform = `scale(${scaleAmount})`;

          // Set green glow for avatar during push (changed from orange to green)
          avatarRef.current.style.boxShadow = `0 0 ${
            bounceRef.current * 3
          }px #00BF57`;
        } else if (pullActive) {
          // Animation intensity based on eased count or minimum value for visibility
          const intensity = Math.max(easedPullCountRef.current, 0.3);

          // Make ring visible with faster increase for pull events
          opacityRef.current = Math.min(opacityRef.current + 0.1, 0.9);

          // Spin clockwise for pull events
          const speed = Math.min(intensity * 3, 12);
          rotationRef.current += speed;

          // Make sure the ring color is green for pull events
          circle.setAttribute("stroke", "#00BF57");
          // Use dashed stroke for pull events (active data transfer)
          circle.setAttribute("stroke-dasharray", "6 6");
          circle.setAttribute("stroke-width", "2.5");

          // Reduce bounce for pull events but maintain some animation
          bounceRef.current = Math.max(bounceRef.current - 0.2, 0);

          // Reset avatar
          avatarRef.current.style.transform = "scale(1)";
          avatarRef.current.style.boxShadow = "none";
        } else if (errorActive) {
          // Special animation for errors that persists for the minimum duration
          const pulseIntensity = (Math.sin(now / 300) + 1) / 2;

          opacityRef.current = Math.min(opacityRef.current + 0.1, 0.9);

          // Subtle rotation for error state
          rotationRef.current += Math.sin(now / 200) * 0.5;

          // Use red color for errors
          circle.setAttribute("stroke", "#FF0000");
          // Use dashed stroke for error state
          circle.setAttribute("stroke-dasharray", "3 3");
          circle.setAttribute("stroke-width", String(2 + pulseIntensity));

          // Subtle error animation for avatar
          avatarRef.current.style.boxShadow = `0 0 ${
            4 * pulseIntensity
          }px #FF0000`;

          // Determine if there are push errors or pull errors
          const pushErrorCount =
            Object.values(currentStatus.push).filter((v) => v.error).length;
          const pullErrorCount = Object.values(currentStatus.pull).filter((v) =>
            v.error
          ).length;

          // Show the appropriate error indicator
          if (pushErrorRef.current && pushErrorCount > 0) {
            // Flash animation using opacity
            pushErrorRef.current.style.opacity =
              (Math.sin(now / 200) + 1) / 2 > 0.5 ? "1" : "0.7";
            pushErrorRef.current.style.display = "flex";
          } else if (pushErrorRef.current) {
            pushErrorRef.current.style.display = "none";
          }

          if (pullErrorRef.current && pullErrorCount > 0) {
            // Flash animation using opacity
            pullErrorRef.current.style.opacity =
              (Math.sin(now / 200) + 1) / 2 > 0.5 ? "1" : "0.7";
            pullErrorRef.current.style.display = "flex";
          } else if (pullErrorRef.current) {
            pullErrorRef.current.style.display = "none";
          }
        } else {
          // Stable connection state - show a solid green ring
          opacityRef.current = baseOpacity; // Keep the circle visible at the base opacity

          // Slow down any existing rotation
          rotationRef.current *= 0.9;

          // Set green color for stable connection
          circle.setAttribute("stroke", "#00BF57");

          // Use solid stroke for stable connection - using the correct attribute name
          circle.setAttribute("stroke-dasharray", "none");
          circle.setAttribute("stroke-width", "2");

          // Reduce bounce
          bounceRef.current = Math.max(bounceRef.current - 0.2, 0);

          // Reset avatar
          avatarRef.current.style.transform = "scale(1)";
          avatarRef.current.style.boxShadow = "none";

          // Hide error indicators when not in error state
          if (pushErrorRef.current) pushErrorRef.current.style.display = "none";
          if (pullErrorRef.current) pullErrorRef.current.style.display = "none";
        }
      } else {
        // Fade out ring
        opacityRef.current = Math.max(opacityRef.current - 0.1, 0);

        // Slow down rotation
        rotationRef.current *= 0.9;

        // Reset stroke width
        circle.setAttribute("stroke-width", "2.5");
        circle.setAttribute("stroke-dasharray", "6 6");

        // Reduce bounce
        bounceRef.current = Math.max(bounceRef.current - 0.2, 0);

        // Reset avatar
        avatarRef.current.style.transform = "scale(1)";
        avatarRef.current.style.boxShadow = "none";

        // Default status message
        statusMessage = "Click to log out";
      }

      // Update tooltip text content in the animation loop
      tooltipRef.current.textContent = statusMessage;

      // Apply ring opacity with a minimum for animation visibility
      svgRef.current.style.opacity = opacityRef.current.toString();

      // Apply rotation to the ring
      circle.setAttribute(
        "transform",
        `rotate(${rotationRef.current}, 19, 19)`,
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
  }, []); // Empty dependency array as we're checking status.current in every frame
  return (
    <div className="relative">
      {/* SVG Ring with requestAnimationFrame animation */}
      <svg
        ref={svgRef}
        width="38"
        height="38"
        viewBox="0 0 38 38"
        style={{
          position: "absolute",
          top: "-4px",
          left: "-4px",
          opacity: 0,
          pointerEvents: "none",
        }}
      >
        <circle
          cx="19"
          cy="19"
          r="17"
          fill="none"
          stroke="#4285F4"
          strokeWidth="2.5"
          strokeDasharray="6 6"
          strokeLinecap="round"
        />
      </svg>

      {/* User Avatar Container */}
      <div
        id="user-avatar-container"
        onClick={clearAuthentication}
        className="relative group cursor-pointer"
        style={{
          width: "30px",
          height: "30px",
        }}
      >
        <div
          ref={avatarRef}
          style={{
            width: "30px",
            height: "30px",
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
