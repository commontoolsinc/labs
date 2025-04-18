import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { Charm, WorkflowForm } from "@commontools/charm";
import { Cell } from "@commontools/runner";

// Type definitions for our activity events
type ActivityId = string;

// Base interfaces for all activities
interface BaseActivityEvent {
  id: ActivityId;
}

// Job-specific events
interface BaseJobEvent extends BaseActivityEvent {
  jobId: ActivityId; // For backward compatibility
}

interface JobStartEvent extends BaseJobEvent {
  type: "job-start";
  status: string;
  title: string;
  debug: boolean;
}

interface JobUpdateEvent extends BaseJobEvent {
  type: "job-update";
  status: string;
  progress?: number; // Optional progress percentage (0-100)
}

interface JobCompleteEvent extends BaseJobEvent {
  type: "job-complete";
  status: string;
  result?: Cell<Charm>;
}

interface JobFailedEvent extends BaseJobEvent {
  type: "job-failed";
  status: string;
  error: string;
}

// Notification-specific event
interface NotificationEvent extends BaseActivityEvent {
  type: "notification";
  title: string;
  message: string;
  level?: "info" | "success" | "warning" | "error";
  action?: {
    label: string;
    onClick: () => void;
  };
}

type ActivityEvent =
  | JobStartEvent
  | JobUpdateEvent
  | JobCompleteEvent
  | JobFailedEvent
  | NotificationEvent;

// Base activity interface
export interface Activity {
  id: ActivityId;
  type: "job" | "notification";
  title: string;
  createdAt: Date;
  updatedAt: Date;
  isArchived?: boolean;
  debug?: boolean;
}

// Job state maintained in the component
export interface Job extends Activity {
  type: "job";
  jobId: ActivityId;
  status: string;
  state: "running" | "completed" | "failed";
  progress?: number;
  error?: string;
  result?: Cell<Charm>;
  startedAt: Date;
  completedAt?: Date;
}

// Notification state
export interface Notification extends Activity {
  type: "notification";
  message: string;
  level: "info" | "success" | "warning" | "error";
  action?: {
    label: string;
    onClick: () => void;
  };
}

export function notify(
  title: string,
  message: string,
  level: "info" | "success" | "warning" | "error",
  action?: { label: string; onClick: () => void },
) {
  const id = crypto.randomUUID();
  const notification: Notification = {
    title,
    id,
    type: "notification",
    message,
    level,
    action,
    createdAt: new Date(),
    updatedAt: new Date(),
    isArchived: false,
  };

  globalThis.dispatchEvent(
    new CustomEvent("notification", { detail: notification }),
  );
}

export function startJob(
  id: string,
  title: string,
  status: string,
  debug = false,
) {
  const jobEvent: JobStartEvent = {
    id,
    jobId: id,
    type: "job-start",
    title,
    status,
    debug,
  };

  globalThis.dispatchEvent(
    new CustomEvent("job-start", { detail: jobEvent }),
  );

  return id;
}

export function updateJob(
  id: string,
  status: string,
  progress?: number,
) {
  const jobEvent: JobUpdateEvent = {
    id,
    jobId: id,
    type: "job-update",
    status,
    progress,
  };

  globalThis.dispatchEvent(
    new CustomEvent("job-update", { detail: jobEvent }),
  );
}

export function completeJob(
  id: string,
  status: string,
  result?: Cell<Charm>,
) {
  const jobEvent: JobCompleteEvent = {
    id,
    jobId: id,
    type: "job-complete",
    status,
    result,
  };

  globalThis.dispatchEvent(
    new CustomEvent("job-complete", { detail: jobEvent }),
  );
}

export function failJob(
  id: string,
  status: string,
  error: string,
  payload?: Record<string, unknown>,
) {
  const jobEvent: JobFailedEvent = {
    id,
    jobId: id,
    type: "job-failed",
    status,
    error,
  };

  globalThis.dispatchEvent(
    new CustomEvent("job-failed", { detail: jobEvent }),
  );
}

