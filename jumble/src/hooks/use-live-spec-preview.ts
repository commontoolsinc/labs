import { generateSpecAndSchema } from "@commontools/llm";
import { useCallback, useEffect, useState } from "react";
import { useDebounce } from "./use-debounce.ts";
import { useRef } from "react";
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

    // Create a unique ID for this generation process
    const generationId = Date.now();
    currentGenerationRef.current = generationId;

    // Reset states based on whether this is a refinement or new topic
    const resetState = () => {
      const textInvalid = (!text || !text.trim() || text.trim().length < 10 || !enabled);
      const isNewTopic = isCompleteTopic.current;
      
      console.log("Reset state check:", {
        textInvalid, 
        isNewTopic,
        lastSuccessfulText: lastSuccessfulText.substring(0, 20) + "...",
        currentText: text.substring(0, 20) + "..."
      });
      
      // Always reset content when starting a completely new topic
      if (isNewTopic) {
        console.log("Resetting preview content - new topic detected");
        setPreviewSpec("");
        setPreviewPlan([]);
        setWorkflowConfidence(0);
        setWorkflowReasoning("");
      }
      
      // Always reset loading states
      setClassificationLoading(false);
      setPlanLoading(false);
      setLoading(false);
      
      // Only reset progress flags if:
      // 1. Text is invalid (too short/empty/disabled) OR
      // 2. This is a completely new topic (not a refinement)
      if (textInvalid || isNewTopic) {
        console.log("Full reset of progress flags - " + 
          (textInvalid ? "invalid input" : "new topic"));
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

    // Don't generate previews for very short inputs (less than 10 chars) or if disabled
    // This helps prevent unnecessary API calls and LLM requests
    if (!text || !text.trim() || text.trim().length < 10 || !enabled) {
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
    console.log("Starting new request but preserving progress state:", progress);
    
    // Instead, set loading without touching progress
    // If previous sections completed, they should stay completed

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

      // Check if this is still the current generation before proceeding
      if (!isCurrentGeneration()) {
        console.log("Abandoning outdated generation process");
        return;
      }

      form = await fillClassificationSection(form);
      setWorkflowType(form.classification.workflowType);
      setWorkflowReasoning(form.classification.reasoning);
      setWorkflowConfidence(form.classification.confidence);
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
      
      // Log the plan data from form
      console.log("RECEIVED PLAN DATA:", form.plan);
      
      // Make a copy of the plan steps to avoid reference issues
      const planSteps = form.plan?.steps && form.plan.steps.length > 0 
        ? [...form.plan.steps] 
        : [];
      
      if (planSteps && planSteps.length > 0) {
        console.log("Setting plan data:", planSteps);
        
        // First set the plan data
        setPreviewPlan(planSteps);
        
        // Then update the progress state in the next tick
        setTimeout(() => {
          console.log("Setting plan progress - delayed update");
          setPlanLoading(false);
          setProgress((prev) => ({ ...prev, plan: true }));
        }, 100);
      } else {
        console.warn("No plan steps found in form data", form.plan);
        // Set empty plan and update progress
        setPreviewPlan([]);
        setPlanLoading(false);
        setProgress((prev) => ({ ...prev, plan: true }));
      }
      
      console.log("got plan", form);

      // PROGRESSIVE UPDATE: Handle spec extraction
      // Check if this is still the current generation
      if (!isCurrentGeneration()) {
        console.log("Abandoning outdated generation process");
        return;
      }

      // PROGRESSIVE UPDATE: Finally, update spec if available
      if (form.plan.spec) {
        try {
          // Attempt to extract just the specification section for display
          const specMatch = form.plan.spec.match(
            /<specification>([\s\S]*?)<\/specification>/,
          );
          
          let parsedSpec = "";
          if (specMatch && specMatch[1]) {
            parsedSpec = specMatch[1].trim();
          } else {
            // If can't extract, use the full spec but remove the XML tags
            parsedSpec = form.plan.spec.replace(/<\/?[^>]+(>|$)/g, "").trim();
          }
          
          console.log("Setting spec content:", parsedSpec.substring(0, 50) + "...");
          setPreviewSpec(parsedSpec);
          
          // Ensure progress is updated
          setTimeout(() => {
            setProgress((prev) => {
              const newProgress = { ...prev, spec: true };
              console.log("Updated progress to include spec:", newProgress);
              return newProgress;
            });
          }, 50);
        } catch (e) {
          // If parsing fails, just use the raw spec
          console.log("Error parsing spec, using raw content:", e);
          setPreviewSpec(form.plan.spec);
          setProgress((prev) => ({ ...prev, spec: true }));
        }
      } else {
        setPreviewSpec("");
        // Mark spec as complete even if empty
        setProgress((prev) => ({ ...prev, spec: true }));
      }

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
    const similarity = calculateTextSimilarity(lastSuccessfulText, debouncedInput);
    isCompleteTopic.current = (similarity < 0.5);
    
    console.log("Text similarity:", similarity, 
      isCompleteTopic.current ? "NEW TOPIC - Will reset all progress" : "Refinement - Will preserve progress");
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
    // Create a unique ID for this generation process
    const generationId = Date.now();
    currentGenerationRef.current = generationId;

    // Helper function to check if this generation process is still current
    const isCurrentGeneration = () =>
      currentGenerationRef.current === generationId;

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

        // Check if this operation has been superseded before making expensive API call
        if (!isCurrentGeneration()) {
          console.log("Abandoning outdated workflow change generation");
          return;
        }

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

        // Check if this is still the current generation before proceeding
        if (!isCurrentGeneration()) {
          console.log("Abandoning outdated workflow change generation");
          return;
        }

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
        // Clear loading state only if this is still the current generation
        if (isCurrentGeneration()) {
          setPlanLoading(false);
        }
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

  // Debug logging to verify state
  console.log("Current state:", { 
    loading, 
    classificationLoading, 
    planLoading, 
    progress, 
    workflowType,
    planData: previewPlan,
    planType: typeof previewPlan,
    isArray: Array.isArray(previewPlan),
    planLength: Array.isArray(previewPlan) ? previewPlan.length : 0
  });

  // Extra debugging for spec content
  console.log("RETURNING SPEC:", {
    specContent: previewSpec ? previewSpec.substring(0, 30) + "..." : "none",
    planContent: Array.isArray(previewPlan) ? previewPlan.slice(0, 2) : previewPlan,
    progressState: progress
  });

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
