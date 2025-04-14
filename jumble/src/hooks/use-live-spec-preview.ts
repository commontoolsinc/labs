import { generateSpecAndSchema } from "@commontools/llm";
import { useCallback, useEffect, useState } from "react";
import { useDebounce } from "./use-debounce.ts";
import { useRef } from "react";
import {
  CharmManager,
  formatPromptWithMentions as formatMentions,
  parseComposerDocument,
  processInputSection,
  processWorkflow,
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

  // Track the current generation process to cancel outdated requests
  const currentGenerationRef = useRef<string>("0");

  // Track the text input that generated the current displayed results
  const [lastSuccessfulText, setLastSuccessfulText] = useState<string>("");

  // Preview content state
  const [previewForm, setPreviewForm] = useState<Partial<WorkflowForm>>({});
  const debouncedInput = useDebounce(input, debounceTime);

  // Map the model type to actual model identifiers
  const getModelId = useCallback((modelType: SpecPreviewModel) => {
    return modelType === "fast"
      ? "gemini-2.5-pro"
      : "anthropic:claude-3-7-sonnet-latest";
  }, []);

  const generatePreview = useCallback(
    async (text: string, prefill?: Partial<WorkflowForm>) => {
      console.log(
        "generatePreview called with:",
        text,
        "enabled:",
        enabled,
      );

      // Create a unique ID for this generation process
      const generationId = crypto.randomUUID();
      currentGenerationRef.current = generationId;
      console.groupCollapsed("generatePreview[" + generationId + "]");

      // Reset states based on whether this is a refinement or new topic
      const resetState = () => {
        const textInvalid = !text || !text.trim() || text.trim().length < 10 ||
          !enabled;

        console.log("Reset state check:", {
          textInvalid,
          lastSuccessfulText: lastSuccessfulText.substring(0, 20) + "...",
          currentText: text.substring(0, 20) + "...",
        });

        setPreviewForm({});
        setClassificationLoading(false);
        setPlanLoading(false);
        setLoading(false);
      };

      // Helper function to check if this generation process is still current
      const isCurrentGeneration = () =>
        currentGenerationRef.current === generationId;

      // Don't generate previews for short inputs (less than 8 chars) or if disabled
      // This helps prevent unnecessary API calls and LLM requests
      if (!text || !text.trim() || text.trim().length < 8 || !enabled) {
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

      // Instead, set loading without touching progress
      // If previous sections completed, they should stay completed

      try {
        // Define a shared model ID for both calls
        const modelId = getModelId(model);
        const cancellation = { cancelled: false };

        const form = await processWorkflow(text, true, {
          charmManager,
          existingCharm: currentCharm,
          model: modelId,
          generationId,
          prefill: prefill,
          onProgress: (f) => {
            // Check if this is still the current generation before proceeding
            if (!isCurrentGeneration()) {
              cancellation.cancelled = true;
              console.log(
                generationId,
                "Abandoning outdated generation process",
              );
              return;
            }

            setPreviewForm(f);
          },
          cancellation: cancellation,
        });
        setPreviewForm(form);

        // Check if this is still the current generation before proceeding
        if (!isCurrentGeneration()) {
          cancellation.cancelled = true;
          console.log(generationId, "Abandoning outdated generation process");
          return;
        }

        // Important: Turn off the main loading state after classification
        // so UI can show partial results while plan and spec are loading
        setLoading(false);
        setLastSuccessfulText(text);
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
        console.groupEnd();
      }
    },
    [enabled, model, getModelId, currentCharm, charmManager],
  );

  // Generate preview when input changes
  useEffect(() => {
    async function fx() {
      const { text } = await parseComposerDocument(debouncedInput);
      if (text && text.trim().length >= 8 && enabled) {
        generatePreview(debouncedInput);
      }
    }

    fx();
  }, [debouncedInput, generatePreview, enabled, charmManager]);

  // Function to manually change the workflow type
  const setWorkflowType = useCallback((type: WorkflowType) => {
    // Create a unique ID for this generation process
    const generationId = crypto.randomUUID();
    currentGenerationRef.current = generationId;

    // Update the workflow type state immediately
    const form = {
      classification: {
        workflowType: type,
        confidence: 1.0,
        reasoning: "Manual override",
      },
    };
    setPreviewForm(form);
    generatePreview(input, form);
  }, [input, currentCharm, model, getModelId, charmManager]);

  return {
    previewForm,
    loading,
    classificationLoading,
    planLoading,
    model,
    setWorkflowType,
  };
}
