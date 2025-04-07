import { generateSpecAndSchema } from "@commontools/llm";
import { useCallback, useEffect, useState } from "react";
import { useDebounce } from "./use-debounce.ts";
import {
  CharmManager,
  createWorkflowForm,
  ExecutionPlan,
  fillClassificationSection,
  fillPlanningSection,
  formatPromptWithMentions as formatMentions,
  generateWorkflowPreview,
  getIframeRecipe,
  processInputSection,
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
  debounceTime: number = 250,
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

  // Preview content state
  const [previewSpec, setPreviewSpec] = useState<string>("");
  const [previewPlan, setPreviewPlan] = useState<string[]>([]);
  const [workflowType, setWorkflowType] = useState<WorkflowType>("edit");
  const [workflowConfidence, setWorkflowConfidence] = useState<number>(0);
  const [workflowReasoning, setWorkflowReasoning] = useState<string>("");
  const [updatedSchema, setUpdatedSchema] = useState<JSONSchema | undefined>(
    undefined,
  );
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

    // Reset all states at the beginning
    const resetState = () => {
      setPreviewSpec("");
      setPreviewPlan([]);
      setWorkflowConfidence(0);
      setWorkflowReasoning("");
      setClassificationLoading(false);
      setPlanLoading(false);
      setLoading(false);
      setProgress({
        classification: false,
        plan: false,
        spec: false,
      });
    };

    // Don't generate previews for very short inputs (less than 10 chars) or if disabled
    // This helps prevent unnecessary API calls and LLM requests
    if (!text || !text.trim() || text.trim().length < 10 || !enabled) {
      console.log("Skipping preview generation - text too short or disabled");
      resetState();
      return;
    }

    console.log("Starting preview generation...");

    // Set loading states to true at the start, but keep progress states false
    setClassificationLoading(true);
    setPlanLoading(true);
    setLoading(true);
    setProgress({
      classification: false,
      plan: false,
      spec: false,
    });

    try {
      // Process mentions first - needed for both classification and plan
      console.log("Formatting mentions using charmManager:", !!charmManager);
      let processedText;
      let sources = {};
      let mentionResult;

      // try {
      //   // First try the app's formatPromptWithMentions
      //   mentionResult = await formatPromptWithMentions(text, charmManager);
      //   processedText = mentionResult.text;
      //   sources = mentionResult.sources;
      // } catch (appMentionError) {
      //   console.warn(
      //     "App mention formatting failed, trying charm version:",
      //     appMentionError,
      //   );

      //   // Fall back to the charm package's formatPromptWithMentions
      //   try {
      //     const charmMentionResult = await formatMentions(text, charmManager);
      //     processedText = charmMentionResult.text;
      //     sources = charmMentionResult.mentions;
      //   } catch (charmMentionError) {
      //     console.error(
      //       "Both mention formatting approaches failed:",
      //       charmMentionError,
      //     );
      //     processedText = text; // Use the raw text if both approaches fail
      //   }
      // }

      // console.log(
      //   "Mentions formatted:",
      //   processedText?.substring(0, 30),
      //   "sources:",
      //   Object.keys(sources || {}).length,
      // );

      // Define a shared model ID for both calls
      const modelId = getModelId(model);

      let form = createWorkflowForm(text);
      form.meta.modelId = modelId;
      form.input.existingCharm = currentCharm;

      form = await processInputSection(charmManager, form);
      console.log("formatted input", form);
      form = await fillClassificationSection(form);
      console.log("classified task", form);
      form = await fillPlanningSection(form);
      console.log("got plan", form);

      // Use the new unified workflow preview function that handles both classification and plan generation
      console.log("Calling generateWorkflowPreview with model:", modelId);

      // PROGRESSIVE UPDATE: First update classification
      if (form.classification.workflowType) {
        setWorkflowType(form.classification.workflowType);
      }

      if (typeof form.classification.confidence === "number") {
        setWorkflowConfidence(form.classification.confidence);
      }

      if (form.classification.reasoning) {
        setWorkflowReasoning(form.classification.reasoning);
      }

      // Update classification progress and remove loading state
      setProgress((prev) => ({ ...prev, classification: true }));
      setClassificationLoading(false);

      // Small artificial delay to allow the UI to reflect classification
      // This makes the progressive reveal more noticeable
      await new Promise((resolve) => setTimeout(resolve, 100));

      // PROGRESSIVE UPDATE: Then update plan
      if (form.plan?.steps && form.plan.steps.length > 0) {
        setPreviewPlan(form.plan.steps);
      } else {
        setPreviewPlan([]);
      }

      // Update plan progress and remove loading state
      setProgress((prev) => ({ ...prev, plan: true }));
      setPlanLoading(false);

      // Small artificial delay before showing spec
      await new Promise((resolve) => setTimeout(resolve, 100));

      // PROGRESSIVE UPDATE: Finally, update spec if available
      if (form.plan.spec) {
        try {
          // Attempt to extract just the specification section for display
          const specMatch = form.plan.spec.match(
            /<specification>([\s\S]*?)<\/specification>/,
          );
          if (specMatch && specMatch[1]) {
            setPreviewSpec(specMatch[1].trim());
          } else {
            // If can't extract, use the full spec but remove the XML tags
            setPreviewSpec(
              form.plan.spec.replace(/<\/?[^>]+(>|$)/g, "").trim(),
            );
          }
        } catch (e) {
          // If parsing fails, just use the raw spec
          setPreviewSpec(form.plan.spec);
        }
      } else {
        setPreviewSpec("");
      }

      // Update schema if available
      if (form.plan.schema) {
        setUpdatedSchema(form.plan.schema);
      }

      // Mark spec as complete
      setProgress((prev) => ({ ...prev, spec: true }));

      // Clear any remaining loading states
      setLoading(false);
    } catch (error) {
      console.error("Error generating preview:", error);
    } finally {
      setLoading(false);
    }
  }, [enabled, model, getModelId, currentCharm, charmManager]);

  // Generate preview when input changes
  useEffect(() => {
    console.log("debouncedInput changed:", debouncedInput);
    if (debouncedInput && debouncedInput.trim().length >= 10 && enabled) {
      console.log("Generating preview for:", debouncedInput);
      generatePreview(debouncedInput);
    } else {
      console.log(
        "Not generating preview. Length:",
        debouncedInput?.trim().length,
        "Enabled:",
        enabled,
      );
    }
  }, [debouncedInput, generatePreview, enabled, charmManager]);

  // Function to manually change the workflow type
  const setWorkflow = useCallback((type: WorkflowType) => {
    // Update the workflow type state immediately
    setWorkflowType(type);

    // Reset progress states for plan and spec (but keep classification)
    // so that we show the proper loading indicators
    setProgress((prev) => ({
      ...prev,
      plan: false,
      spec: false,
    }));

    // Always regenerate the plan when workflow type changes to ensure consistency
    const regeneratePreviewForWorkflow = async () => {
      try {
        // Set plan loading state to true
        setPlanLoading(true);

        // We're manually setting the workflow, so mark classification as complete
        setProgress((prev) => ({
          ...prev,
          classification: true,
        }));

        // Pass the processed text, sources, and the new workflow type to the workflow preview
        const preview = await generateWorkflowPreview(
          input,
          currentCharm,
          getModelId(model),
          charmManager, // Pass CharmManager to handle nested mentions
          {
            classification: {
              workflowType: type,
              confidence: 1.0,
              reasoning: "Manual selection by user", // Clear indication of manual override
            },
          },
        );

        // PROGRESSIVE REVEAL: First update the plan
        if (preview.plan && preview.plan.length > 0) {
          setPreviewPlan(preview.plan);
        } else {
          // Default message if no plan is returned
          setPreviewPlan(["Generate implementation based on specification"]);
        }

        // Update plan progress
        setProgress((prev) => ({ ...prev, plan: true }));

        // Small delay to make the progressive reveal more noticeable
        await new Promise((resolve) => setTimeout(resolve, 100));

        // PROGRESSIVE REVEAL: Then update the spec
        // For fix workflows, we preserve the existing spec
        // For edit/imagine, use the new spec
        if (type === "fix") {
          // For fix workflows, we might want to show the original spec but mark it as preserved
          if (currentCharm) {
            // Try to get the original spec from the charm
            const originalSpec = await getOriginalSpecFromCharm(currentCharm);
            if (originalSpec) {
              setPreviewSpec(originalSpec);
            } else {
              setPreviewSpec(""); // If can't get original, hide spec
            }
          } else {
            setPreviewSpec(""); // No current charm, hide spec
          }
        } else if (preview.spec) {
          // For edit/imagine, show the generated spec
          try {
            // Attempt to extract just the specification section for display
            const specMatch = preview.spec.match(
              /<specification>([\s\S]*?)<\/specification>/,
            );
            if (specMatch && specMatch[1]) {
              setPreviewSpec(specMatch[1].trim());
            } else {
              // If can't extract, use the full spec but remove the XML tags
              setPreviewSpec(
                preview.spec.replace(/<\/?[^>]+(>|$)/g, "").trim(),
              );
            }
          } catch (e) {
            // If parsing fails, just use the raw spec
            setPreviewSpec(preview.spec);
          }
        }

        // Update schema if available
        if (preview.updatedSchema) {
          setUpdatedSchema(preview.updatedSchema);
        }

        // Mark spec as complete
        setProgress((prev) => ({ ...prev, spec: true }));
      } catch (error) {
        console.error("Error regenerating preview on workflow change:", error);

        // Even on error, mark classification as complete since user manually selected it
        setProgress((prev) => ({ ...prev, classification: true }));
      } finally {
        // Clear loading state
        setPlanLoading(false);
      }
    };

    // Execute the async function
    if (input && input.trim().length >= 10) {
      regeneratePreviewForWorkflow();
    }
  }, [input, currentCharm, model, getModelId, charmManager]);

  // Helper function to extract the original spec from a charm
  const getOriginalSpecFromCharm = (charm: Cell<Charm>) => {
    try {
      // Import getIframeRecipe from the charm package if needed
      // This should extract the spec from the charm
      const iframeRecipe = getIframeRecipe(charm);
      return iframeRecipe?.iframe?.spec || "";
    } catch (error) {
      console.error("Error getting original spec from charm:", error);
      return "";
    }
  };

  // Helper function to extract the original argument schema from a charm
  const getOriginalArgumentSchemaFromCharm = (charm: Cell<Charm>) => {
    try {
      const iframeRecipe = getIframeRecipe(charm);
      return iframeRecipe?.iframe?.argumentSchema || undefined;
    } catch (error) {
      console.error(
        "Error getting original argument schema from charm:",
        error,
      );
      return undefined;
    }
  };

  let originalSchema;
  if (currentCharm) {
    originalSchema = getOriginalArgumentSchemaFromCharm(currentCharm);
  }
  const schema = updatedSchema || originalSchema;

  // Create a form data object to expose to parent components
  const formData: ExecutionPlan | undefined = schema
    ? {
      workflowType,
      steps: previewPlan,
      spec: previewSpec,
      schema,
    }
    : undefined;

  return {
    previewSpec,
    previewPlan,
    loading,
    classificationLoading,
    planLoading,
    regenerate: () => generatePreview(input),
    model,
    workflowType,
    workflowConfidence,
    workflowReasoning,
    updatedSchema,
    setWorkflow,
    // Include progress state to let components know which parts are ready
    progress,
    // Return the form data for downstream consumers
    formData,
  };
}
