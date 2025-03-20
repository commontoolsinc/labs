import { useAuthentication } from "@/contexts/AuthenticationContext.tsx";
import {
  ConsumerCommandInvocation,
  Protocol,
  ProviderCommand,
  UCAN,
} from "@commontools/memory";
import * as Inspector from "@commontools/runner/storage/inspector";

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

  // Animation refs
  const svgRef = useRef<SVGSVGElement>(null);
  const animationRef = useRef<number | null>(null);
  const rotationRef = useRef(0);
  const opacityRef = useRef(0);
  const bounceRef = useRef(0);
  const avatarRef = useRef<HTMLDivElement>(null);

  // Avatar color calculation
  useEffect(() => {
    if (!session) return;
    setDid(session.as.did());
    return () => setDid(undefined);
  }, [session]);

  let h = "0", s = "50%";
  const l = "50%";
  if (did) {
    const index = did.length - 4;
    h = `${did.charCodeAt(index) + did.charCodeAt(index + 1)}`;
    s = `${50 + ((did.charCodeAt(index + 2) - 49) / 73) * 50}%`;
  }

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
          circle.setAttribute("strokeDasharray", "none");
          circle.setAttribute("strokeWidth", String(2 + pulseIntensity)); // Pulse stroke width too

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
          circle.setAttribute("strokeDasharray", "6 6");
          circle.setAttribute("strokeWidth", "2.5");

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
          ? `Status: ${statusParts.join(" ")}`
          : "Connected";

        // Use both active state and eased counts for animation properties
        if (pushActive) {
          // Animation intensity based on eased count or minimum value for visibility
          const intensity = Math.max(easedPushCountRef.current, 0.3);

          // Make ring visible with faster increase for push events
          opacityRef.current = Math.min(opacityRef.current + 0.1, 0.9);

          // Spin counter-clockwise for push events
          const speed = Math.min(intensity * 3, 12);
          rotationRef.current -= speed;

          // Set bright orange color for push events
          circle.setAttribute("stroke", "#FF5722");
          circle.setAttribute("strokeDasharray", "6 6");
          circle.setAttribute("strokeWidth", "3");

          // Amplify bounce effect
          bounceRef.current = Math.min(bounceRef.current + 0.4, 1.5);

          // Apply subtle scale bounce to avatar
          const scaleAmount = 1 +
            (Math.sin(now / 100) * 0.02 * bounceRef.current);
          avatarRef.current.style.transform = `scale(${scaleAmount})`;

          // Set bright orange color for avatar glow during push
          avatarRef.current.style.boxShadow = `0 0 ${
            bounceRef.current * 3
          }px #FF5722`;
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
          circle.setAttribute("strokeDasharray", "6 6");
          circle.setAttribute("strokeWidth", "2.5");

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
          circle.setAttribute("strokeDasharray", "3 3");
          circle.setAttribute("strokeWidth", String(2 + pulseIntensity));

          // Subtle error animation for avatar
          avatarRef.current.style.boxShadow = `0 0 ${
            4 * pulseIntensity
          }px #FF0000`;
        } else {
          // Fade out ring
          opacityRef.current = Math.max(opacityRef.current - 0.1, 0);

          // Slow down rotation
          rotationRef.current *= 0.9;

          // Reset stroke width
          circle.setAttribute("strokeWidth", "2.5");
          circle.setAttribute("strokeDasharray", "6 6");

          // Reduce bounce
          bounceRef.current = Math.max(bounceRef.current - 0.2, 0);

          // Reset avatar
          avatarRef.current.style.transform = "scale(1)";
          avatarRef.current.style.boxShadow = "none";
        }
      } else {
        // Fade out ring
        opacityRef.current = Math.max(opacityRef.current - 0.1, 0);

        // Slow down rotation
        rotationRef.current *= 0.9;

        // Reset stroke width
        circle.setAttribute("strokeWidth", "2.5");
        circle.setAttribute("strokeDasharray", "6 6");

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

      {/* User Avatar */}
      <div
        id="user-avatar"
        ref={avatarRef}
        onClick={clearAuthentication}
        style={{
          width: "30px",
          height: "30px",
          backgroundColor: `hsl(${h}, ${s}, ${l})`,
          transition: "box-shadow 0.2s ease",
          transformOrigin: "center center",
        }}
        className="relative group flex items-center rounded-full text-sm cursor-pointer"
      >
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
