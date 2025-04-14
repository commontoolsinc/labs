import { useEffect, useState } from "react";
import { fetchUserInfo } from "@/services/feedback.ts";

interface FeedbackDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (
    data: { score: number; explanation: string; userInfo?: any },
  ) => Promise<void>;
  initialScore: number;
  isSubmitting?: boolean;
}

export function FeedbackDialog({
  isOpen,
  onClose,
  onSubmit,
  initialScore,
  isSubmitting = false,
}: FeedbackDialogProps) {
  const [explanation, setExplanation] = useState("");

  // Reset explanation when dialog opens with a new score
  useEffect(() => {
    if (isOpen) {
      setExplanation("");
    }
  }, [isOpen, initialScore]);

  // Log when dialog open state changes
  useEffect(() => {
    console.log(
      "FeedbackDialog isOpen:",
      isOpen,
      "initialScore:",
      initialScore,
    );
  }, [isOpen, initialScore]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return;

      if (e.key === "Escape") {
        onClose();
      } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        if (!isSubmitting && explanation.trim()) {
          submitFeedback();
        }
      }
    };

    globalThis.addEventListener("keydown", handleKeyDown);
    return () => globalThis.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose, onSubmit, explanation, isSubmitting, initialScore]);

  if (!isOpen) return null;

  const submitFeedback = async () => {
    if (!explanation.trim()) return;

    console.log("Submitting feedback form with explanation:", explanation);

    // Fetch user info only when submitting
    try {
      const userInfo = await fetchUserInfo();
      console.log("Fetched user info before submission:", userInfo);

      // Submit feedback with the user info
      await onSubmit({
        score: initialScore,
        explanation,
        userInfo,
      });
    } catch (error) {
      console.error("Error fetching user info during submission:", error);
      // Continue with submission even if user info fetch fails
      await onSubmit({ score: initialScore, explanation });
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    submitFeedback();
  };

  return (
    <div className="fixed inset-0 bg-[#00000080] flex items-center justify-center z-50">
      <div className="bg-white border-2 border-black shadow-[2px_2px_0px_0px_rgba(0,0,0,0.5)] p-6 max-w-lg w-full mx-4">
        <h2 className="text-2xl font-bold mb-4">
          {initialScore === 1 ? "Positive Feedback" : "Improvement Feedback"}
        </h2>
        <form onSubmit={handleSubmit}>
          <div className="mb-6">
            <label className="block text-sm font-medium mb-1">
              {initialScore === 1
                ? "What did you like about this response?"
                : "How could this response be improved?"}
            </label>
            <textarea
              value={explanation}
              onChange={(e) => setExplanation(e.target.value)}
              className="w-full px-3 py-2 border-2 border-black"
              rows={5}
              disabled={isSubmitting}
              placeholder={initialScore === 1
                ? "What aspects were helpful or well done?"
                : "What would make this response more useful?"}
              required
            />
          </div>

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 border-2 border-black hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={isSubmitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 bg-black text-white border-2 border-black hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              disabled={isSubmitting || !explanation.trim()}
            >
              {isSubmitting ? "Submitting..." : (
                <span>
                  Submit <span className="text-xs">cmd+enter</span>
                </span>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
