import { useAuthentication } from "@/contexts/AuthenticationContext.tsx";
import {
  AuthorizationError,
  ConflictError,
  ConnectionError,
  ConsumerCommand,
  ConsumerCommandInvocation,
  MemorySpace,
  Protocol,
  ProviderCommand,
  Query,
  QueryError,
  QueryResult,
  refer,
  Subscribe,
  Transaction,
  TransactionError,
  TransactionResult,
  UCAN,
} from "@commontools/memory";

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

export type ConnectionStatus =
  | "ready" // Connection is active
  | "pending"; // Not yet connected but trying to

export type ActivityStatus =
  | "push" // Pushing changes upstream
  | "pull" // Pulling changes from upstream
  | "merge"; // Merging changes from upstream

export type Result<Ok extends object = object, Failure extends Error = Error> =
  | { ok: Ok; error?: void }
  | { ok?: void; error: Failure };

export type Status<Pending extends object, Ready = Pending> =
  | { pending: Pending; ready?: void; time: Time }
  | { pending?: void; ready: Ready; time: Time };

export type Time = number;

export type PushError =
  | ConnectionError
  | ConflictError
  | TransactionError
  | AuthorizationError;

export type PullError =
  | ConnectionError
  | QueryError
  | AuthorizationError;

export type PullStatus = {
  pending: Record<string, UCAN<Query>>;
  failed: Record<string, PushError>;
};

export type PushStatus = {
  pending: Record<string, UCAN<Transaction>>;
  failed: Record<string, PullError>;
};

export type SubscriptionStatus = {
  pending: Record<string, Query>;
  active: Record<string, object>;
};

class MemoryStatus {
  /**
   * Status of the connection to the upstream. If pending it will contain
   * result holding potentially an error which occurred causing a reconnection
   * if pending and result is ok it is an initial connection.
   */
  connection: Status<Result<object, Error>>;

  /**
   * If pending holds inflight transaction. If ready shows status of the last
   * transaction.
   */
  push: Record<string, Result<UCAN<Transaction>, PushError & { time: Time }>>;

  /**
   * If pending shows set of active queries, if ready shows last query result.
   */
  pull: Record<string, Result<UCAN<Query>, PullError & { time: Time }>>;

  /**
   * Status of current subscriptions.
   */
  subscriptions: Record<string, {
    source: UCAN<Subscribe>;
    merging?: Transaction;
  }>;

  constructor(
    connection: typeof this.connection,
    push: typeof this.push,
    pull: typeof this.pull,
    subscriptions: typeof this.subscriptions,
  ) {
    this.connection = connection;
    this.push = push;
    this.pull = pull;
    this.subscriptions = subscriptions;
  }

  static new(time = Date.now()) {
    return new this(
      { pending: { ok: {} }, time },
      {},
      {},
      {},
    );
  }

  static update(state: MemoryStatus, change: MemoryChange) {
    if (change.post) {
      return MemoryStatus.post(state, change.post);
    } else if (change.receipt) {
      return MemoryStatus.receipt(state, change.receipt);
    }
  }

  static post(
    state: MemoryStatus,
    { invocation, authorization }: UCAN<ConsumerCommandInvocation<Protocol>>,
  ) {
    const [id] = Object.keys(authorization.access);
    const url = `job:${id}`;
    switch (invocation.cmd) {
      case "/memory/transact": {
        state.push[url] = { ok: { invocation, authorization } };
        return state;
      }
      case "/memory/query": {
        state.pull[url] = { ok: { invocation, authorization } };
        return state;
      }
      case "/memory/query/subscribe": {
        const { subscriptions } = state;
        subscriptions[url] = { source: { invocation, authorization } };
        return state;
      }
      case "/memory/query/unsubscribe": {
        delete state.subscriptions[invocation.args.source];
        return state;
      }
      default: {
        console.error(`Unknown invocation`, invocation);
      }
    }
  }

  static receipt(
    state: MemoryStatus,
    receipt: ProviderCommand<Protocol>,
  ) {
    switch (receipt.the) {
      case "task/effect":
        return MemoryStatus.effect(state, receipt);
      case "task/return":
        return MemoryStatus.return(state, receipt);
    }
  }

  static effect(
    state: MemoryStatus,
    { is: transaction, of }: { is: Transaction; of: string },
  ) {
  }

  static return(
    state: MemoryStatus,
    { is: result, of }: { is: Result; of: string },
  ) {
    if (state.pull[of]) {
      if (result.error) {
        state.pull[of] = {
          error: Object.assign(result.error as PullError, { time: Date.now() }),
        };
      } else {
        delete state.pull[of];
      }
    } else if (state.push[of]) {
      if (result.error) {
        state.push[of] = {
          error: Object.assign(result.error as PushError, { time: Date.now() }),
        };
      } else {
        delete state.push[of];
      }
    } else if (state.subscriptions[of]) {
      delete state.subscriptions[of];
    }
  }
}

const reset = (): MemoryStatus => ({
  connection: { pending: { ok: {} }, time: Date.now() },
  push: {},
  pull: {},
  subscriptions: {},
});

