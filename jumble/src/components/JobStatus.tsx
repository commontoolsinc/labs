import React from "react";
import { getElapsedTime, Job, useJobContext } from "@/contexts/JobContext.tsx";

interface JobStatusProps {
  // Optional className for styling the container
  className?: string;
}

const JobStatus: React.FC<JobStatusProps> = ({ className }) => {
  // Use the job context
  const {
    jobs,
    runningJobs,
    completedJobs,
    failedJobs,
    showCompleted,
    setShowCompleted,
    isVisible,
  } = useJobContext();

  // Function to get appropriate icon for job state
  const getJobIcon = (job: Job) => {
    if (job.state === "running") {
      return (
        <div className="mr-2.5 w-4 h-4 flex items-center justify-center relative">
          <div className="w-4 h-4 border-2 border-gray-200 border-t-blue-500 rounded-full animate-[spin_1s_linear_infinite]">
          </div>
        </div>
      );
    } else if (job.state === "completed") {
      return (
        <div className="mr-2.5 w-4 h-4 flex items-center justify-center text-green-500">
          <svg viewBox="0 0 24 24" width="16" height="16">
            <path
              fill="currentColor"
              d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"
            />
          </svg>
        </div>
      );
    } else if (job.state === "failed") {
      return (
        <div className="mr-2.5 w-4 h-4 flex items-center justify-center text-red-500">
          <svg viewBox="0 0 24 24" width="16" height="16">
            <path
              fill="currentColor"
              d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41z"
            />
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
        <span className="text-[10px] text-gray-500 whitespace-nowrap">
          {progress.toFixed(0)}%
        </span>
      </div>
    );
  };

  // Job row component for consistent rendering
  const JobRow = ({ job }: { job: Job }) => (
    <div
      className={`flex items-center px-3 py-2 h-9 border-b border-gray-200 ${
        job.state === "running"
          ? "bg-blue-50"
          : job.state === "completed"
          ? "bg-green-50"
          : "bg-red-50"
      }`}
    >
      {getJobIcon(job)}
      <div className="flex-1 min-w-0 mr-2.5">
        <div className="font-medium whitespace-nowrap overflow-hidden text-ellipsis mb-0.5 text-gray-800">
          {job.title}
        </div>
        <div className="text-[11px] text-gray-600 whitespace-nowrap overflow-hidden text-ellipsis">
          {job.status}
        </div>
      </div>
      {job.state === "running" && <ProgressIndicator progress={job.progress} />}
      {job.state === "running" && (
        <span className="text-[11px] text-gray-500 whitespace-nowrap">
          {getElapsedTime(job.startedAt)}
        </span>
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
    <div
      className={`fixed bottom-16 right-2 w-80 bg-white text-xs text-gray-700 max-h-[calc(100vh-100px)] overflow-hidden flex flex-col z-50 border-2 border-black shadow-[2px_2px_0px_0px_rgba(0,0,0,0.5)] hover:translate-y-[-2px] hover:shadow-[2px_4px_0px_0px_rgba(0,0,0,0.7)] transition-[border,box-shadow,transform,opacity] duration-100 ease-in-out ${
        className || ""
      }`}
    >
      {/* Active Jobs Section - Always Visible */}
      <div className="flex-none">
        {runningJobs.length > 0 && (
          <div className="px-3 py-2 border-b border-gray-300 bg-gray-50">
            <h4 className="m-0 text-sm font-medium text-gray-800">
              Active Jobs
            </h4>
          </div>
        )}

        <div className="max-h-48 overflow-y-auto">
          {runningJobs.map((job) => <JobRow key={job.jobId} job={job} />)}

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
          {completedJobs.filter((job) => job.viewAction).length > 0 && (
            <div>
              {completedJobs
                .filter((job) => job.viewAction)
                .map((job) => <JobRow key={job.jobId} job={job} />)}
            </div>
          )}

          {/* Then show other completed jobs */}
          {completedJobs.filter((job) => !job.viewAction).length > 0 && (
            <div>
              {completedJobs
                .filter((job) => !job.viewAction)
                .map((job) => <JobRow key={job.jobId} job={job} />)}
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
      <style>
        {`
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}
      </style>
    </div>
  );
};

export default JobStatus;
