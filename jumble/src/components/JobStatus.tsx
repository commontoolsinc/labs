import React, { useEffect, useState, useRef } from "react";

// Type definitions for our job events
type JobId = string;

interface BaseJobEvent {
  jobId: JobId;
  title: string;
}

interface JobStartEvent extends BaseJobEvent {
  type: "job-start";
  status: string;
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
interface Job {
  jobId: JobId;
  title: string;
  status: string;
  state: "running" | "completed" | "failed";
  progress?: number;
  error?: string;
  result?: unknown;
  viewAction?: {
    label: string;
    action: () => void;
  };
  updatedAt: Date;
  startedAt: Date;
  completedAt?: Date;
}

interface JobStatusProps {
  // Optional className for styling the container
  className?: string;
}

const JobStatus: React.FC<JobStatusProps> = ({ className }) => {
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
      const { jobId, title, type, status } = detail;

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
              title,
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

  // Helper function to format time differences
  const getElapsedTime = (startDate: Date, endDate?: Date) => {
    const end = endDate || new Date();
    const diffMs = end.getTime() - startDate.getTime();

    const seconds = Math.floor(diffMs / 1000);
    if (seconds < 60) return `${seconds}s`;

    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
  };

  // Function to get appropriate icon for job state
  const getJobIcon = (job: Job) => {
    if (job.state === "running") {
      return (
        <div className="mr-2.5 w-4 h-4 flex items-center justify-center relative">
          <div className="w-4 h-4 border-2 border-gray-200 border-t-blue-500 rounded-full animate-[spin_1s_linear_infinite]"></div>
        </div>
      );
    } else if (job.state === "completed") {
      return (
        <div className="mr-2.5 w-4 h-4 flex items-center justify-center text-green-500">
          <svg viewBox="0 0 24 24" width="16" height="16">
            <path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z" />
          </svg>
        </div>
      );
    } else if (job.state === "failed") {
      return (
        <div className="mr-2.5 w-4 h-4 flex items-center justify-center text-red-500">
          <svg viewBox="0 0 24 24" width="16" height="16">
            <path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41z" />
          </svg>
        </div>
      );
    }
    return null;
  };

  // Progress indicator component
  const ProgressIndicator = ({ progress }: { progress?: number }) => {
    if (progress === undefined) return null;
    
    return (
      <div className="flex items-center mr-2 w-[60px]">
        <div className="flex-1 h-1 bg-gray-200 rounded overflow-hidden mr-1">
          <div 
            className="h-full bg-blue-500 transition-[width] duration-300 ease-in-out" 
            style={{ width: `${progress}%` }}
          />
        </div>
        <span className="text-[10px] text-gray-500 whitespace-nowrap">{progress.toFixed(0)}%</span>
      </div>
    );
  };

  // Job row component for consistent rendering
  const JobRow = ({ job }: { job: Job }) => (
    <div className={`flex items-center px-3 py-2 h-9 border-b border-gray-200 ${job.state === "running" ? "bg-blue-50" : job.state === "completed" ? "bg-green-50" : "bg-red-50"}`}>
      {getJobIcon(job)}
      <div className="flex-1 min-w-0 mr-2.5">
        <div className="font-medium whitespace-nowrap overflow-hidden text-ellipsis mb-0.5 text-gray-800">{job.title}</div>
        <div className="text-[11px] text-gray-600 whitespace-nowrap overflow-hidden text-ellipsis">{job.status}</div>
      </div>
      {job.state === "running" && <ProgressIndicator progress={job.progress} />}
      {job.state === "running" && (
        <span className="text-[11px] text-gray-500 whitespace-nowrap">{getElapsedTime(job.startedAt)}</span>
      )}
      {job.state === "completed" && job.viewAction && (
        <button 
          type="button"
          onClick={job.viewAction.action}
          className="bg-blue-500 text-white border-none rounded px-2 py-0.5 text-[10px] cursor-pointer whitespace-nowrap hover:bg-blue-600"
        >
          {job.viewAction.label}
        </button>
      )}
    </div>
  );

  // Count of all non-running jobs
  const finishedJobCount = completedJobs.length + failedJobs.length;

  // Don't render if no jobs or if panel should be hidden
  if (Object.keys(jobs).length === 0 || !isVisible) {
    return null;
  }

  return (
    <div className={`fixed bottom-16 right-2 w-80 bg-white text-xs text-gray-700 max-h-[calc(100vh-100px)] overflow-hidden flex flex-col z-50 border-2 border-black shadow-[2px_2px_0px_0px_rgba(0,0,0,0.5)] hover:translate-y-[-2px] hover:shadow-[2px_4px_0px_0px_rgba(0,0,0,0.7)] transition-[border,box-shadow,transform,opacity] duration-100 ease-in-out ${className || ""}`}>
      {/* Active Jobs Section - Always Visible */}
      <div className="flex-none">
        {runningJobs.length > 0 && (
          <div className="px-3 py-2 border-b border-gray-300 bg-gray-50">
            <h4 className="m-0 text-sm font-medium text-gray-800">Active Jobs</h4>
          </div>
        )}
        
        <div className="max-h-48 overflow-y-auto">
          {runningJobs.map((job) => (
            <JobRow key={job.jobId} job={job} />
          ))}

          {runningJobs.length === 0 && finishedJobCount > 0 && (
            <div className="py-3 text-center text-gray-500 italic">
              No active jobs
            </div>
          )}
        </div>
      </div>
      
      {/* Toggle for completed/failed jobs */}
      {finishedJobCount > 0 && (
        <button 
          type="button"
          className="flex items-center justify-between w-full bg-gray-50 border-none border-t border-gray-300 text-gray-600 py-1.5 px-3 text-xs text-left cursor-pointer hover:bg-gray-100" 
          onClick={() => setShowCompleted(!showCompleted)}
        >
          {showCompleted ? "Hide" : "Show"} Completed Jobs ({finishedJobCount})
          <span className="text-[8px] ml-1">
            {showCompleted ? "▲" : "▼"}
          </span>
        </button>
      )}

      {/* Completed/Failed Jobs Section - Collapsible */}
      {showCompleted && finishedJobCount > 0 && (
        <div className="max-h-44 overflow-y-auto border-t border-gray-300">
          {/* First show completed jobs with view actions */}
          {completedJobs.filter(job => job.viewAction).length > 0 && (
            <div>
              {completedJobs
                .filter(job => job.viewAction)
                .map((job) => <JobRow key={job.jobId} job={job} />)
              }
            </div>
          )}
          
          {/* Then show other completed jobs */}
          {completedJobs.filter(job => !job.viewAction).length > 0 && (
            <div>
              {completedJobs
                .filter(job => !job.viewAction)
                .map((job) => <JobRow key={job.jobId} job={job} />)
              }
            </div>
          )}
          
          {/* Show failed jobs */}
          {failedJobs.length > 0 && (
            <div>
              {failedJobs.map((job) => <JobRow key={job.jobId} job={job} />)}
            </div>
          )}
        </div>
      )}
      
      {/* Keyframes for spinner animation */}
      <style>{`
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
};

export default JobStatus;

// Example usage in another component:
/*
// To start a job:
window.dispatchEvent(new CustomEvent('job-start', {
  detail: {
    type: 'job-start',
    jobId: 'unique-job-id',
    title: 'Data Processing',
    status: 'Initializing...',
  }
}));

// To update a job:
window.dispatchEvent(new CustomEvent('job-update', {
  detail: {
    type: 'job-update',
    jobId: 'unique-job-id',
    title: 'Data Processing',
    status: 'Processing item 45/100',
    progress: 45,
  }
}));

// To complete a job:
window.dispatchEvent(new CustomEvent('job-complete', {
  detail: {
    type: 'job-complete',
    jobId: 'unique-job-id',
    title: 'Data Processing',
    status: 'Completed successfully',
    result: { processedItems: 100 },
    viewAction: {
      label: 'View Results',
      action: () => { /* Navigate to results or show modal */
/*}
    }
  }
}));

// To mark a job as failed:
window.dispatchEvent(new CustomEvent('job-failed', {
  detail: {
    type: 'job-failed',
    jobId: 'unique-job-id',
    title: 'Data Processing',
    status: 'Processing failed',
    error: 'Network error occurred while fetching data',
  }
}));
*/
