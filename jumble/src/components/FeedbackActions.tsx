import { useEffect, useState } from "react";
import { Action, useActionManager } from "@/contexts/ActionManagerContext.tsx";
import { FeedbackDialog } from "@/components/FeedbackDialog.tsx";
import { submitFeedback } from "@/services/feedback.ts";
import { MdSend, MdThumbDownOffAlt, MdThumbUpOffAlt } from "react-icons/md";

// FIXME(jake): This is for demo purposes... ideally we could just get the llm
// span from the persisted blobby blob of the charm recipe, but none of that is hooked up yet.
const CURRENT_SPAN_ID = "48fc49c695cdc4f3";

export function FeedbackActions() {
  // States for the feedback dialog
  const [isFeedbackDialogOpen, setIsFeedbackDialogOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [initialScore, setInitialScore] = useState<number>(1);
  const [showFeedbackButtons, setShowFeedbackButtons] = useState(false);
  const { registerAction } = useActionManager();

  // Handler functions for feedback actions
  const toggleFeedbackButtons = () => {
    setShowFeedbackButtons((prev) => !prev);
  };

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
          spanId: CURRENT_SPAN_ID,
        },
        data.userInfo,
      );

      setIsFeedbackDialogOpen(false);
      alert("Feedback submitted successfully! Thank you for your input.");
    } catch (error) {
      alert(
        `Error submitting feedback: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  // Register all actions
  useEffect(() => {
    // Create actions array for batch registration
    const actions: Action[] = [];

    // Register the main feedback toggle button
    const toggleAction: Action = {
      id: "feedback-toggle",
      label: "Feedback",
      icon: <MdSend size={24} />,
      onClick: toggleFeedbackButtons,
      priority: 30,
      className: showFeedbackButtons ? "bg-blue-100" : "",
    };

    actions.push(toggleAction);

    // Register all actions and collect unregister functions
    const unregisterFunctions = actions.map((action) => registerAction(action));

    // Return combined cleanup function
    return () => {
      unregisterFunctions.forEach((unregister) => unregister());
    };
  }, [showFeedbackButtons, registerAction]);

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
