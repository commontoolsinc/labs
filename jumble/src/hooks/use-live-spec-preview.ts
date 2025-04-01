import { generateSpecAndSchema } from "@commontools/llm";
import { useCallback, useEffect, useState } from "react";
import { useDebounce } from "./use-debounce.ts";
import { generateWorkflowPreview, WorkflowType } from "@commontools/charm/imagine.ts";
import { Cell } from "@commontools/runner";
import { Charm } from "@commontools/charm";
import { JSONSchema } from "@commontools/builder";

export type SpecPreviewModel = "fast" | "think";

/**
 * Hook for generating a live preview of the spec and plan as the user types,
 * along with workflow type classification.
 * @param input The user's input text
 * @param enabled Whether the preview is enabled
 * @param debounceTime The debounce time in ms
 * @param model The model to use ("fast" or "think")
 * @param currentCharm Optional current charm for context
 */
export function useLiveSpecPreview(
  input: string,
  enabled: boolean = true,
  debounceTime: number = 250,
  model: SpecPreviewModel = "think",
  currentCharm?: Cell<Charm>,
) {
  const [loading, setLoading] = useState(false);
  const [previewSpec, setPreviewSpec] = useState<string>("");
  const [previewPlan, setPreviewPlan] = useState<string>("");
  const [workflowType, setWorkflowType] = useState<WorkflowType>("edit");
  const [workflowConfidence, setWorkflowConfidence] = useState<number>(0);
  const [workflowReasoning, setWorkflowReasoning] = useState<string>("");
  const [updatedSchema, setUpdatedSchema] = useState<JSONSchema | undefined>(undefined);
  const debouncedInput = useDebounce(input, debounceTime);

  // Map the model type to actual model identifiers
  const getModelId = useCallback((modelType: SpecPreviewModel) => {
    return modelType === "fast"
      ? "google:gemini-2.0-flash-thinking"
      : "anthropic:claude-3-7-sonnet-latest";
  }, []);

  const generatePreview = useCallback(async (text: string) => {
    if (!text.trim() || !enabled) {
      setPreviewSpec("");
      setPreviewPlan("");
      setWorkflowConfidence(0);
      setWorkflowReasoning("");
      return;
    }

    setLoading(true);
    try {
      // Use the new workflow preview generator
      const modelId = getModelId(model);
      const result = await generateWorkflowPreview(text, currentCharm, modelId);
      
      // Update all the preview state
      setWorkflowType(result.workflowType);
      setWorkflowConfidence(result.confidence);
      setWorkflowReasoning(result.reasoning || "");
      
      // Format the plan as a numbered list for display
      const formattedPlan = result.plan.length > 0
        ? result.plan.map((step, index) => `${index + 1}. ${step}`).join("\n")
        : "";
        
      setPreviewPlan(formattedPlan);
      
      // Only set spec if it's not a fix workflow
      if (result.workflowType !== "fix") {
        setPreviewSpec(result.spec || "");
      } else {
        setPreviewSpec("");
      }
      
      setUpdatedSchema(result.updatedSchema);
    } catch (error) {
      console.error("Error generating preview:", error);
      
      // Fallback to the old spec generator in case of error
      try {
        const modelId = getModelId(model);
        const result = await generateSpecAndSchema(text, undefined, modelId);
        setPreviewSpec(result.spec);
        setPreviewPlan(result.plan);
        setWorkflowType("edit"); // Default to edit
        setWorkflowConfidence(0.5);
        setWorkflowReasoning("Fallback classification");
      } catch (fallbackError) {
        console.error("Fallback preview generation also failed:", fallbackError);
      }
    } finally {
      setLoading(false);
    }
  }, [enabled, model, getModelId, currentCharm]);

  // Generate preview when input changes
  useEffect(() => {
    generatePreview(debouncedInput);
  }, [debouncedInput, generatePreview]);

  // Function to manually change the workflow type
  const setWorkflow = useCallback((type: WorkflowType) => {
    setWorkflowType(type);
    
    // If switching to fix, hide the spec
    if (type === "fix") {
      setPreviewSpec("");
    } else if (currentCharm && !previewSpec) {
      // If switching to edit/rework and we don't have a spec, try to get one from the charm
      const result = generateWorkflowPreview(input, currentCharm, getModelId(model));
      result.then((preview) => {
        if (preview.spec) {
          setPreviewSpec(preview.spec);
        }
      }).catch(console.error);
    }
  }, [input, currentCharm, model, getModelId, previewSpec]);

  return {
    previewSpec,
    previewPlan,
    loading,
    regenerate: () => generatePreview(input),
    model,
    workflowType,
    workflowConfidence,
    workflowReasoning,
    updatedSchema,
    setWorkflow,
  };
}
