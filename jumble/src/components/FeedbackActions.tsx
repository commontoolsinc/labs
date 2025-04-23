import { ReactElement, useEffect, useState } from "react";
import { FeedbackDialog } from "@/components/FeedbackDialog.tsx";
import { Slot } from "@/components/Slot.tsx";
import { submitFeedback } from "@/services/feedback.ts";
import { MdThumbDownOffAlt, MdThumbUpOffAlt } from "react-icons/md";
import { notify } from "@/contexts/ActivityContext.tsx";
import { useLocation } from "react-router-dom";

export function PrimaryFeedbackActions(
  { llmRequestId }: { llmRequestId: string },
) {
  const [showFeedbackButtons, setShowFeedbackButtons] = useState(false);
  // Hide buttons when the user navigates to a different route
  const location = useLocation();
  useEffect(() => {
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

  const onFeedbackActionsClose = () => {
    setShowFeedbackButtons(false);
  };

  return (
    <>
      {/* Popup buttons that appear when feedback button is clicked */}
      {showFeedbackButtons && (
        <div className="fixed z-[100] bottom-2 right-2 flex flex-col-reverse gap-2 pointer-events-none">
          {/* This spacer places the thumbs buttons just above the feedback button */}
          <div className="h-12"></div>

          <FeedbackActions
            className="pointer-events-auto"
            llmRequestId={llmRequestId}
            onClose={() => onFeedbackActionsClose()}
          >
            {/* Thumbs down button */}
            <div slot="negative" className="pointer-events-auto">
              <button
                type="button"
                className="w-12 h-12 cursor-pointer flex items-center justify-center border-2 border-black shadow-[2px_2px_0px_0px_rgba(0,0,0,0.5)] bg-red-50 hover:translate-y-[-2px] relative group"
              >
                <MdThumbDownOffAlt className="w-6 h-6" />
                <div className="absolute left-[-100px] top-1/2 -translate-y-1/2 bg-gray-800 text-white px-2 py-1 rounded text-sm opacity-0 group-hover:opacity-100 transition-opacity z-[200] whitespace-nowrap">
                  Not Helpful
                </div>
              </button>
            </div>

            {/* Thumbs up button */}
            <div slot="positive" className="pointer-events-auto">
              <button
                type="button"
                className="w-12 h-12 cursor-pointer flex items-center justify-center border-2 border-black shadow-[2px_2px_0px_0px_rgba(0,0,0,0.5)] bg-green-50 hover:translate-y-[-2px] relative group"
              >
                <MdThumbUpOffAlt className="w-6 h-6" />
                <div className="absolute left-[-100px] top-1/2 -translate-y-1/2 bg-gray-800 text-white px-2 py-1 rounded text-sm opacity-0 group-hover:opacity-100 transition-opacity z-[200] whitespace-nowrap">
                  Helpful
                </div>
              </button>
            </div>
          </FeedbackActions>
        </div>
      )}
    </>
  );
}

export function FeedbackActions(
  { llmRequestId, className, children, onClose, onOpen }: {
    llmRequestId: string;
    onClose?: () => void;
    onOpen?: () => void;
    className?: string;
    children: ReactElement[];
  },
) {
  // States for the feedback dialog
  const [isFeedbackDialogOpen, setIsFeedbackDialogOpenInternal] = useState(
    false,
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [initialScore, setInitialScore] = useState<number>(1);

  // Close dialog & hide buttons when the user navigates to a different route
  const location = useLocation();
  useEffect(() => {
    setIsFeedbackDialogOpen(false);
  }, [location.pathname]);

  const setIsFeedbackDialogOpen = (enabled: boolean) => {
    const wasOpen = isFeedbackDialogOpen;
    setIsFeedbackDialogOpenInternal(enabled);
    if (!wasOpen && enabled && onOpen) {
      onOpen();
    } else if (wasOpen && !enabled && onClose) {
      onClose();
    }
  };

  // Handler functions for feedback actions
  const handleOpenFeedback = (score: number) => {
    console.log(
      `Opening ${score === 1 ? "positive" : "negative"} feedback dialog`,
    );
    setInitialScore(score);
    setIsFeedbackDialogOpen(true);
  };

  const handleCloseFeedback = () => {
    setIsFeedbackDialogOpen(false);
  };

  const handleSubmitFeedback = async (
    data: { score: number; explanation: string; userInfo?: any },
  ) => {
    console.log("Submitting feedback:", data);
    setIsSubmitting(true);

    const spanId = llmRequestId;
    try {
      await submitFeedback(
        {
          score: data.score,
          explanation: data.explanation,
          spanId,
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
    <div className={className}>
      {/* Feedback dialog for submissions */}
      <FeedbackDialog
        isOpen={isFeedbackDialogOpen}
        onClose={handleCloseFeedback}
        onSubmit={handleSubmitFeedback}
        initialScore={initialScore}
        isSubmitting={isSubmitting}
      />
      <div onClick={() => handleOpenFeedback(0)}>
        <Slot name="negative" required>{children}</Slot>
      </div>
      <div onClick={() => handleOpenFeedback(1)}>
        <Slot name="positive" required>{children}</Slot>
      </div>
    </div>
  );
}