interface ActivityContextType {
  activities: Record<ActivityId, Activity>;
  jobs: Record<ActivityId, Job>;
  notifications: Record<ActivityId, Notification>;
  activeItems: Activity[];
  archivedItems: Activity[];
  runningJobs: Job[];
  completedJobs: Job[];
  failedJobs: Job[];
  showArchived: boolean;
  setShowArchived: (show: boolean) => void;
  isVisible: boolean;
  setIsVisible: (visible: boolean) => void;
  archiveActivity: (id: ActivityId) => void;
  archiveAllCompleted: () => void;
  clearAllArchived: () => void;
}

const ActivityContext = createContext<ActivityContextType | undefined>(
  undefined,
);

interface ActivityProviderProps {
  children: React.ReactNode;
}

export const ActivityProvider: React.FC<ActivityProviderProps> = (
  { children },
) => {
  // State to track all activities and UI state
  const [activities, setActivities] = useState<Record<ActivityId, Activity>>(
    {},
  );
  const [showArchived, setShowArchived] = useState(false);
  const [isVisible, setIsVisible] = useState(true);

  // Reference to keep track of the auto-hide timer
  const hideTimerRef = useRef<number | null>(null);

  // Derived states for different activity types
  const jobs = Object.values(activities)
    .filter((activity): activity is Job => activity.type === "job")
    .reduce(
      (acc, job) => ({ ...acc, [job.id]: job }),
      {} as Record<ActivityId, Job>,
    );

  const notifications = Object.values(activities)
    .filter((activity): activity is Notification =>
      activity.type === "notification"
    )
    .reduce(
      (acc, notification) => ({ ...acc, [notification.id]: notification }),
      {} as Record<ActivityId, Notification>,
    );

  // Functions for archiving activities
  const archiveActivity = (id: ActivityId) => {
    setActivities((prev) => {
      if (!prev[id]) return prev;
      return {
        ...prev,
        [id]: { ...prev[id], isArchived: true, updatedAt: new Date() },
      };
    });
  };

  const archiveAllCompleted = () => {
    setActivities((prev) => {
      const updated = { ...prev };
      Object.values(updated).forEach((activity) => {
        if (
          activity.type === "job" && (activity as Job).state === "completed" ||
          (activity as Job).state === "failed"
        ) {
          updated[activity.id] = {
            ...activity,
            isArchived: true,
            updatedAt: new Date(),
          };
        }
      });
      return updated;
    });
  };

  const clearAllArchived = () => {
    setActivities((prev) => {
      const result: Record<ActivityId, Activity> = {};
      Object.values(prev).forEach((activity) => {
        if (!activity.isArchived) {
          result[activity.id] = activity;
        }
      });
      return result;
    });
  };

  useEffect(() => {
    // Handler for activity events
    const handleActivityEvent = (event: CustomEvent<ActivityEvent>) => {
      const { detail } = event;
      const id = detail.id || (detail as any).jobId; // Support both formats
      const type = detail.type;

      // Always make panel visible when an activity event occurs
      setIsVisible(true);

      // Clear any existing hide timer
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }

      setActivities((prevActivities) => {
        // Create a copy of the current activities
        const updatedActivities = { ...prevActivities };
        const now = new Date();

        if (type === "notification") {
          const notification = detail as NotificationEvent;
          const notificationObj: Notification = {
            id,
            type: "notification",
            title: notification.title,
            message: notification.message,
            level: notification.level || "info",
            action: notification.action,
            createdAt: now,
            updatedAt: now,
            isArchived: false,
          };
          updatedActivities[id] = notificationObj;
        } else if (type === "job-start") {
          const jobDetail = detail as JobStartEvent;
          const jobObj: Job = {
            id,
            jobId: id,
            type: "job",
            title: jobDetail.title,
            status: jobDetail.status,
            state: "running",
            startedAt: now,
            createdAt: now,
            updatedAt: now,
            debug: jobDetail.debug,
          };
          updatedActivities[id] = jobObj;
        } else if (prevActivities[id] && prevActivities[id].type === "job") {
          const existingJob = prevActivities[id] as Job;

          switch (type) {
            case "job-update": {
              const jobDetail = detail as JobUpdateEvent;
              const updatedJob: Job = {
                ...existingJob,
                status: jobDetail.status,
                progress: jobDetail.progress,
                updatedAt: now,
              };
              updatedActivities[id] = updatedJob;
              break;
            }
            case "job-complete": {
              const jobDetail = detail as JobCompleteEvent;
              const completedJob: Job = {
                ...existingJob,
                status: jobDetail.status,
                state: "completed",
                result: jobDetail.result,
                completedAt: now,
                updatedAt: now,
              };
              updatedActivities[id] = completedJob;
              break;
            }
            case "job-failed": {
              const jobDetail = detail as JobFailedEvent;
              const failedJob: Job = {
                ...existingJob,
                status: jobDetail.status,
                state: "failed",
                error: jobDetail.error,
                completedAt: now,
                updatedAt: now,
              };
              updatedActivities[id] = failedJob;
              break;
            }
          }
        }

        return updatedActivities;
      });
    };

    // Add event listeners for all activity event types
    globalThis.addEventListener(
      "job-start",
      handleActivityEvent as EventListener,
    );
    globalThis.addEventListener(
      "job-update",
      handleActivityEvent as EventListener,
    );
    globalThis.addEventListener(
      "job-complete",
      handleActivityEvent as EventListener,
    );
    globalThis.addEventListener(
      "job-failed",
      handleActivityEvent as EventListener,
    );
    globalThis.addEventListener(
      "notification",
      handleActivityEvent as EventListener,
    );

    // Clean up listeners on unmount
    return () => {
      globalThis.removeEventListener(
        "job-start",
        handleActivityEvent as EventListener,
      );
      globalThis.removeEventListener(
        "job-update",
        handleActivityEvent as EventListener,
      );
      globalThis.removeEventListener(
        "job-complete",
        handleActivityEvent as EventListener,
      );
      globalThis.removeEventListener(
        "job-failed",
        handleActivityEvent as EventListener,
      );
      globalThis.removeEventListener(
        "notification",
        handleActivityEvent as EventListener,
      );
    };
  }, []);

  // Separate jobs by state for easier rendering
  const runningJobs = Object.values(jobs).filter((job) =>
    job.state === "running"
  );
  const completedJobs = Object.values(jobs).filter((job) =>
    job.state === "completed"
  );
  const failedJobs = Object.values(jobs).filter((job) =>
    job.state === "failed"
  );

  // Split activities into active and archived for rendering
  const activeItems = Object.values(activities)
    .filter((activity) => !activity.isArchived)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  const archivedItems = Object.values(activities)
    .filter((activity) => activity.isArchived)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  // Effect to handle auto-hiding when there are no active items
  useEffect(() => {
    // If there are running jobs, make sure panel is visible and clear any hide timer
    if (runningJobs.length > 0) {
      setIsVisible(true);
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
    } else if (activeItems.length > 0) {
      // If there are no running jobs but there are active items, start the hide timer
      if (hideTimerRef.current === null) {
        hideTimerRef.current = setTimeout(() => {
          setIsVisible(false);
          hideTimerRef.current = null;
        }, 30000); // 30 seconds
      }
    } else {
      // No active items at all, hide immediately
      setIsVisible(false);
    }

    // Cleanup timer on unmount
    return () => {
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
      }
    };
  }, [runningJobs.length, activeItems.length]);

  const value = {
    activities,
    jobs,
    notifications,
    activeItems,
    archivedItems,
    runningJobs,
    completedJobs,
    failedJobs,
    showArchived,
    setShowArchived,
    isVisible,
    setIsVisible,
    archiveActivity,
    archiveAllCompleted,
    clearAllArchived,
  };

  return (
    <ActivityContext.Provider value={value}>
      {children}
    </ActivityContext.Provider>
  );
};

// Custom hook to access the activity context
export const useActivityContext = () => {
  const context = useContext(ActivityContext);
  if (context === undefined) {
    throw new Error(
      "useActivityContext must be used within an ActivityProvider",
    );
  }
  return context;
};

// Helper function to format time differences
export const getElapsedTime = (startDate: Date, endDate?: Date) => {
  const end = endDate || new Date();
  const diffMs = end.getTime() - startDate.getTime();

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
};
