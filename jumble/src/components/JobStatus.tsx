import React, { useEffect, useState } from "react";

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
  // State to track all jobs
  const [jobs, setJobs] = useState<Record<JobId, Job>>({});

  useEffect(() => {
    // Handler for job events
    const handleJobEvent = (event: CustomEvent<JobEvent>) => {
      const { detail } = event;
      const { jobId, title, type, status } = detail;

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

  return (
    <div className={`job-status-container ${className || ""}`}>
      <h2>Job Status</h2>

      {/* Running Jobs */}
      <div className="job-section">
        <h3>Running Jobs ({runningJobs.length})</h3>
        {runningJobs.length === 0
          ? <p className="no-jobs">No running jobs</p>
          : (
            <ul className="job-list">
              {runningJobs.map((job) => (
                <li key={job.jobId} className="job-item running">
                  <div className="job-header">
                    <span className="job-title">{job.title}</span>
                    <span className="job-time">
                      {getElapsedTime(job.startedAt)}
                    </span>
                  </div>
                  <div className="job-status">{job.status}</div>
                  {job.progress !== undefined && (
                    <div className="job-progress">
                      <div className="progress-bar">
                        <div
                          className="progress-fill"
                          style={{ width: `${job.progress}%` }}
                        />
                      </div>
                      <span className="progress-text">
                        {job.progress.toFixed(0)}%
                      </span>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
      </div>

      {/* Completed Jobs */}
      <div className="job-section">
        <h3>Completed Jobs ({completedJobs.length})</h3>
        {completedJobs.length === 0
          ? <p className="no-jobs">No completed jobs</p>
          : (
            <ul className="job-list">
              {completedJobs.map((job) => (
                <li key={job.jobId} className="job-item completed">
                  <div className="job-header">
                    <span className="job-title">{job.title}</span>
                    {job.completedAt && (
                      <span className="job-time">
                        {getElapsedTime(job.startedAt, job.completedAt)}
                      </span>
                    )}
                  </div>
                  <div className="job-status">{job.status}</div>
                  {job.viewAction && (
                    <button
                      onClick={job.viewAction.action}
                      className="view-result-btn"
                    >
                      {job.viewAction.label}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
      </div>

      {/* Failed Jobs */}
      <div className="job-section">
        <h3>Failed Jobs ({failedJobs.length})</h3>
        {failedJobs.length === 0
          ? <p className="no-jobs">No failed jobs</p>
          : (
            <ul className="job-list">
              {failedJobs.map((job) => (
                <li key={job.jobId} className="job-item failed">
                  <div className="job-header">
                    <span className="job-title">{job.title}</span>
                    {job.completedAt && (
                      <span className="job-time">
                        {getElapsedTime(job.startedAt, job.completedAt)}
                      </span>
                    )}
                  </div>
                  <div className="job-status">{job.status}</div>
                  <div className="job-error">{job.error}</div>
                </li>
              ))}
            </ul>
          )}
      </div>

      {/* Debug section - can be removed in production */}
      <div className="debug-section">
        <details>
          <summary>Debug: Job Data</summary>
          <pre>{JSON.stringify(jobs, null, 2)}</pre>
        </details>
      </div>
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
