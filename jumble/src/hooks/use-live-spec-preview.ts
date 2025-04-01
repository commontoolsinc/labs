import { generateSpecAndSchema } from "@commontools/llm";
import { useCallback, useEffect, useState } from "react";
import { useDebounce } from "./use-debounce.ts";
import { 
  generateWorkflowPreview, 
  WorkflowType, 
  CharmManager, 
  classifyIntent 
} from "@commontools/charm";
import { Cell } from "@commontools/runner";
import { Charm } from "@commontools/charm";
import { JSONSchema } from "@commontools/builder";
import { formatPromptWithMentions } from "@/utils/format.ts";

export type SpecPreviewModel = "fast" | "think";

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

  const [previewSpec, setPreviewSpec] = useState<string>("");
  const [previewPlan, setPreviewPlan] = useState<string[] | string>("");
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
    console.log("generatePreview called with:", text?.substring(0, 30), "enabled:", enabled);
    
    // Reset all states at the beginning
    const resetState = () => {
      setPreviewSpec("");
      setPreviewPlan("");
      setWorkflowConfidence(0);
      setWorkflowReasoning("");
      setClassificationLoading(false);
      setPlanLoading(false);
      setLoading(false);
    };
    
    // Don't generate previews for very short inputs (less than 10 chars) or if disabled
    // This helps prevent unnecessary API calls and LLM requests
    if (!text || !text.trim() || text.trim().length < 10 || !enabled) {
      console.log("Skipping preview generation - text too short or disabled");
      resetState();
      return;
    }

    console.log("Starting preview generation...");
    
    // Set both loading states to true at the start
    setClassificationLoading(true);
    setPlanLoading(true);
    setLoading(true);
    
    try {
      // Process mentions first - needed for both classification and plan
      console.log("Formatting mentions using charmManager:", !!charmManager);
      let processedText;
      let sources = {};
      
      try {
        const mentionResult = await formatPromptWithMentions(text, charmManager);
        processedText = mentionResult.text;
        sources = mentionResult.sources;
        console.log("Mentions formatted:", processedText?.substring(0, 30), "sources:", Object.keys(sources).length);
      } catch (mentionError) {
        console.error("Error processing mentions:", mentionError);
        throw mentionError;
      }
      
      // Define a shared model ID for both calls
      const modelId = getModelId(model);
      
      // Split into two parallel operations
      // 1. Get classification (faster)
      const classificationPromise = (async () => {
        // Skip if text is too short or empty
        if (!processedText || processedText.trim().length < 10) {
          console.log("Skipping classification due to short/empty input");
          setClassificationLoading(false);
          return null;
        }
        
        try {
          console.log("Calling classifyIntent for workflow classification");
          const classification = await classifyIntent(
            processedText,
            currentCharm,
            modelId,
            sources
          );
          
          console.log("Classification completed:", classification.workflowType);
          
          // Update classification-related state as soon as it's available
          setWorkflowType(classification.workflowType);
          setWorkflowConfidence(classification.confidence);
          setWorkflowReasoning(classification.reasoning || "");
          setClassificationLoading(false);
          
          return classification;
        } catch (error) {
          console.error("Classification error:", error);
          setClassificationLoading(false);
          throw error;
        }
      })();
      
      // 2. Get the full workflow preview (including plan and spec)
      const workflowPreviewPromise = (async () => {
        // Skip if text is too short or empty
        if (!processedText || processedText.trim().length < 10) {
          console.log("Skipping workflow preview due to short/empty input");
          setPlanLoading(false);
          return null;
        }
        
        try {
          console.log("Calling generateWorkflowPreview with model:", modelId);
          const result = await generateWorkflowPreview(processedText, currentCharm, modelId, sources);
          console.log("Full preview generated successfully!", result);
          
          // Pass the plan as an array to the UI for better formatting
          if (result.plan && result.plan.length > 0) {
            setPreviewPlan(result.plan);
          } else {
            setPreviewPlan("");
          }
          
          // Process spec results
          if (result.spec) {
            try {
              // Attempt to extract just the specification section for display
              const specMatch = result.spec.match(/<specification>([\s\S]*?)<\/specification>/);
              if (specMatch && specMatch[1]) {
                setPreviewSpec(specMatch[1].trim());
              } else {
                // If can't extract, use the full spec but remove the XML tags
                setPreviewSpec(result.spec.replace(/<\/?[^>]+(>|$)/g, "").trim());
              }
            } catch (e) {
              // If parsing fails, just use the raw spec
              setPreviewSpec(result.spec);
            }
          } else {
            setPreviewSpec("");
          }
          
          setUpdatedSchema(result.updatedSchema);
          setPlanLoading(false);
          
          return result;
        } catch (error) {
          console.error("Workflow preview error:", error);
          setPlanLoading(false);
          throw error;
        }
      })();
      
      // Wait for both operations to complete if they're running
      // We await this just to catch any errors, the state updates already happened
      if (processedText && processedText.trim().length >= 10) {
        await Promise.all([classificationPromise, workflowPreviewPromise]);
      }
      
      // Both classification and plan generation are now complete
      setLoading(false);
    } catch (error) {
      console.error("Error generating preview:", error);
      
      // Fallback to the old spec generator in case of error
      try {
        console.log("Using fallback spec generation path");
        const modelId = getModelId(model);
        
        // Using the properly typed CharmManager passed as an argument
        console.log("Fallback: Using charmManager:", !!charmManager);
        
        // IMPORTANT: This step processes the @mentions in the text
        // We need to do this before sending to generateSpecAndSchema
        const { text: processedText, sources } = await formatPromptWithMentions(text, charmManager);
        console.log("Fallback: Processed text:", processedText?.substring(0, 30));
        
        // Set a simple basic classification first as that's faster
        setWorkflowType("edit"); // Default to edit for fallback
        setWorkflowConfidence(0.5);
        setWorkflowReasoning("Fallback classification due to error in main flow");
        setClassificationLoading(false);
        
        // Skip if text is too short or empty
        if (!processedText || processedText.trim().length < 10) {
          console.log("Skipping fallback due to short/empty input");
          setPlanLoading(false);
          return;
        }
        
        // Use the processed text with mentions for the fallback path
        console.log("Fallback: Calling generateSpecAndSchema with model:", modelId);
        const result = await generateSpecAndSchema(processedText, undefined, modelId);
        console.log("Fallback: Spec generation successful!");
        
        // Format the spec in our consistent format with XML tags
        const formattedSpec = `<specification>\n${result.spec}\n</specification>`;
        setPreviewSpec(result.spec); // Display just the clean spec without XML tags
        
        // Format the plan as an array for consistent handling
        const planArray = result.plan 
          ? [result.plan] 
          : ["Generate implementation based on specification"];
        setPreviewPlan(planArray);
        
        setPlanLoading(false);
      } catch (fallbackError) {
        console.error("Fallback preview generation also failed:", fallbackError);
        // Make sure to clear loading states even on failure
        setClassificationLoading(false);
        setPlanLoading(false);
      }
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
      console.log("Not generating preview. Length:", debouncedInput?.trim().length, "Enabled:", enabled);
    }
  }, [debouncedInput, generatePreview, enabled, charmManager]);

  // Function to manually change the workflow type
  const setWorkflow = useCallback((type: WorkflowType) => {
    // Update the workflow type state
    setWorkflowType(type);
    
    // Always regenerate the plan when workflow type changes to ensure consistency
    const regeneratePreviewForWorkflow = async () => {
      try {
        // Set appropriate loading states
        setPlanLoading(true);
        
        // Process mentions in the input text
        const { text: processedText, sources } = await formatPromptWithMentions(input, charmManager);
        
        // Pass the processed text, sources, and the new workflow type to the workflow preview
        const preview = await generateWorkflowPreview(
          processedText, 
          currentCharm, 
          getModelId(model),
          sources, // Pass the sources which contain the mentioned charms
          charmManager, // Pass CharmManager to handle nested mentions
          type // Pass the explicitly selected workflow type
        );
        
        // Update plan based on the new workflow
        if (preview.plan && preview.plan.length > 0) {
          setPreviewPlan(preview.plan);
        } else {
          // Default message if no plan is returned
          setPreviewPlan(["Generate implementation based on specification"]);
        }
        
        // For fix workflows, we preserve the existing spec
        // For edit/rework, use the new spec
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
          // For edit/rework, show the generated spec
          setPreviewSpec(preview.spec);
        }
        
        // Update schema if available
        if (preview.updatedSchema) {
          setUpdatedSchema(preview.updatedSchema);
        }
        
      } catch (error) {
        console.error("Error regenerating preview on workflow change:", error);
      } finally {
        setPlanLoading(false);
      }
    };
    
    // Execute the async function
    if (input && input.trim().length >= 10) {
      regeneratePreviewForWorkflow();
    }
  }, [input, currentCharm, model, getModelId, charmManager]);
  
  // Helper function to extract the original spec from a charm
  const getOriginalSpecFromCharm = async (charm: Cell<Charm>) => {
    try {
      // Import getIframeRecipe from the charm package if needed
      // This should extract the spec from the charm
      const { getIframeRecipe } = await import("@commontools/charm");
      const iframeRecipe = getIframeRecipe(charm);
      return iframeRecipe?.iframe?.spec || "";
    } catch (error) {
      console.error("Error getting original spec from charm:", error);
      return "";
    }
  };

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
  };
}
