interface UserInfo {
  name: string;
  email: string;
  shortName: string;
  avatar: string;
}

interface FeedbackData {
  score: number;
  explanation: string;
  spanId: string;
}

export async function fetchUserInfo(): Promise<UserInfo | null> {
  try {
    console.log("Fetching user info from /api/whoami...");
    const response = await fetch("/api/whoami");
    if (!response.ok) {
      throw new Error(
        `Failed to fetch user info: ${response.status} ${response.statusText}`,
      );
    }
    const data = await response.json();
    console.log("User info fetched successfully:", data);
    return data;
  } catch (error) {
    console.error("Error fetching user info:", error);
    return null;
  }
}

export async function submitFeedback(
  data: FeedbackData,
  userInfo: UserInfo | null,
): Promise<boolean> {
  try {
    const payload = {
      span_id: data.spanId,
      name: userInfo?.email || "anonymous@user.com",
      annotator_kind: "HUMAN",
      result: {
        label: "user_feedback",
        score: data.score,
        explanation: data.explanation,
      },
    };

    console.log("Sending feedback payload:", JSON.stringify(payload, null, 2));

    const response = await fetch("/api/ai/llm/feedback", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    console.log("Feedback API response status:", response.status);
    if (!response.ok) {
      const errorData = await response.json();
      console.error("Feedback API error response:", errorData);

      let errorMessage = `Failed to submit feedback: ${response.status}`;
      if (errorData.error) {
        if (typeof errorData.error === "object") {
          // Handle Zod errors or other object errors with proper formatting
          errorMessage = `${
            errorData.error.message || JSON.stringify(errorData.error)
          }`;
        } else {
          errorMessage = errorData.error;
        }
      }

      throw new Error(errorMessage);
    }

    const responseData = await response.json();
    console.log("Feedback API success response:", responseData);
    return true;
  } catch (error) {
    console.error("Error submitting feedback:", error);
    throw error;
  }
}
