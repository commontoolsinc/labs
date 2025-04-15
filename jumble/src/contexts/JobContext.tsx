import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { WorkflowForm } from "@commontools/charm";

// Type definitions for our job events
type JobId = string;

interface BaseJobEvent {
  jobId: JobId;
}

interface JobStartEvent extends BaseJobEvent {
  type: "job-start";
  status: string;
  title: string;
  payload?: Record<string, unknown>;
}

interface JobUpdateEvent extends BaseJobEvent {
  type: "job-update";
  status: string;
  progress?: number; // Optional progress percentage (0-100)
  payload?: Record<string, unknown>;
}

interface JobCompleteEvent extends BaseJobEvent {
  type: "job-complete";
  status: string;
  result?: unknown;
  viewAction?: {
    label: string;
    action: () => void;
  };
  payload?: Record<string, unknown>;
}

interface JobFailedEvent extends BaseJobEvent {
  type: "job-failed";
  status: string;
  error: string;
  payload?: Record<string, unknown>;
}

type JobEvent =
  | JobStartEvent
  | JobUpdateEvent
  | JobCompleteEvent
  | JobFailedEvent;

// Job state maintained in the component
export interface Job {
  jobId: JobId;
  title: string;
  status: string;
  state: "running" | "completed" | "failed";
  progress?: number;
  error?: string;
  result?: WorkflowForm;
  updatedAt: Date;
  startedAt: Date;
  completedAt?: Date;
}

interface JobContextType {
  jobs: Record<JobId, Job>;
  runningJobs: Job[];
  completedJobs: Job[];
  failedJobs: Job[];
  showCompleted: boolean;
  setShowCompleted: (show: boolean) => void;
  isVisible: boolean;
  setIsVisible: (visible: boolean) => void;
}

const JobContext = createContext<JobContextType | undefined>(undefined);

interface JobProviderProps {
  children: React.ReactNode;
}

export const JobProvider: React.FC<JobProviderProps> = ({ children }) => {
  // State to track all jobs and UI state
  const [jobs, setJobs] = useState<Record<JobId, Job>>({});
  const [showCompleted, setShowCompleted] = useState(false);
  const [isVisible, setIsVisible] = useState(true);

  // Reference to keep track of the auto-hide timer
  const hideTimerRef = useRef<number | null>(null);

  useEffect(() => {
    // Handler for job events
    const handleJobEvent = (event: CustomEvent<JobEvent>) => {
      const { detail } = event;
      const { jobId, type, status } = detail;

      // Always make panel visible when a job event occurs
      setIsVisible(true);

      // Clear any existing hide timer
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }

      setJobs((prevJobs) => {
        // Create a copy of the current jobs
        const updatedJobs = { ...prevJobs };

        switch (type) {
          case "job-start": {
            updatedJobs[jobId] = {
              jobId,
              title: detail.title,
              status,
              state: "running",
              startedAt: new Date(),
              updatedAt: new Date(),
            };
            break;
          }
          case "job-update": {
            if (updatedJobs[jobId]) {
              updatedJobs[jobId] = {
                ...updatedJobs[jobId],
                status,
                progress: detail.progress,
                updatedAt: new Date(),
              };
            }
            break;
          }
          case "job-complete": {
            if (updatedJobs[jobId]) {
              updatedJobs[jobId] = {
                ...updatedJobs[jobId],
                status,
                state: "completed",
                result: detail.result,
                viewAction: detail.viewAction,
                completedAt: new Date(),
                updatedAt: new Date(),
              };
            }
            break;
          }
          case "job-failed": {
            if (updatedJobs[jobId]) {
              updatedJobs[jobId] = {
                ...updatedJobs[jobId],
                status,
                state: "failed",
                error: detail.error,
                completedAt: new Date(),
                updatedAt: new Date(),
              };
            }
            break;
          }
        }

        return updatedJobs;
      });
    };

    // Add event listeners for all job event types
    globalThis.addEventListener("job-start", handleJobEvent as EventListener);
    globalThis.addEventListener("job-update", handleJobEvent as EventListener);
    globalThis.addEventListener(
      "job-complete",
      handleJobEvent as EventListener,
    );
    globalThis.addEventListener("job-failed", handleJobEvent as EventListener);

    // Clean up listeners on unmount
    return () => {
      globalThis.removeEventListener(
        "job-start",
        handleJobEvent as EventListener,
      );
      globalThis.removeEventListener(
        "job-update",
        handleJobEvent as EventListener,
      );
      globalThis.removeEventListener(
        "job-complete",
        handleJobEvent as EventListener,
      );
      globalThis.removeEventListener(
        "job-failed",
        handleJobEvent as EventListener,
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

  // Effect to handle auto-hiding when there are no active jobs
  useEffect(() => {
    // If there are running jobs, make sure panel is visible and clear any hide timer
    if (runningJobs.length > 0) {
      setIsVisible(true);
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
    } else if (Object.keys(jobs).length > 0) {
      // If there are no running jobs but there are completed/failed jobs, start the hide timer
      if (hideTimerRef.current === null) {
        hideTimerRef.current = setTimeout(() => {
          setIsVisible(false);
          hideTimerRef.current = null;
        }, 30000); // 30 seconds
      }
    } else {
      // No jobs at all, hide immediately
      setIsVisible(false);
    }

    // Cleanup timer on unmount
    return () => {
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
      }
    };
  }, [runningJobs.length, jobs]);

  const value = {
    jobs,
    runningJobs,
    completedJobs,
    failedJobs,
    showCompleted,
    setShowCompleted,
    isVisible,
    setIsVisible,
  };

  return <JobContext.Provider value={value}>{children}</JobContext.Provider>;
};

// Custom hook to access the job context
export const useJobContext = () => {
  const context = useContext(JobContext);
  if (context === undefined) {
    throw new Error("useJobContext must be used within a JobProvider");
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
