import { generateSpecAndSchema } from "@commontools/llm";
import { useCallback, useEffect, useState } from "react";
import { useDebounce } from "./use-debounce.ts";
import { formatPromptWithMentions } from "@/utils/format.ts";
import { useCharmManager } from "@/contexts/CharmManagerContext.tsx";
import { combineSpecs } from "@/views/CharmDetailView.tsx";

export type SpecPreviewModel = "fast" | "think";

/**
 * Hook for generating a live preview of the spec as the user types
 * @param input The user's input text
 * @param enabled Whether the preview is enabled
 * @param debounceTime The debounce time in ms
 * @param model The model to use ("fast" or "think")
 * @param previousSpec Optional previous specification to combine with new input (for shift key scenario)
 * @param shiftKeyPressed Whether the shift key is pressed (to combine with previous spec)
 */
export function useLiveSpecPreview(
  input: string,
  enabled: boolean = true,
  debounceTime: number = 250,
  model: SpecPreviewModel = "think",
  previousSpec?: string,
) {
  const { charmManager } = useCharmManager();
  const [loading, setLoading] = useState(false);
  const [previewSpec, setPreviewSpec] = useState<string>("");
  const [previewPlan, setPreviewPlan] = useState<string>("");
  const [processedText, setProcessedText] = useState<string>("");
  const [sources, setSources] = useState<Record<string, any>>({});
  const debouncedInput = useDebounce(input, debounceTime);

  // Map the model type to actual model identifiers
  const getModelId = useCallback((modelType: SpecPreviewModel) => {
    return modelType === "fast"
      ? "google:gemini-2.0-flash-thinking"
      : "anthropic:claude-3-7-sonnet-latest";
  }, []);

  const generatePreview = useCallback(async (text: string) => {
    // Don't generate if input is empty/whitespace or preview is disabled
    const trimmedText = text.trim();
    if (!trimmedText || !enabled) {
      setPreviewSpec("");
      setPreviewPlan("");
      setProcessedText("");
      setSources({});
      return;
    }

    setLoading(true);
    try {
      // Process mentions in the input text
      const { text: formattedText, sources: mentionSources } =
        await formatPromptWithMentions(
          text, // Use original input for processing mentions
          charmManager,
        );

      const fullSpec = previousSpec
        ? combineSpecs(previousSpec, formattedText)
        : formattedText;

      const trimmedText = fullSpec.trim();
      if (!trimmedText) {
        return;
      }

      // Store processed text and sources for later use
      setProcessedText(trimmedText);
      setSources(mentionSources);

      // Generate spec and plan from formatted input using the selected model
      const modelId = getModelId(model);
      const result = await generateSpecAndSchema(
        fullSpec,
        undefined,
        modelId,
      );

      setPreviewSpec(result.spec);
      setPreviewPlan(result.plan);
    } catch (error) {
      console.error("Error generating spec preview:", error);
    } finally {
      setLoading(false);
    }
  }, [enabled, model, getModelId, charmManager, previousSpec]);

  useEffect(() => {
    generatePreview(debouncedInput);
  }, [debouncedInput, generatePreview]);

  // Make regenerate return the Promise so it can be awaited
  const regenerate = useCallback(() => {
    return generatePreview(input);
  }, [generatePreview, input]);

  return {
    previewSpec,
    previewPlan,
    processedText,
    sources,
    loading,
    regenerate,
    model,
  };
}
