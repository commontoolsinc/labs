import { generateSpecAndSchema } from "@commontools/llm";
import { useCallback, useEffect, useState } from "react";
import { useDebounce } from "./use-debounce.ts";
import { useRef } from "react";
import {
  CharmManager,
  createWorkflowForm,
  fillClassificationSection,
  fillPlanningSection,
  formatPromptWithMentions as formatMentions,
  generateWorkflowPreview,
  parseComposerDocument,
  processInputSection,
  WorkflowForm,
  WorkflowType,
} from "@commontools/charm";
import { Cell } from "@commontools/runner";
import { Charm, formatPromptWithMentions } from "@commontools/charm";
import { JSONSchema } from "@commontools/builder";

export type SpecPreviewModel = "fast" | "think";

/**
 * Progress state for the preview generation
 * Used to track which parts of the preview have been generated
 */
export interface PreviewProgress {
  classification: boolean;
  plan: boolean;
  spec: boolean;
}

/**
 * Hook for generating a live preview of the spec and plan as the user types,
 * along with workflow type classification.
 * @param input The user's input text
 * @param charmManager The CharmManager instance for handling mentions
 * @param enabled Whether the preview is enabled
 * @param debounceTime The debounce time in ms
 * @param model The model to use ("fast" or "think")
 * @param currentCharm Optional current charm for context
 */