export function User() {
  const { session, clearAuthentication } = useAuthentication();
  const [did, setDid] = useState<string | undefined>(undefined);
  const [connectionStatus, setConnectionStatus] = useState<
    "connected" | "disconnected" | "offline" | null
  >(null);

  // Animation refs
  const svgRef = useRef<SVGSVGElement>(null);
  const animationRef = useRef<number | null>(null);
  const rotationRef = useRef(0);
  const opacityRef = useRef(0);
  const bounceRef = useRef(0);
  const avatarRef = useRef<HTMLDivElement>(null);
  const activityBufferRef = useRef<
    { type: "send" | "receive"; timestamp: number }[]
  >([]);

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
  useStorageBroadcast((data: StorageEvent) => {
    // Handle connection status events
    if (data.connected) {
      setConnectionStatus("connected");
    } else if (data.disconnected) {
      setConnectionStatus("disconnected");
    } else if (data.timeout) {
      setConnectionStatus("offline");
    } else if (data.receive) {
      activityBufferRef.current.push({
        type: "receive",
        timestamp: Date.now(),
      });
    } else if (data.send) {
      activityBufferRef.current.push({
        type: "send",
        timestamp: Date.now(),
      });
    } else if (data.transact) {
      // Add send activity to buffer
      activityBufferRef.current.push({
        type: "send",
        timestamp: Date.now(),
      });
    }
  });

  // Animation logic with requestAnimationFrame
  useEffect(() => {
    // Animation function
    const animate = () => {
      if (!svgRef.current || !avatarRef.current) {
        animationRef.current = requestAnimationFrame(animate);
        return;
      }

      const circle = svgRef.current.querySelector("circle");
      if (!circle) {
        animationRef.current = requestAnimationFrame(animate);
        return;
      }

      // Clean buffer - remove activities older than 2 seconds
      const now = Date.now();
      activityBufferRef.current = activityBufferRef.current.filter(
        (activity: any) => now - activity.timestamp < 2000,
      );

      // Determine animation state based on buffer
      const hasActivity = activityBufferRef.current.length > 0;

      // Count receive and send activities
      const receiveActivities = activityBufferRef.current.filter(
        (activity: any) =>
          now - activity.timestamp < 1000 && activity.type === "receive",
      ).length;

      const sendActivities = activityBufferRef.current.filter(
        (activity: any) =>
          now - activity.timestamp < 1000 && activity.type === "send",
      ).length;

      // Check for disconnected state - this has priority over all
      if (connectionStatus === "disconnected") {
        // Create pulsing effect using sine wave
        const pulseIntensity = (Math.sin(now / 100) + 1) / 2; // Values between 0 and 1
        opacityRef.current = 0.3 + (pulseIntensity * 0.6); // Pulse between 0.3 and 0.9 opacity

        // Stop rotation for disconnected state
        rotationRef.current = 0;

        // Set red color for disconnected state
        circle.setAttribute("stroke", "#ffffff");

        // Use solid stroke for disconnected state
        circle.setAttribute("strokeDasharray", "none");
        circle.setAttribute("strokeWidth", String(2 + pulseIntensity)); // Pulse stroke width too

        // Add pulsing red glow to avatar
        if (avatarRef.current) {
          avatarRef.current.style.boxShadow = `0 0 ${
            8 * pulseIntensity
          }px #FF0000`;
        }
      } // Check for transact (send) events - they have second priority
      else if (sendActivities > 0) {
        // Make ring visible with faster increase for transact events
        opacityRef.current = Math.min(opacityRef.current + 0.1, 0.9);

        // Spin counter-clockwise for transact events, speed based on frequency
        const speed = Math.min(sendActivities * 3, 12);
        rotationRef.current -= speed; // Counter-clockwise rotation

        // Set bright orange color for transact events instead of purple
        circle.setAttribute("stroke", "#FF5722"); // Bright orange color for transact
        circle.setAttribute("strokeDasharray", "6 6");

        // Make stroke width thicker for better visibility
        circle.setAttribute("strokeWidth", "3");

        // Start or amplify bounce - use smaller values for subtle effect
        bounceRef.current = Math.min(bounceRef.current + 0.4, 1.5);

        // Apply subtle scale bounce to avatar
        const scaleAmount = 1 +
          (Math.sin(now / 100) * 0.02 * bounceRef.current);
        avatarRef.current.style.transform = `scale(${scaleAmount})`;

        // Set bright orange color for avatar glow during transact
        avatarRef.current.style.boxShadow = `0 0 ${
          bounceRef.current * 3
        }px #FF5722`;
      } // Handle receive events (if no transact events)
      else if (receiveActivities > 0) {
        // Make ring visible with faster increase for receive events
        opacityRef.current = Math.min(opacityRef.current + 0.1, 0.9);

        // Spin clockwise for receive events, speed based on frequency
        const speed = Math.min(receiveActivities * 3, 12);
        rotationRef.current += speed; // Clockwise rotation

        // Make sure the ring color is green for receive events
        circle.setAttribute("stroke", "#00BF57"); // Less bright green
        circle.setAttribute("strokeDasharray", "6 6");

        // Reset stroke width
        circle.setAttribute("strokeWidth", "2.5");

        // Reduce bounce for receive events
        bounceRef.current = Math.max(bounceRef.current - 0.2, 0);

        // Reset avatar
        avatarRef.current.style.transform = "scale(1)";
        avatarRef.current.style.boxShadow = "none";
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
      }

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
  }, [connectionStatus]);

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
        <div className="absolute top-8 left-1/2 -translate-x-1/2 bg-gray-800 text-white px-2 py-1 rounded text-sm opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-[1000]">
          {connectionStatus === "disconnected"
            ? "Offline - Reconnecting..."
            : "Click to log out"}
        </div>
      </div>
    </div>
  );
}
