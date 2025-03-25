import { generateSpecAndSchema } from "@commontools/llm";
import { useCallback, useEffect, useState } from "react";
import { useDebounce } from "./use-debounce.ts";

/**
 * Hook for generating a live preview of the spec as the user types
 * @param input The user's input text
 * @param enabled Whether the preview is enabled
 * @param debounceTime The debounce time in ms
 */
export function useLiveSpecPreview(
  input: string,
  enabled: boolean = true,
  debounceTime: number = 1000
) {
  const [loading, setLoading] = useState(false);
  const [previewSpec, setPreviewSpec] = useState<string>("");
  const [previewPlan, setPreviewPlan] = useState<string>("");
  const debouncedInput = useDebounce(input, debounceTime);

  const generatePreview = useCallback(async (text: string) => {
    if (!text.trim() || !enabled) {
      setPreviewSpec("");
      setPreviewPlan("");
      return;
    }

    setLoading(true);
    try {
      // Generate spec and plan from input
      const result = await generateSpecAndSchema(text);
      setPreviewSpec(result.spec);
      setPreviewPlan(result.plan);
    } catch (error) {
      console.error("Error generating spec preview:", error);
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    generatePreview(debouncedInput);
  }, [debouncedInput, generatePreview]);

  return {
    previewSpec,
    previewPlan,
    loading,
    regenerate: () => generatePreview(input),
  };
}