export function useLiveSpecPreview(
  input: string,
  charmManager: CharmManager, // Properly typed CharmManager instance
  enabled: boolean = true,
  debounceTime: number = 300, // Increased to 300ms as requested
  model: SpecPreviewModel = "think",
  currentCharm?: Cell<Charm>,
) {
  // Track loading states separately for classification and plan generation
  const [classificationLoading, setClassificationLoading] = useState(false);
  const [planLoading, setPlanLoading] = useState(false);
  const [loading, setLoading] = useState(false); // Combined loading state for compatibility

  // Track which parts of the preview have been generated
  const [progress, setProgress] = useState<PreviewProgress>({
    classification: false,
    plan: false,
    spec: false,
  });

  // Track the current generation process to cancel outdated requests
  const currentGenerationRef = useRef<number>(0);

  // Track the text input that generated the current displayed results
  const [lastSuccessfulText, setLastSuccessfulText] = useState<string>("");

  // Track if input is a completely new topic vs. refinement of existing one
  const isCompleteTopic = useRef<boolean>(true);

  // Preview content state
  const [previewForm, setPreviewForm] = useState<Partial<WorkflowForm>>({});
  const debouncedInput = useDebounce(input, debounceTime);

  // Map the model type to actual model identifiers
  const getModelId = useCallback((modelType: SpecPreviewModel) => {
    return modelType === "fast"
      ? "gemini-2.5-pro"
      : "anthropic:claude-3-7-sonnet-latest";
  }, []);

  const generatePreview = useCallback(async (text: string) => {
    console.log(
      "generatePreview called with:",
      text?.substring(0, 30),
      "enabled:",
      enabled,
    );

    // Create a unique ID for this generation process
    const generationId = Date.now();
    currentGenerationRef.current = generationId;

    // Reset states based on whether this is a refinement or new topic
    const resetState = () => {
      const textInvalid = !text || !text.trim() || text.trim().length < 10 ||
        !enabled;
      const isNewTopic = isCompleteTopic.current;

      console.log("Reset state check:", {
        textInvalid,
        isNewTopic,
        lastSuccessfulText: lastSuccessfulText.substring(0, 20) + "...",
        currentText: text.substring(0, 20) + "...",
      });

      // Always reset content when starting a completely new topic
      if (isNewTopic) {
        console.log("Resetting preview content - new topic detected");
        setPreviewForm({});
      }

      // Always reset loading states
      setClassificationLoading(false);
      setPlanLoading(false);
      setLoading(false);

      // Only reset progress flags if:
      // 1. Text is invalid (too short/empty/disabled) OR
      // 2. This is a completely new topic (not a refinement)
      if (textInvalid || isNewTopic) {
        console.log(
          "Full reset of progress flags - " +
            (textInvalid ? "invalid input" : "new topic"),
        );
        setProgress({
          classification: false,
          plan: false,
          spec: false,
        });
      } else {
        console.log("Preserving progress state - refinement of existing text");
      }
    };

    // Helper function to check if this generation process is still current
    const isCurrentGeneration = () =>
      currentGenerationRef.current === generationId;

    // Don't generate previews for short inputs (less than 16 chars) or if disabled
    // This helps prevent unnecessary API calls and LLM requests
    if (!text || !text.trim() || text.trim().length < 16 || !enabled) {
      console.log("Skipping preview generation - text too short or disabled");
      resetState();
      return;
    }

    console.log("Starting preview generation...");

    // Set loading states to true at the start, but DON'T reset progress states
    // This is critical to prevent erasing progress when user is typing quickly
    setClassificationLoading(true);
    setPlanLoading(true);
    setLoading(true);

    // IMPORTANT: We're NOT resetting progress flags here anymore
    // Only show loading indicators but keep any existing progress
    console.log(
      "Starting new request but preserving progress state:",
      progress,
    );

    // Instead, set loading without touching progress
    // If previous sections completed, they should stay completed

    try {
      // Define a shared model ID for both calls
      const modelId = getModelId(model);

      let form = createWorkflowForm({
        input: text,
        charm: currentCharm,
        modelId,
      });
      setPreviewForm(form);

      form = await processInputSection(charmManager, form);
      setPreviewForm(form);
      console.log("formatted input", form);

      // Check if this is still the current generation before proceeding
      if (!isCurrentGeneration()) {
        console.log("Abandoning outdated generation process");
        return;
      }

      form = await fillClassificationSection(form);
      setPreviewForm(form);
      setClassificationLoading(false);
      setProgress((prev) => ({ ...prev, classification: true }));

      // Important: Turn off the main loading state after classification
      // so UI can show partial results while plan and spec are loading
      setLoading(false);

      console.log("classified task", form);

      // Check if this is still the current generation before proceeding
      if (!isCurrentGeneration()) {
        console.log("Abandoning outdated generation process");
        return;
      }

      form = await fillPlanningSection(form);
      setPreviewForm(form);

      console.log("got plan", form);

      // Record this successful text for future comparison
      setLastSuccessfulText(text);

      // Clear any remaining loading states
      setLoading(false);
    } catch (error) {
      console.error("Error generating preview:", error);
    } finally {
      // Only reset loading states if this is still the current generation
      if (isCurrentGeneration()) {
        setLoading(false);
        // Reset any lingering loading states to ensure UI doesn't get stuck
        setClassificationLoading(false);
        setPlanLoading(false);
      }
    }
  }, [enabled, model, getModelId, currentCharm, charmManager]);

  // Check if input is a significant change from previous content
  useEffect(() => {
    if (!lastSuccessfulText || !debouncedInput) return;

    // Determine if this is a refinement of the same topic or a completely new topic
    // A simple heuristic: if 50% or more of the content has changed, consider it a new topic
    const similarity = calculateTextSimilarity(
      lastSuccessfulText,
      debouncedInput,
    );
    isCompleteTopic.current = similarity < 0.5;

    console.log(
      "Text similarity:",
      similarity,
      isCompleteTopic.current
        ? "NEW TOPIC - Will reset all progress"
        : "Refinement - Will preserve progress",
    );
  }, [debouncedInput, lastSuccessfulText]);

  // Calculate text similarity as a rough percentage of how much text is preserved
  const calculateTextSimilarity = (textA: string, textB: string): number => {
    if (!textA || !textB) return 0;

    // Use a simple character-based comparison for efficiency
    const lengthA = textA.length;
    const lengthB = textB.length;
    const maxLength = Math.max(lengthA, lengthB);

    // Early exit for empty strings
    if (maxLength === 0) return 1;

    // If lengths are very different, likely a new topic
    if (Math.abs(lengthA - lengthB) / maxLength > 0.5) return 0.25;

    // Simple character-based similarity for quick comparison
    let commonChars = 0;
    const minLength = Math.min(lengthA, lengthB);

    for (let i = 0; i < minLength; i++) {
      if (textA[i] === textB[i]) commonChars++;
    }

    return commonChars / maxLength;
  };

  // Generate preview when input changes
  useEffect(() => {
    console.log("debouncedInput changed:", debouncedInput);

    async function fx() {
      const { text } = await parseComposerDocument(debouncedInput);
      if (text && text.trim().length >= 10 && enabled) {
        console.log("Generating preview for:", text);
        generatePreview(debouncedInput);
      } else {
        console.log(
          "Not generating preview. Length:",
          text?.trim().length,
          "Enabled:",
          enabled,
        );
      }
    }

    fx();
  }, [debouncedInput, generatePreview, enabled, charmManager]);

  // Function to manually change the workflow type
  const setWorkflowType = useCallback((type: WorkflowType) => {
    // Create a unique ID for this generation process
    const generationId = Date.now();
    currentGenerationRef.current = generationId;

    // Helper function to check if this generation process is still current
    const isCurrentGeneration = () =>
      currentGenerationRef.current === generationId;

    // Update the workflow type state immediately
    setPreviewForm({
      ...previewForm,
      classification: {
        workflowType: type,
        confidence: 1.0,
        reasoning: "Manual override",
      },
    });
  }, [input, currentCharm, model, getModelId, charmManager]);

  return {
    previewForm,
    loading,
    classificationLoading,
    planLoading,
    regenerate: () => generatePreview(input),
    model,
    setWorkflowType,
    progress,
  };
}
