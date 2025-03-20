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

      // Get the current status every frame
      const currentStatus = status.current;

      // Clean buffer - remove activities older than 2 seconds
      const now = Date.now();

      // Update the status message in the tooltip
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

          // Update status message for reconnection
          statusMessage =
            `Offline - Reconnecting... (${currentStatus.connection.pending.error.reason})`;
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
      } // Check for push activities (sending to remote)
      else if (Object.keys(currentStatus.push).length > 0) {
        // Make ring visible with faster increase for push events
        opacityRef.current = Math.min(opacityRef.current + 0.1, 0.9);

        // Spin counter-clockwise for push events, speed based on number of pending requests
        const pendingPushes = Object.keys(currentStatus.push).length;
        const speed = Math.min(pendingPushes * 3, 12);
        rotationRef.current -= speed; // Counter-clockwise rotation

        // Set bright orange color for push events
        circle.setAttribute("stroke", "#FF5722"); // Bright orange color
        circle.setAttribute("strokeDasharray", "6 6");

        // Make stroke width thicker for better visibility
        circle.setAttribute("strokeWidth", "3");

        // Start or amplify bounce - use smaller values for subtle effect
        bounceRef.current = Math.min(bounceRef.current + 0.4, 1.5);

        // Apply subtle scale bounce to avatar
        const scaleAmount = 1 +
          (Math.sin(now / 100) * 0.02 * bounceRef.current);
        avatarRef.current.style.transform = `scale(${scaleAmount})`;

        // Set bright orange color for avatar glow during push
        avatarRef.current.style.boxShadow = `0 0 ${
          bounceRef.current * 3
        }px #FF5722`;

        // Update status message for push
        statusMessage = `Sending... (${pendingPushes} pending)`;
      } // Check for pull activities (receiving from remote)
      else if (Object.keys(currentStatus.pull).length > 0) {
        // Make ring visible with faster increase for pull events
        opacityRef.current = Math.min(opacityRef.current + 0.1, 0.9);

        // Spin clockwise for pull events, speed based on number of pending pulls
        const pendingPulls = Object.keys(currentStatus.pull).length;
        const speed = Math.min(pendingPulls * 3, 12);
        rotationRef.current += speed; // Clockwise rotation

        // Make sure the ring color is green for pull events
        circle.setAttribute("stroke", "#00BF57"); // Green color
        circle.setAttribute("strokeDasharray", "6 6");

        // Reset stroke width
        circle.setAttribute("strokeWidth", "2.5");

        // Reduce bounce for pull events
        bounceRef.current = Math.max(bounceRef.current - 0.2, 0);

        // Reset avatar
        avatarRef.current.style.transform = "scale(1)";
        avatarRef.current.style.boxShadow = "none";

        // Update status message for pull
        statusMessage = `Receiving... (${pendingPulls} pending)`;
      } // No activity
      else {
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

      // Apply ring opacity
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
          className="absolute top-8 left-1/2 -translate-x-1/2 bg-gray-800 text-white px-2 py-1 rounded text-sm opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-[1000]"
        >
          Click to log out
        </div>
      </div>
    </div>
  );
}
