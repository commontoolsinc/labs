import { useCallback, useEffect, useState } from "react";
import { useDebounce } from "./use-debounce.ts";
import { useRef } from "react";
import {
  CharmManager,
  DEFAULT_MODEL,
  parseComposerDocument,
  processWorkflow,
  WorkflowForm,
  WorkflowType,
} from "@commontools/charm";
import { Cell } from "@commontools/runner";
import { Charm } from "@commontools/charm";
import { LanguageModelId } from "@/components/common/ModelSelector.tsx";

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
  charmManager: CharmManager,
  enabled: boolean = true,
  debounceTime: number = 300,
  model: LanguageModelId = DEFAULT_MODEL as LanguageModelId,
  currentCharm?: Cell<Charm>,
) {
  const [loading, setLoading] = useState(false);
  // Track the current generation process to cancel outdated requests
  const currentGenerationRef = useRef<string>("0");

  // Preview content state
  const [previewForm, setPreviewForm] = useState<Partial<WorkflowForm>>({});
  const debouncedInput = useDebounce(input, debounceTime);

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

      // Helper function to check if this generation process is still current
      const isCurrentGeneration = () =>
        currentGenerationRef.current === generationId;

      setLoading(true);

      try {
        const cancellation = { cancelled: false };

        const form = await processWorkflow(text, charmManager, {
          dryRun: true,
          existingCharm: currentCharm,
          model,
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
          cache: true,
        });
        setPreviewForm(form);
        setLoading(false);
      } catch (error) {
        console.error("Error generating preview:", error);
      } finally {
        // Only reset loading states if this is still the current generation
        if (isCurrentGeneration()) {
          setLoading(false);
        }
        console.groupEnd();
      }
    },
    [enabled, model, currentCharm, charmManager],
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

  // Used from the UI to change the workflow
  const setWorkflowType = useCallback((type: WorkflowType) => {
    const generationId = crypto.randomUUID();
    currentGenerationRef.current = generationId;

    const form = {
      classification: {
        workflowType: type,
        confidence: 1.0,
        reasoning: "Manual override",
      },
    };
    setPreviewForm(form);
    generatePreview(input, form);
  }, [input, currentCharm, model, charmManager]);

  return {
    previewForm,
    loading,
    model,
    setWorkflowType,
  };
}
