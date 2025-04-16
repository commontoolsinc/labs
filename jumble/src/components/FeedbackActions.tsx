import { useEffect, useState } from "react";
import { FeedbackDialog } from "@/components/FeedbackDialog.tsx";
import { submitFeedback } from "@/services/feedback.ts";
import { getLastTraceSpanID } from "@commontools/builder";
import { MdThumbDownOffAlt, MdThumbUpOffAlt } from "react-icons/md";
import { notify } from "@/contexts/ActivityContext.tsx";
import { useLocation } from "react-router-dom";

export function FeedbackActions() {
  // States for the feedback dialog
  const [isFeedbackDialogOpen, setIsFeedbackDialogOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [initialScore, setInitialScore] = useState<number>(1);
  const [showFeedbackButtons, setShowFeedbackButtons] = useState(false);

  // Close dialog & hide buttons when the user navigates to a different route
  const location = useLocation();
  useEffect(() => {
    setIsFeedbackDialogOpen(false);
    setShowFeedbackButtons(false);
  }, [location.pathname]);

  // Listen for toggle-feedback event
  useEffect(() => {
    const handleToggleFeedback = () => {
      setShowFeedbackButtons((prev) => !prev);
    };

    globalThis.addEventListener("toggle-feedback", handleToggleFeedback);
    return () => {
      globalThis.removeEventListener("toggle-feedback", handleToggleFeedback);
    };
  }, []);

  // Handler functions for feedback actions
  const handleOpenFeedback = (score: number) => {
    console.log(
      `Opening ${score === 1 ? "positive" : "negative"} feedback dialog`,
    );
    setInitialScore(score);
    setIsFeedbackDialogOpen(true);
    setShowFeedbackButtons(false);
  };

  const handleCloseFeedback = () => {
    setIsFeedbackDialogOpen(false);
  };

  const handleSubmitFeedback = async (
    data: { score: number; explanation: string; userInfo?: any },
  ) => {
    console.log("Submitting feedback:", data);
    setIsSubmitting(true);

    try {
      await submitFeedback(
        {
          score: data.score,
          explanation: data.explanation,
          spanId: getLastTraceSpanID() as string,
        },
        data.userInfo,
      );

      setIsFeedbackDialogOpen(false);
      notify("Feedback Submitted", "Thank you for your input!", "success");
    } catch (error) {
      notify(
        "Error submitting feedback",
        error instanceof Error
          ? (typeof error.message === "object"
            ? JSON.stringify(error.message)
            : error.message)
          : JSON.stringify(error),
        "error",
      );
      console.error(error);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Render feedback dialog and the popup buttons
  return (
    <>
      {/* Feedback dialog for submissions */}
      <FeedbackDialog
        isOpen={isFeedbackDialogOpen}
        onClose={handleCloseFeedback}
        onSubmit={handleSubmitFeedback}
        initialScore={initialScore}
        isSubmitting={isSubmitting}
      />

      {/* Popup buttons that appear when feedback button is clicked */}
      {showFeedbackButtons && (
        <div className="fixed z-[100] bottom-2 right-2 flex flex-col-reverse gap-2 pointer-events-none">
          {/* This spacer places the thumbs buttons just above the feedback button */}
          <div className="h-12"></div>

          {/* Thumbs down button */}
          <div className="pointer-events-auto">
            <button
              type="button"
              className="w-12 h-12 cursor-pointer flex items-center justify-center border-2 border-black shadow-[2px_2px_0px_0px_rgba(0,0,0,0.5)] bg-red-50 hover:translate-y-[-2px] relative group"
              onClick={() => handleOpenFeedback(0)}
            >
              <MdThumbDownOffAlt className="w-6 h-6" />
              <div className="absolute left-[-100px] top-1/2 -translate-y-1/2 bg-gray-800 text-white px-2 py-1 rounded text-sm opacity-0 group-hover:opacity-100 transition-opacity z-[200] whitespace-nowrap">
                Not Helpful
              </div>
            </button>
          </div>

          {/* Thumbs up button */}
          <div className="pointer-events-auto">
            <button
              type="button"
              className="w-12 h-12 cursor-pointer flex items-center justify-center border-2 border-black shadow-[2px_2px_0px_0px_rgba(0,0,0,0.5)] bg-green-50 hover:translate-y-[-2px] relative group"
              onClick={() => handleOpenFeedback(1)}
            >
              <MdThumbUpOffAlt className="w-6 h-6" />
              <div className="absolute left-[-100px] top-1/2 -translate-y-1/2 bg-gray-800 text-white px-2 py-1 rounded text-sm opacity-0 group-hover:opacity-100 transition-opacity z-[200] whitespace-nowrap">
                Helpful
              </div>
            </button>
          </div>
        </div>
      )}
    </>
  );
}
