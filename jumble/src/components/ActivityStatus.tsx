import React, { useEffect, useState } from "react";
import {
  Activity,
  getElapsedTime,
  Job,
  Notification,
  useActivityContext,
} from "@/contexts/ActivityContext.tsx";
import { useNavigate } from "react-router-dom";
import { createPath } from "@/routes.ts";
import { charmId } from "@/utils/charms.ts";
import { useCharmManager } from "@/contexts/CharmManagerContext.tsx";
import { DitheredCube } from "@/components/DitherCube.tsx";

// Isolated component for elapsed time that handles its own refresh
const ElapsedTime = ({ startTime }: { startTime: Date }) => {
  const [, setRefresh] = useState(0);

  useEffect(() => {
    const intervalId = setInterval(() => {
      setRefresh((prev) => prev + 1);
    }, 1000);

    return () => clearInterval(intervalId);
  }, []);

  return (
    <span className="text-[11px] text-gray-500 whitespace-nowrap">
      {getElapsedTime(startTime)}
    </span>
  );
};

interface ActivityStatusProps {
  // Optional className for styling the container
  className?: string;
}

const ActivityStatus: React.FC<ActivityStatusProps> = ({ className }) => {
  // Use the activity context
  const {
    activeItems,
    archivedItems,
    runningJobs,
    showArchived,
    setShowArchived,
    isVisible,
    setIsVisible,
    archiveActivity,
    archiveAllCompleted,
    clearAllArchived,
  } = useActivityContext();

  const navigate = useNavigate();
  const { charmManager } = useCharmManager();

  // Function to get appropriate icon for activity
  const getActivityIcon = (activity: Activity) => {
    if (activity.type === "job") {
      const job = activity as Job;
      if (job.state === "running") {
        return (
          <div className="w-10 h-10 flex-shrink-0">
            <DitheredCube
              key={job.jobId}
              animationSpeed={2}
              width={40}
              height={40}
              animate
              cameraZoom={12}
            />
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
    } else if (activity.type === "notification") {
      const notification = activity as Notification;
      let iconColor = "text-blue-500";
      if (notification.level === "success") {
        iconColor = "text-green-500";
      } else if (notification.level === "warning") {
        iconColor = "text-yellow-500";
      } else if (notification.level === "error") {
        iconColor = "text-red-500";
      }

      // Different icons based on notification level
      if (notification.level === "info" || notification.level === "success") {
        return (
          <div
            className={`mr-2.5 w-4 h-4 flex items-center justify-center ${iconColor}`}
          >
            <svg viewBox="0 0 24 24" width="16" height="16">
              <path
                fill="currentColor"
                d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"
              />
            </svg>
          </div>
        );
      } else {
        return (
          <div
            className={`mr-2.5 w-4 h-4 flex items-center justify-center ${iconColor}`}
          >
            <svg viewBox="0 0 24 24" width="16" height="16">
              <path
                fill="currentColor"
                d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"
              />
            </svg>
          </div>
        );
      }
    }
    return null;
  };

  // ActivityRow component for displaying activity information
  const ActivityRow = ({ activity }: { activity: Activity }) => {
    // Get background color based on activity type
    let bgColor = "bg-grey-50";
    if (activity.type === "job") {
      const job = activity as Job;
      bgColor = job.state === "running"
        ? "bg-grey-50"
        : job.state === "completed"
        ? "bg-green-50"
        : "bg-red-50";
    } else if (activity.type === "notification") {
      const notification = activity as Notification;
      if (notification.level === "info") {
        bgColor = "bg-blue-50";
      } else if (notification.level === "success") {
        bgColor = "bg-green-50";
      } else if (notification.level === "warning") {
        bgColor = "bg-yellow-50";
      } else if (notification.level === "error") {
        bgColor = "bg-red-50";
      }
    }

    return (
      <div
        className={`flex items-center px-3 py-2 h-9 border-b border-gray-200 ${bgColor} relative`}
      >
        {/* Close button for individual activities */}
        <button
          type="button"
          onClick={() => archiveActivity(activity.id)}
          className="absolute top-0.5 right-0.5 text-gray-400 hover:text-gray-600 transition-colors"
          aria-label="Dismiss"
        >
          <svg viewBox="0 0 24 24" width="12" height="12">
            <path
              fill="currentColor"
              d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41z"
            />
          </svg>
        </button>

        {getActivityIcon(activity)}
        <div className="flex-1 min-w-0 mr-2.5">
          <div className="font-medium whitespace-nowrap overflow-hidden text-ellipsis mb-0.5 text-gray-800">
            {activity.title}
          </div>
          <div className="text-[11px] text-gray-600 whitespace-nowrap overflow-hidden text-ellipsis">
            {activity.type === "job"
              ? (activity as Job).status
              : (activity as Notification).message}
          </div>
        </div>

        {/* Show elapsed time for running jobs */}
        {activity.type === "job" && (activity as Job).state === "running" && (
          <ElapsedTime startTime={(activity as Job).startedAt} />
        )}

        {/* Action buttons for different activity types */}
        {activity.type === "job" &&
          (activity as Job).state === "completed" &&
          (activity as Job).result?.generation?.charm && (
          <button
            type="button"
            onClick={() => {
              navigate(createPath("charmShow", {
                charmId: charmId((activity as Job).result!.generation!.charm)!,
                replicaName: charmManager.getSpace(),
              }));
            }}
            className="bg-black text-white border-none px-2 py-0.5 text-[10px] cursor-pointer whitespace-nowrap"
          >
            View Charm
          </button>
        )}

        {/* Show action button for notifications if provided */}
        {activity.type === "notification" &&
          (activity as Notification).action && (
          <button
            type="button"
            onClick={() => (activity as Notification).action?.onClick()}
            className="bg-black text-white border-none px-2 py-0.5 text-[10px] cursor-pointer whitespace-nowrap"
          >
            {(activity as Notification).action?.label}
          </button>
        )}
      </div>
    );
  };

  // Count of all archived items
  const archivedItemCount = archivedItems.length;

  // Don't render if no activities or if panel should be hidden
  if (activeItems.length === 0 && archivedItems.length === 0 || !isVisible) {
    return null;
  }

  return (
    <div
      className={`fixed bottom-16 right-2 w-80 bg-white text-xs text-gray-700 max-h-[calc(100vh-100px)] overflow-hidden flex flex-col z-50 border-2 border-black shadow-[2px_2px_0px_0px_rgba(0,0,0,0.5)] hover:translate-y-[-2px] hover:shadow-[2px_4px_0px_0px_rgba(0,0,0,0.7)] transition-[border,box-shadow,transform,opacity] duration-100 ease-in-out ${
        className || ""
      }`}
    >
      {/* Header with title and close button */}
      <div className="px-3 py-2 border-b border-gray-300 bg-gray-50 flex justify-between items-center">
        <h4 className="m-0 text-sm font-medium text-gray-800">
          Activity
        </h4>
        <div className="flex">
          {activeItems.length > 0 && activeItems.some((a: Activity) =>
            a.type === "job" &&
            ((a as Job).state === "completed" || (a as Job).state === "failed")
          ) && (
            <button
              type="button"
              onClick={() => archiveAllCompleted()}
              className="mr-2 text-gray-500 hover:text-gray-800 transition-colors cursor-pointer bg-transparent border-none p-0 flex items-center"
              aria-label="Archive completed"
              title="Archive all completed"
            >
              <svg viewBox="0 0 24 24" width="16" height="16">
                <path
                  fill="currentColor"
                  d="M20.54 5.23l-1.39-1.68C18.88 3.21 18.47 3 18 3H6c-.47 0-.88.21-1.16.55L3.46 5.23C3.17 5.57 3 6.02 3 6.5V19c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6.5c0-.48-.17-.93-.46-1.27zM6.24 5h11.52l.83 1H5.42l.82-1zM5 19V8h14v11H5zm8.45-9h-2.9v3H8l4 4 4-4h-2.55z"
                />
              </svg>
            </button>
          )}
          <button
            type="button"
            onClick={() => setIsVisible(false)}
            className="text-gray-500 hover:text-gray-800 transition-colors cursor-pointer bg-transparent border-none p-0 flex items-center"
            aria-label="Close panel"
          >
            <svg viewBox="0 0 24 24" width="18" height="18">
              <path
                fill="currentColor"
                d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41z"
              />
            </svg>
          </button>
        </div>
      </div>

      {/* Active Items Section - Always Visible */}
      <div className="flex-none">
        <div className="max-h-48 overflow-y-auto">
          {activeItems.map((activity: Activity) => (
            <ActivityRow key={activity.id} activity={activity} />
          ))}

          {activeItems.length === 0 && archivedItemCount > 0 && (
            <div className="py-3 text-center text-gray-500 italic">
              No active items
            </div>
          )}
        </div>
      </div>

      {/* Archived Items Section */}
      {archivedItemCount > 0 && (
        <div>
          <button
            type="button"
            className="flex items-center justify-between w-full bg-gray-50 border-none border-t border-gray-300 text-gray-600 py-1.5 px-3 text-xs text-left cursor-pointer hover:bg-gray-100"
            onClick={() => setShowArchived(!showArchived)}
          >
            {showArchived ? "Hide" : "Show"} Archived ({archivedItemCount})
            <span className="text-[8px] ml-1">
              {showArchived ? "▲" : "▼"}
            </span>
          </button>

          {showArchived && archivedItemCount > 0 && (
            <div className="relative">
              <div className="max-h-44 overflow-y-auto border-t border-gray-300">
                {archivedItems.map((activity: Activity) => (
                  <ActivityRow key={activity.id} activity={activity} />
                ))}
              </div>
              <button
                type="button"
                onClick={() => clearAllArchived()}
                className="absolute top-0 right-0 bg-gray-100 text-gray-600 hover:text-gray-800 border border-gray-300 rounded-bl-md text-[10px] px-2 py-1"
                title="Clear all archived"
              >
                Clear All
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default ActivityStatus;
