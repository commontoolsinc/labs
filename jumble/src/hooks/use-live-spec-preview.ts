import { generateSpecAndSchema } from "@commontools/llm";
import { useCallback, useEffect, useState } from "react";
import { useDebounce } from "./use-debounce.ts";

export type SpecPreviewModel = "fast" | "think";

/**
 * Hook for generating a live preview of the spec as the user types
 * @param input The user's input text
 * @param enabled Whether the preview is enabled
 * @param debounceTime The debounce time in ms
 * @param model The model to use ("fast" or "think")
 */
export function useLiveSpecPreview(
  input: string,
  enabled: boolean = true,
  debounceTime: number = 250,
  model: SpecPreviewModel = "think",
) {
  const [loading, setLoading] = useState(false);
  const [previewSpec, setPreviewSpec] = useState<string>("");
  const [previewPlan, setPreviewPlan] = useState<string>("");
  const debouncedInput = useDebounce(input, debounceTime);

  // Map the model type to actual model identifiers
  const getModelId = useCallback((modelType: SpecPreviewModel) => {
    return modelType === "fast"
      ? "google:gemini-2.0-flash"
      : "anthropic:claude-3-7-sonnet-latest";
  }, []);

  const generatePreview = useCallback(async (text: string) => {
    if (!text.trim() || !enabled) {
      setPreviewSpec("");
      setPreviewPlan("");
      return;
    }

    setLoading(true);
    try {
      // Generate spec and plan from input using the selected model
      const modelId = getModelId(model);
      const result = await generateSpecAndSchema(text, undefined, modelId);
      setPreviewSpec(result.spec);
      setPreviewPlan(result.plan);
    } catch (error) {
      console.error("Error generating spec preview:", error);
    } finally {
      setLoading(false);
    }
  }, [enabled, model, getModelId]);

  useEffect(() => {
    generatePreview(debouncedInput);
  }, [debouncedInput, generatePreview]);

  return {
    previewSpec,
    previewPlan,
    loading,
    regenerate: () => generatePreview(input),
    model,
  };
}
