import {
  Charm,
  extractUserCode,
  extractVersionTag,
  generateNewRecipeVersion,
  getIframeRecipe,
  IFrameRecipe,
  injectUserCode,
  iterate,
} from "@commontools/charm";
import { useCharmReferences } from "@/hooks/use-charm-references.ts";
import { isCell, isStream } from "@commontools/runner";
import { isObj } from "@commontools/utils";
import {
  CheckboxToggle,
  CommonCheckbox,
  CommonLabel,
  ToggleButton,
} from "../components/common/CommonToggle.tsx";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { type CharmRouteParams } from "@/routes.ts";
import { useCharmManager } from "@/contexts/CharmManagerContext.tsx";
import { LoadingSpinner } from "@/components/Loader.tsx";
import { useCharm } from "@/hooks/use-charm.ts";
import CodeMirror from "@uiw/react-codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { CharmRenderer } from "@/components/CharmRunner.tsx";
import { extendCharm } from "@/utils/charm-operations.ts";
import { charmId } from "@/utils/charms.ts";
import { DitheredCube } from "@/components/DitherCube.tsx";
import {
  type CharmSuggestion,
  generateCharmSuggestions,
} from "@commontools/llm";
import { Cell } from "@commontools/runner";
import { createPath } from "@/routes.ts";
import JsonView from "@uiw/react-json-view";
import { Composer, ComposerSubmitBar } from "@/components/Composer.tsx";
import { useCharmMentions } from "@/components/CommandCenter.tsx";
import { formatPromptWithMentions } from "@/utils/format.ts";
import { CharmLink } from "@/components/CharmLink.tsx";
import { useResizableDrawer } from "@/hooks/use-resizeable-drawer.ts";
import { SpecPreview } from "@/components/SpecPreview.tsx";
import {
  SpecPreviewModel,
  useLiveSpecPreview,
} from "@/hooks/use-live-spec-preview.ts";

type Tab = "iterate" | "code" | "data";
type OperationType = "iterate" | "extend";

const variantModels = [
  "anthropic:claude-3-5-sonnet-latest",
  "anthropic:claude-3-7-sonnet-latest",
  "groq:llama-3.3-70b-versatile",
  "google:gemini-2.0-pro",
] as const;

// =================== Context for Shared State ===================
interface CharmOperationContextType {
  input: string;
  setInput: (input: string) => void;
  selectedModel: string;
  setSelectedModel: (model: string) => void;
  operationType: OperationType;
  setOperationType: (type: OperationType) => void;
  showVariants: boolean;
  setShowVariants: (show: boolean) => void;
  showPreview: boolean;
  setShowPreview: (show: boolean) => void;
  loading: boolean;
  setLoading: (loading: boolean) => void;
  variants: Cell<Charm>[];
  setVariants: (updater: (prev: Cell<Charm>[]) => Cell<Charm>[]) => void;
  selectedVariant: Cell<Charm> | null;
  setSelectedVariant: (variant: Cell<Charm> | null) => void;
  expectedVariantCount: number;
  setExpectedVariantCount: (count: number) => void;
  previewSpec: string;
  previewPlan: string;
  isPreviewLoading: boolean;
  previewModel: SpecPreviewModel;
  setPreviewModel: (model: SpecPreviewModel) => void;
  handlePerformOperation: () => void;
  handleCancelVariants: () => void;
  performOperation: (
    charmId: string,
    input: string,
    model: string,
    data: any,
  ) => Promise<Cell<Charm>>;
}

const CharmOperationContext = createContext<CharmOperationContextType | null>(
  null,
);

const useCharmOperationContext = () => {
  const context = useContext(CharmOperationContext);
  if (!context) {
    throw new Error(
      "useCharmOperationContext must be used within a CharmOperationProvider",
    );
  }
  return context;
};

// Hook for tab management
function useTabNavigation() {
  const location = useLocation();
  const navigate = useNavigate();

  const [activeTab, setActiveTab] = useState<Tab>(
    (location.hash.slice(1) as Tab) || "iterate",
  );

  useEffect(() => {
    setActiveTab((location.hash.slice(1) as Tab) || "iterate");
  }, [location.hash]);

  const handleTabChange = useCallback(
    (tab: Tab) => {
      navigate(`${location.pathname}#${tab}`);
      setActiveTab(tab);
    },
    [location.pathname, navigate],
  );

  return { activeTab, handleTabChange };
}

// Hook for managing suggestions
function useSuggestions(charm: Cell<Charm> | null) {
  const [suggestions, setSuggestions] = useState<CharmSuggestion[]>([]);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const suggestionsLoadedRef = useRef(false);

  useEffect(() => {
    if (suggestionsLoadedRef.current || !charm) return;

    const loadSuggestions = async () => {
      setLoadingSuggestions(true);
      const iframeRecipe = getIframeRecipe(charm);
      if (!iframeRecipe) {
        console.error("No iframe recipe found in charm");
        return;
      }
      try {
        const newSuggestions = await generateCharmSuggestions(
          iframeRecipe?.iframe?.spec || "",
          iframeRecipe?.iframe?.src || "",
          JSON.stringify(iframeRecipe?.iframe?.argumentSchema || {}),
        );
        setSuggestions(newSuggestions);
      } catch (error) {
        console.error("Failed to load suggestions:", error);
      } finally {
        setLoadingSuggestions(false);
      }
    };

    suggestionsLoadedRef.current = true;
    loadSuggestions();
  }, [charm]);

  return {
    suggestions,
    loadingSuggestions,
  };
}

// Hook for code editing
function useCodeEditor(
  charm: Cell<Charm> | null,
  iframeRecipe: IFrameRecipe | null,
  showFullCode: boolean = false,
) {
  const { charmManager } = useCharmManager();
  const navigate = useNavigate();
  const [workingSrc, setWorkingSrc] = useState<string | undefined>(undefined);
  const [workingSpec, setWorkingSpec] = useState<string | undefined>(undefined);
  const { replicaName } = useParams<CharmRouteParams>();

  useEffect(() => {
    if (charm && iframeRecipe) {
      if (showFullCode) {
        setWorkingSrc(iframeRecipe.src);
      } else {
        setWorkingSrc(extractUserCode(iframeRecipe.src ?? "") ?? "");
      }
      setWorkingSpec(iframeRecipe.spec);
    }
  }, [iframeRecipe, charm, showFullCode]);

  const hasSourceChanges = showFullCode
    ? workingSrc !== iframeRecipe?.src
    : injectUserCode(workingSrc ?? "") !== iframeRecipe?.src;
  const hasSpecChanges = workingSpec !== iframeRecipe?.spec;
  const hasUnsavedChanges = hasSourceChanges || hasSpecChanges;

  const saveChanges = useCallback(() => {
    const src = showFullCode ? workingSrc : injectUserCode(workingSrc ?? "");
    if (src && iframeRecipe && charm && workingSpec) {
      generateNewRecipeVersion(
        charmManager,
        charm,
        src,
        workingSpec, // Use the edited spec
      ).then((newCharm) => {
        navigate(createPath("charmShow", {
          charmId: charmId(newCharm)!,
          replicaName: replicaName!,
        }));
      });
    }
  }, [
    workingSrc,
    workingSpec,
    iframeRecipe,
    charm,
    navigate,
    replicaName,
    showFullCode,
    charmManager,
  ]);

  return {
    fullSrc: iframeRecipe?.src ?? "",
    workingSrc,
    setWorkingSrc,
    workingSpec,
    setWorkingSpec,
    hasUnsavedChanges,
    saveChanges,
  };
}

export function combineSpecs(existingSpec: string | undefined, input: string) {
  if (!existingSpec) {
    return input;
  }
  return `Current Specification:\n${existingSpec}\n\nUser Request:\n${input}`;
}

// Hook for charm operations (iterate or extend)
function useCharmOperation() {
  const { charmId: paramCharmId, replicaName } = useParams<CharmRouteParams>();
  const { currentFocus: charm } = useCharm(paramCharmId);
  const { charmManager } = useCharmManager();
  const navigate = useNavigate();

  // Shared state
  const [input, setInput] = useState("");
  const [selectedModel, setSelectedModel] = useState(
    "anthropic:claude-3-7-sonnet-latest",
  );
  const [operationType, setOperationType] = useState<OperationType>("iterate");
  const [showVariants, setShowVariants] = useState(false);
  const [showPreview, setShowPreview] = useState(true);
  const [loading, setLoading] = useState(false);
  const [variants, setVariants] = useState<Cell<Charm>[]>([]);
  const [variantModelsMap, setVariantModelsMap] = useState<
    Record<string, string>
  >({});
  const [selectedVariant, setSelectedVariant] = useState<Cell<Charm> | null>(
    null,
  );
  const [expectedVariantCount, setExpectedVariantCount] = useState(0);

  // Preview model state
  const [previewModel, setPreviewModel] = useState<SpecPreviewModel>("think");

  // Get the existing spec from the current charm
  const existingSpec = useMemo(() => {
    if (!charm) return undefined;
    const iframeRecipe = getIframeRecipe(charm);
    return iframeRecipe?.iframe?.spec;
  }, [charm]);

  // Live preview generation with shift key awareness
  const {
    previewSpec,
    previewPlan,
    processedText,
    sources,
    loading: isPreviewLoading,
    model,
  } = useLiveSpecPreview(
    input,
    showPreview,
    250,
    previewModel,
    existingSpec,
  );

  // Function that performs the selected operation (iterate or extend)
  const performOperation = useCallback(
    async (
      charmId: string,
      input: string,
      model: string,
      data: any,
    ) => {
      if (operationType === "iterate") {
        console.log("performOperation for iterate mode:", {
          hasPreview: showPreview,
          hasPreviewSpec: !!previewSpec,
          hasPreviewPlan: !!previewPlan,
        });

        // For iterate mode, we need to combine the input with existing spec if available
        // to create a complete input that includes the context of the existing charm
        let finalInput = input;
        if (existingSpec) {
          finalInput = combineSpecs(existingSpec, input);
        }

        // Now pass finalInput to iterate
        return charmManager.get(charmId, false).then((fetched) => {
          const charm = fetched!;
          return iterate(
            charmManager,
            charm,
            finalInput,
            model,
          );
        });
      } else {
        // For extend mode, also combine input with existing spec if available
        let finalInput = input;
        if (existingSpec) {
          finalInput = combineSpecs(existingSpec, input);
        }

        // Pass combined input for extend as well
        console.log("performOperation for extend mode:", {
          hasPreview: showPreview,
          hasPreviewSpec: !!previewSpec,
          hasPreviewPlan: !!previewPlan,
        });

        return extendCharm(
          charmManager,
          charmId,
          finalInput,
          data,
          showPreview ? previewSpec : undefined,
          showPreview ? previewPlan : undefined,
        );
      }
    },
    [
      operationType,
      charmManager,
      showPreview,
      previewSpec,
      previewPlan,
      existingSpec,
    ],
  );

  // Handle performing the operation
  const handlePerformOperation = useCallback(async () => {
    // Validate that we have required data and input is not empty/whitespace
    if (!input.trim() || !charm || !paramCharmId || !replicaName) return;

    // If preview is still loading, return without doing anything
    if (showPreview && isPreviewLoading) {
      console.log("Preview is still loading, please wait...");
      return;
    }

    // If preview is enabled but we don't have a spec yet, we need to wait for it
    if (showPreview && !previewSpec && !isPreviewLoading) {
      console.log(
        "No preview available but preview is enabled, this shouldn't happen",
      );
      return;
    }

    setLoading(true);

    // If we have a preview with processed text and sources, use that to avoid reprocessing
    // Otherwise, process the mentions now
    const { text, sources: sourcesData } =
      showPreview && processedText && sources
        ? { text: processedText, sources }
        : await formatPromptWithMentions(input, charmManager);

    const handleVariants = async () => {
      setVariants([]);
      setSelectedVariant(charm);

      const gens = variantModels.map(async (model) => {
        const newCharm = await performOperation(
          charmId(charm)!,
          text,
          model,
          sourcesData,
        );
        // Store the variant and keep track of which model was used
        setVariants((prev) => [...prev, newCharm]);
        setLoading(false);
        setVariantModelsMap((prev) => ({
          ...prev,
          [charmId(newCharm) || ""]: model,
        }));
        // Set the first completed variant as selected if none selected
        setSelectedVariant((current) => current === charm ? newCharm : current);
      });

      await Promise.allSettled(gens);
    };

    if (showVariants) {
      setExpectedVariantCount(variantModels.length);
      setVariants([]);
      handleVariants();
    } else {
      try {
        const newCharm = await performOperation(
          charmId(charm)!,
          text,
          selectedModel,
          sourcesData,
        );
        navigate(createPath("charmShow", {
          charmId: charmId(newCharm)!,
          replicaName,
        }));
      } catch (error) {
        console.error(`${operationType} error:`, error);
      } finally {
        setLoading(false);
      }
    }
  }, [
    input,
    charm,
    paramCharmId,
    replicaName,
    showVariants,
    selectedModel,
    performOperation,
    charmManager,
    navigate,
    operationType,
    showPreview,
    processedText,
    sources,
  ]);

  const handleCancelVariants = useCallback(() => {
    setVariants([]);
    setSelectedVariant(null);
    setExpectedVariantCount(0);
  }, []);

  return {
    input,
    setInput,
    selectedModel,
    setSelectedModel,
    operationType,
    setOperationType,
    showVariants,
    setShowVariants,
    showPreview,
    setShowPreview,
    loading,
    setLoading,
    variants,
    setVariants,
    selectedVariant,
    setSelectedVariant,
    expectedVariantCount,
    setExpectedVariantCount,
    previewSpec,
    previewPlan,
    isPreviewLoading,
    previewModel,
    setPreviewModel,
    handlePerformOperation,
    handleCancelVariants,
    performOperation,
  };
}

// =================== Components ===================

// Improved Variants Component with proper previews
const Variants = () => {
  const {
    variants,
    expectedVariantCount,
    selectedVariant,
    setSelectedVariant,
    handleCancelVariants,
  } = useCharmOperationContext();

  const { charmId: paramCharmId, replicaName } = useParams<CharmRouteParams>();

  if (!paramCharmId || !replicaName) {
    throw new Error("Missing charmId or replicaName");
  }

  const { currentFocus: charm } = useCharm(paramCharmId);
  const navigate = useNavigate();

  if (variants.length === 0 && expectedVariantCount === 0) return null;

  return (
    <div className="variants-container border-t-2 border-black pt-4 mb-4">
      <div className="flex justify-between items-center mb-2">
        <h3 className="text-sm font-bold">
          Variants ({variants.length} of {expectedVariantCount})
        </h3>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleCancelVariants}
            className="px-3 py-1 text-sm text-gray-600 hover:text-black border border-gray-300"
          >
            Clear
          </button>

          {selectedVariant && (
            <button
              type="button"
              onClick={() => {
                // If we have a selected variant, make it the main view
                if (selectedVariant) {
                  // Navigate to the selected variant if it's not the original
                  if (selectedVariant !== charm) {
                    const variantId = charmId(selectedVariant);
                    if (variantId) {
                      // Navigate to the main view (without /detail) to close the drawer
                      navigate(
                        createPath("charmShow", {
                          charmId: variantId,
                          replicaName,
                        }),
                      );
                    }
                  } else {
                    // If it's the original charm, just close the drawer by navigating to the main view
                    navigate(
                      createPath("charmShow", {
                        charmId: paramCharmId,
                        replicaName,
                      }),
                    );
                  }
                }
              }}
              className="px-3 py-1 text-sm bg-black text-white hover:bg-gray-800"
            >
              Select
            </button>
          )}
        </div>
      </div>
      <div className="variants-scroll flex gap-4 overflow-x-auto pb-4">
        {charm && (
          <div
            onClick={() => setSelectedVariant(charm)}
            className={`variant-item min-w-48 h-32 border-2 cursor-pointer flex-shrink-0 ${
              selectedVariant === charm ? "border-blue-500" : "border-black"
            }`}
          >
            <div className="h-full flex flex-col overflow-hidden">
              <div className="bg-gray-100 text-xs font-bold p-1 border-b border-gray-300">
                Original
              </div>
              <div
                className="flex-grow overflow-hidden relative"
                style={{ width: "100%", height: "100%" }}
              >
                <div
                  className="absolute inset-0 pointer-events-none"
                  style={{
                    transform: "scale(0.3)",
                    transformOrigin: "top left",
                    width: "333%",
                    height: "333%",
                  }}
                >
                  <CharmRenderer className="w-full h-full" charm={charm} />
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Display variants in the order of the variantModels array */}
        {variantModels.map((model, modelIdx) => {
          // Simply index into the variants array for now since we don't have the map
          const variantForModel = variants[modelIdx];

          return (
            <div
              key={modelIdx}
              onClick={() =>
                variantForModel && setSelectedVariant(variantForModel)}
              className={`variant-item min-w-48 h-32 border-2 cursor-pointer flex-shrink-0 ${
                variantForModel && selectedVariant === variantForModel
                  ? "border-blue-500"
                  : variantForModel
                  ? "border-black"
                  : "border-dashed border-gray-300"
              }`}
            >
              <div className="h-full flex flex-col overflow-hidden">
                <div className="bg-gray-100 text-xs font-bold p-1 border-b border-gray-300">
                  {(model.split(":")[1] || "Model").substring(0, 24)}
                </div>
                <div
                  className="flex-grow overflow-hidden relative"
                  style={{ width: "100%", height: "100%" }}
                >
                  {variantForModel
                    ? (
                      <div
                        className="absolute inset-0 pointer-events-none"
                        style={{
                          transform: "scale(0.3)",
                          transformOrigin: "top left",
                          width: "333%",
                          height: "333%",
                        }}
                      >
                        <CharmRenderer
                          className="w-full h-full"
                          charm={variantForModel}
                        />
                      </div>
                    )
                    : (
                      <div className="w-full h-full flex items-center justify-center">
                        <DitheredCube
                          animationSpeed={2}
                          width={24}
                          height={24}
                          animate
                          cameraZoom={12}
                        />
                      </div>
                    )}
                </div>
              </div>
            </div>
          );
        })}

        {/* Remove the additional loading placeholders section that was here */}
      </div>
    </div>
  );
};

// Suggestions Component
const Suggestions = () => {
  const { charmId: paramCharmId } = useParams<CharmRouteParams>();
  const { currentFocus: charm } = useCharm(paramCharmId);
  const { suggestions, loadingSuggestions } = useSuggestions(charm);
  const {
    setInput,
    setShowVariants,
    handlePerformOperation,
    setOperationType,
    selectedModel,
    setLoading,
    setVariants,
    setSelectedVariant,
    setExpectedVariantCount,
    operationType,
    performOperation,
    showVariants,
  } = useCharmOperationContext();

  const navigate = useNavigate();
  const { replicaName } = useParams<CharmRouteParams>();

  const { charmManager } = useCharmManager();

  // Store selected suggestion in state to use in effects
  const [selectedSuggestion, setSelectedSuggestion] = useState<
    CharmSuggestion | null
  >(null);

  // React to suggestion selection
  const handleSuggestion = useCallback((suggestion: CharmSuggestion) => {
    // Set the operation type based on suggestion type
    if (suggestion.type.toLowerCase().includes("extend")) {
      setOperationType("extend");
    } else {
      setOperationType("iterate");
    }

    // Update the input state
    setInput(suggestion.prompt);

    // Store the suggestion for the effect to handle
    setSelectedSuggestion(suggestion);
    setLoading(true);
  }, [setOperationType, setInput, setLoading]);

  // Handle the actual operation when selectedSuggestion changes
  useEffect(() => {
    if (!selectedSuggestion || !charm || !paramCharmId || !replicaName) {
      return;
    }

    const runOperation = async () => {
      try {
        if (showVariants) {
          // Variant workflow
          setExpectedVariantCount(variantModels.length);
          setVariants(() => []);

          // Use Promise.all to collect all results
          const promises = variantModels.map(async (model) => {
            try {
              return await performOperation(
                charmId(charm)!,
                selectedSuggestion.prompt,
                model,
                {}, // No mentions in suggestion text
              );
            } catch (error) {
              console.error(`Error generating variant with ${model}:`, error);
              return null;
            }
          });

          // Wait for all operations to complete
          const results = await Promise.allSettled(promises);

          // Update variants with successful results
          results.forEach((result, index) => {
            if (result.status === "fulfilled" && result.value) {
              const successValue = result.value;
              setVariants((existingPrev) => {
                const newVariants = [...existingPrev, successValue];

                // Set the first successful variant as selected
                if (existingPrev.length === 0) {
                  setSelectedVariant(successValue);
                }

                return newVariants;
              });
            }
          });
        } else {
          // Single model workflow
          const newCharm = await performOperation(
            charmId(charm)!,
            selectedSuggestion.prompt,
            selectedModel,
            {}, // No mentions in suggestion text
          );

          navigate(createPath("charmShow", {
            charmId: charmId(newCharm)!,
            replicaName,
          }));
        }
      } catch (error) {
        console.error(`Operation error:`, error);
      } finally {
        setLoading(false);
        // Clear the selected suggestion so we don't rerun this effect
        setSelectedSuggestion(null);
      }
    };

    runOperation();
  }, [
    selectedSuggestion,
    charm,
    paramCharmId,
    replicaName,
    showVariants,
    selectedModel,
    performOperation,
    navigate,
    setVariants,
    setSelectedVariant,
    setExpectedVariantCount,
    setLoading,
  ]);

  return (
    <div className="suggestions-container mb-4">
      <h3 className="text-sm font-bold mb-2">Suggestions</h3>
      {loadingSuggestions
        ? (
          <div className="flex items-center justify-center p-4">
            <DitheredCube
              animationSpeed={2}
              width={24}
              height={24}
              animate
              cameraZoom={12}
            />
          </div>
        )
        : (
          <div className="flex overflow-x-auto pb-2 gap-3">
            {suggestions.map((suggestion, index) => (
              <button
                type="button"
                key={index}
                onClick={() => handleSuggestion(suggestion)}
                className="p-2 text-left text-sm border border-gray-300 hover:border-black hover:bg-gray-50 shadow-sm transition-all duration-100 ease-in-out cursor-pointer flex-shrink-0 min-w-40 max-w-96"
              >
                <span className="font-medium text-xs uppercase text-gray-500 block">
                  {suggestion.type}
                </span>
                <p className="text-xs">{suggestion.prompt}</p>
              </button>
            ))}
          </div>
        )}
    </div>
  );
};

// Operation Tab Component (formerly IterateTab)
const OperationTab = () => {
  const {
    input,
    setInput,
    selectedModel,
    setSelectedModel,
    operationType,
    setOperationType,
    showVariants,
    setShowVariants,
    showPreview,
    setShowPreview,
    loading,
    handlePerformOperation,
    previewSpec,
    previewPlan,
    isPreviewLoading,
    previewModel,
    setPreviewModel,
  } = useCharmOperationContext();

  const mentions = useCharmMentions();
  const { charmManager } = useCharmManager();

  return (
    <div className="flex flex-col p-4">
      <div className="flex flex-col gap-3">
        <ToggleButton
          options={[
            { value: "iterate", label: "Iterate" },
            { value: "extend", label: "Extend" },
          ]}
          value={operationType}
          onChange={(value) => setOperationType(value as OperationType)}
          size="large"
          className="mb-2"
        />

        <div className="flex flex-col gap-2">
          <div className="border border-gray-300">
            <Composer
              placeholder={operationType === "iterate"
                ? "Tweak your charm"
                : "Add new features to your charm"}
              readOnly={false}
              mentions={mentions}
              value={input}
              onValueChange={setInput}
              onSubmit={handlePerformOperation}
              disabled={loading || !input.trim()}
              style={{ width: "100%", height: "96px" }}
            />
          </div>

          <ComposerSubmitBar
            loading={loading}
            operation={operationType === "iterate" ? "Iterate" : "Extend"}
            onSubmit={handlePerformOperation}
            disabled={!input.trim()}
          >
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <CheckboxToggle
                  id="preview"
                  label="Live Preview"
                  checked={showPreview}
                  onChange={setShowPreview}
                />

                <CheckboxToggle
                  id="variants"
                  label="Variants"
                  checked={showVariants}
                  onChange={setShowVariants}
                />
              </div>

              <div className="flex items-center gap-2">
                {showPreview && (
                  <ToggleButton
                    options={[
                      { value: "fast", label: "Fast" },
                      { value: "think", label: "Smart" },
                    ]}
                    value={previewModel}
                    onChange={(value) =>
                      setPreviewModel(value as SpecPreviewModel)}
                    size="small"
                  />
                )}
              </div>
            </div>

            <select
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              className="p-1 border-2 border-black bg-white text-xs"
            >
              <option value="anthropic:claude-3-7-sonnet-latest">
                Claude 3.7 ✨
              </option>
              <option value="anthropic:claude-3-5-sonnet-latest">
                Claude 3.5 ✨
              </option>
              <option value="groq:qwen-qwq-32b">Qwen QwQ 32B 🧠</option>
              <option value="groq:llama-3.3-70b-versatile">Llama 3.3 🔥</option>
              <option value="openai:o3-mini-low-latest">o3-mini-low</option>
              <option value="openai:o3-mini-medium-latest">
                o3-mini-medium
              </option>
              <option value="openai:o3-mini-high-latest">o3-mini-high</option>
              <option value="google:gemini-2.0-pro">Gemini 2.0</option>
              <option value="perplexity:sonar-pro">Sonar Pro 🌐</option>
            </select>
          </ComposerSubmitBar>
        </div>
      </div>

      {/* Content Container with single scrollbar */}
      <div className="flex-grow overflow-auto mt-3 -mx-4 px-4">
        <SpecPreview
          spec={previewSpec}
          plan={previewPlan}
          loading={isPreviewLoading}
          visible={showPreview}
        />
        <Variants />
        <Suggestions />
      </div>
    </div>
  );
};

// Code Tab Component
const CodeTab = () => {
  const { charmId: paramCharmId } = useParams<CharmRouteParams>();
  const { currentFocus: charm, iframeRecipe } = useCharm(paramCharmId);
  const [showFullCode, setShowFullCode] = useState(false);
  const [activeEditor, setActiveEditor] = useState<"code" | "spec">("code");

  const {
    fullSrc,
    workingSrc,
    setWorkingSrc,
    workingSpec,
    setWorkingSpec,
    hasUnsavedChanges,
    saveChanges,
  } = useCodeEditor(
    charm,
    iframeRecipe,
    showFullCode,
  );
  const templateVersion = extractVersionTag(fullSrc);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (hasUnsavedChanges) {
          saveChanges();
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [hasUnsavedChanges, saveChanges]);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="flex items-center gap-4 p-4">
        <CommonLabel size="small">
          Template Version: {templateVersion ?? "Missing"}
        </CommonLabel>
        <div className="flex items-center gap-4">
          <CommonCheckbox
            id="fullCode"
            label="Show Full Template"
            checked={showFullCode}
            onChange={setShowFullCode}
            size="small"
          />

          <ToggleButton
            options={[
              { value: "code", label: "Code" },
              { value: "spec", label: "Specification" },
            ]}
            value={activeEditor}
            onChange={(value) => setActiveEditor(value as "code" | "spec")}
            size="small"
          />
        </div>
        {hasUnsavedChanges && (
          <button
            type="button"
            onClick={saveChanges}
            className="px-2 py-1 text-xs bg-black text-white border-2 border-black disabled:opacity-50"
          >
            Save Changes
          </button>
        )}
      </div>

      <div className="px-4 flex-grow flex flex-col overflow-hidden">
        {activeEditor === "code" && (
          <div className="flex-grow overflow-hidden border-black border-2 h-full">
            <CodeMirror
              value={workingSrc || ""}
              theme="dark"
              extensions={[javascript()]}
              onChange={setWorkingSrc}
              basicSetup={{
                lineNumbers: true,
                foldGutter: true,
                indentOnInput: true,
              }}
              style={{ height: "100%", overflow: "auto" }}
            />
          </div>
        )}

        {activeEditor === "spec" && (
          <div className="flex-grow overflow-hidden border border-black h-full">
            <textarea
              value={workingSpec || ""}
              onChange={(e) => setWorkingSpec(e.target.value)}
              className="w-full h-full p-4 font-mono text-sm resize-none"
              style={{ height: "100%", overflow: "auto" }}
            />
          </div>
        )}
      </div>
    </div>
  );
};

// Data Tab Component
const DataTab = () => {
  const { charmId: paramCharmId } = useParams<CharmRouteParams>();
  const { currentFocus: charm, iframeRecipe } = useCharm(paramCharmId);
  const { charmManager } = useCharmManager();
  const { readingFrom, readBy, loading: loadingReferences } =
    useCharmReferences(charm);
  const [isArgumentExpanded, setIsArgumentExpanded] = useState(false);
  const [isResultExpanded, setIsResultExpanded] = useState(false);
  const [isArgumentSchemaExpanded, setIsArgumentSchemaExpanded] = useState(
    false,
  );
  const [isResultSchemaExpanded, setIsResultSchemaExpanded] = useState(false);
  const [isSpecExpanded, setIsSpecExpanded] = useState(false);
  const [isLineageExpanded, setIsLineageExpanded] = useState(false);
  const [isReferencesExpanded, setIsReferencesExpanded] = useState(false);

  if (!charm) return null;

  const lineage = charmManager.getLineage(charm);

  const Lineage = (item: typeof lineage[number]) => (
    <div
      key={`lineage-${charmId(item.charm) || ""}`}
    >
      <CharmLink
        charm={item.charm}
        showHash
      />&nbsp;
      <CommonLabel size="small">
        {item.relation} at {new Date(item.timestamp).toLocaleString()}
      </CommonLabel>
      <div className="ml-4">
        {charmManager.getLineage(item.charm).map((item) => Lineage(item))}
      </div>
    </div>
  );

  return (
    <div className="h-full overflow-auto p-4">
      {charm.getSourceCell() && (
        <div className="mb-4">
          <button
            type="button"
            onClick={() => setIsArgumentExpanded(!isArgumentExpanded)}
            className="w-full flex items-center justify-between p-2 bg-gray-100 border border-gray-300 mb-2"
          >
            <span className="text-md font-semibold">Argument</span>
            <span>{isArgumentExpanded ? "▼" : "▶"}</span>
          </button>

          {isArgumentExpanded && (
            <div className="border border-gray-300 rounded bg-gray-50 p-2">
              {/* @ts-expect-error JsonView is imported as any */}
              <JsonView
                value={translateCellsAndStreamsToPlainJSON(
                  charmManager.getArgument(charm)?.get(),
                ) ?? {}}
                style={{
                  background: "transparent",
                  fontSize: "0.875rem",
                }}
              />
            </div>
          )}
        </div>
      )}

      <div className="mb-4">
        <button
          type="button"
          onClick={() => setIsResultExpanded(!isResultExpanded)}
          className="w-full flex items-center justify-between p-2 bg-gray-100 border border-gray-300 mb-2"
        >
          <span className="text-md font-semibold">Result</span>
          <span>{isResultExpanded ? "▼" : "▶"}</span>
        </button>

        {isResultExpanded && (
          <div className="border border-gray-300 rounded bg-gray-50 p-2">
            {/* @ts-expect-error JsonView is imported as any */}
            <JsonView
              value={translateCellsAndStreamsToPlainJSON(charm.get()) ?? {}}
              style={{
                background: "transparent",
                fontSize: "0.875rem",
              }}
            />
          </div>
        )}
      </div>

      {iframeRecipe && (
        <>
          {/* Added Specification section */}
          <div className="mb-4">
            <button
              type="button"
              onClick={() => setIsSpecExpanded(!isSpecExpanded)}
              className="w-full flex items-center justify-between p-2 bg-gray-100 border border-gray-300 mb-2"
            >
              <span className="text-md font-semibold">Specification</span>
              <span>{isSpecExpanded ? "▼" : "▶"}</span>
            </button>

            {isSpecExpanded && (
              <div className="border border-gray-300 rounded p-2 bg-gray-50">
                <div className="whitespace-pre-wrap font-mono text-sm p-2">
                  {iframeRecipe.spec || "No specification available"}
                </div>
              </div>
            )}
          </div>

          <div className="mb-4">
            <button
              type="button"
              onClick={() =>
                setIsArgumentSchemaExpanded(!isArgumentSchemaExpanded)}
              className="w-full flex items-center justify-between p-2 bg-gray-100 border border-gray-300 mb-2"
            >
              <span className="text-md font-semibold">Argument Schema</span>
              <span>{isArgumentSchemaExpanded ? "▼" : "▶"}</span>
            </button>

            {isArgumentSchemaExpanded && (
              <div className="border border-gray-300 rounded p-2 bg-gray-50">
                {/* @ts-expect-error JsonView is imported as any */}
                <JsonView
                  value={iframeRecipe.argumentSchema || {}}
                  style={{
                    background: "transparent",
                    fontSize: "0.875rem",
                  }}
                />
              </div>
            )}
          </div>

          <div className="mb-4">
            <button
              type="button"
              onClick={() => setIsResultSchemaExpanded(!isResultSchemaExpanded)}
              className="w-full flex items-center justify-between p-2 bg-gray-100 border border-gray-300 mb-2"
            >
              <span className="text-md font-semibold">Result Schema</span>
              <span>{isResultSchemaExpanded ? "▼" : "▶"}</span>
            </button>

            {isResultSchemaExpanded && (
              <div className="border border-gray-300 rounded p-2 bg-gray-50">
                {/* @ts-expect-error JsonView is imported as any */}
                <JsonView
                  value={iframeRecipe.resultSchema || {}}
                  style={{
                    background: "transparent",
                    fontSize: "0.875rem",
                  }}
                />
              </div>
            )}
          </div>
        </>
      )}

      {/* Combined References section */}
      <div className="mt-4">
        <button
          type="button"
          onClick={() => setIsReferencesExpanded(!isReferencesExpanded)}
          className="w-full flex items-center justify-between p-2 bg-gray-100 border border-gray-300 mb-2"
        >
          <span className="text-md font-semibold">Charm References</span>
          <span>{isReferencesExpanded ? "▼" : "▶"}</span>
        </button>

        {isReferencesExpanded && (
          <div className="border border-gray-300 rounded p-2 bg-gray-50">
            {loadingReferences
              ? <div className="text-sm p-2">Loading references...</div>
              : (
                <div className="flex items-center justify-between gap-4">
                  {/* Inputs section */}
                  <div className="flex-1">
                    <h4 className="text-sm font-semibold mb-2">Reading From</h4>
                    {readingFrom.length > 0
                      ? (
                        <div className="flex flex-wrap gap-1">
                          {readingFrom.map((
                            charm: Cell<Charm>,
                            index: number,
                          ) => (
                            <div
                              key={`read-from-${charmId(charm)}`}
                              className="bg-blue-100 border border-blue-300 px-2 py-1"
                            >
                              <CharmLink
                                charm={charm}
                                showHash
                                className="text-sm"
                              />
                            </div>
                          ))}
                        </div>
                      )
                      : (
                        <div className="text-sm text-gray-500 italic">
                          This charm doesn't read from any other charms
                        </div>
                      )}
                  </div>

                  {/* Arrow divider */}
                  <div className="text-2xl font-bold text-gray-500 px-2">→</div>

                  {/* Outputs section */}
                  <div className="flex-1">
                    <h4 className="text-sm font-semibold mb-2">Read By</h4>
                    {readBy.length > 0
                      ? (
                        <div className="flex flex-wrap gap-1">
                          {readBy.map((charm: Cell<Charm>, index: number) => (
                            <div
                              key={`read-by-${charmId(charm)}`}
                              className="bg-green-100 border border-green-300 px-2 py-1"
                            >
                              <CharmLink
                                charm={charm}
                                showHash
                                className="text-sm"
                              />
                            </div>
                          ))}
                        </div>
                      )
                      : (
                        <div className="text-sm text-gray-500 italic">
                          No charms are reading from this charm
                        </div>
                      )}
                  </div>
                </div>
              )}
          </div>
        )}
      </div>

      {lineage.length > 0 && (
        <div className="mt-4">
          <button
            type="button"
            onClick={() => setIsLineageExpanded(!isLineageExpanded)}
            className="w-full flex items-center justify-between p-2 bg-gray-100 border border-gray-300 mb-2"
          >
            <span className="text-md font-semibold">Lineage</span>
            <span>{isLineageExpanded ? "▼" : "▶"}</span>
          </button>

          {isLineageExpanded && (
            <div className="border border-gray-300 rounded p-2 bg-gray-50">
              {lineage.map((item) => Lineage(item))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// Bottom Sheet Component
const BottomSheet = ({
  children,
}: {
  children: (activeTab: Tab, isResizing: boolean) => React.ReactNode;
}) => {
  const {
    drawerHeight,
    isResizing,
    handleResizeStart,
    handleTouchResizeStart,
  } = useResizableDrawer({ initialHeight: 585, resizeDirection: "down" });
  const { activeTab, handleTabChange } = useTabNavigation();

  return (
    <div
      className="bottom-sheet border-t-2 border-black bg-white shadow-lg flex flex-col"
      style={{ height: `${drawerHeight}px` }}
    >
      {/* Resize Handle */}
      <div
        className="resize-handle h-6 w-full cursor-ns-resize flex items-center justify-center border-b border-gray-200 flex-shrink-0"
        onMouseDown={handleResizeStart}
        onTouchStart={handleTouchResizeStart}
      >
        <div className="w-16 h-1 bg-gray-300 rounded-full"></div>
      </div>

      {/* Tab Navigation */}
      <div className="tabs flex gap-0 border-b border-gray-200 flex-shrink-0">
        <button
          type="button"
          onClick={() => handleTabChange("iterate")}
          className={`px-4 py-2 flex-1 text-center ${
            activeTab === "iterate"
              ? "bg-gray-100 font-bold border-b-2 border-black"
              : ""
          }`}
        >
          Operation
        </button>
        <button
          type="button"
          onClick={() => handleTabChange("code")}
          className={`px-4 py-2 flex-1 text-center ${
            activeTab === "code"
              ? "bg-gray-100 font-bold border-b-2 border-black"
              : ""
          }`}
        >
          Edit Code
        </button>
        <button
          type="button"
          onClick={() => handleTabChange("data")}
          className={`px-4 py-2 flex-1 text-center ${
            activeTab === "data"
              ? "bg-gray-100 font-bold border-b-2 border-black"
              : ""
          }`}
        >
          View Data
        </button>
      </div>

      {/* Content Area - This is the scrollable container */}
      <div className="flex-1 overflow-auto">
        {children(activeTab, isResizing)}
      </div>
    </div>
  );
};

// Main CharmDetailView Component
function CharmDetailView() {
  const { charmId: paramCharmId, replicaName } = useParams<CharmRouteParams>();

  if (!paramCharmId || !replicaName) {
    throw new Error("Missing navigation params");
  }

  const { currentFocus: charm } = useCharm(paramCharmId);
  const operationContextValue = useCharmOperation();

  if (!charm) {
    return (
      <div className="max-w-xl mx-auto">
        <LoadingSpinner visible />
      </div>
    );
  }

  return (
    <CharmOperationContext.Provider value={operationContextValue}>
      <div className="detail-view h-full flex flex-col">
        {/* Main Content Area */}
        <div className="flex-grow overflow-hidden relative">
          {operationContextValue.loading && (
            <div
              className="absolute inset-0 backdrop-blur-sm bg-white/60 flex flex-col items-center justify-center z-10 transition-opacity duration-300 ease-in-out"
              style={{ opacity: operationContextValue.loading ? 1 : 0 }}
            >
              <div className="text-lg font-bold">thinking</div>
              <LoadingSpinner
                blendMode="exclusion"
                height={1024}
                width={1024}
                visible
                cameraZoom={128}
              />
            </div>
          )}

          <CharmRenderer
            key="main"
            className="w-full h-full"
            charm={operationContextValue.selectedVariant || charm}
          />
        </div>

        {/* Bottom Sheet */}
        <BottomSheet>
          {(activeTab, isResizing) => (
            <>
              {/* Apply pointer-events-none when resizing */}
              <div className={isResizing ? "pointer-events-none" : ""}>
                {activeTab === "iterate" && <OperationTab />}
                {activeTab === "code" && <CodeTab />}
                {activeTab === "data" && <DataTab />}
              </div>
            </>
          )}
        </BottomSheet>
      </div>
    </CharmOperationContext.Provider>
  );
}

function translateCellsAndStreamsToPlainJSON(
  data: any,
  partial: Set<any> = new Set(),
  complete: Map<any, JSON | string> = new Map<any, JSON | string>(),
): JSON | string {
  // If we already have the serialized form of this object, just use that
  const existing = complete.get(data);
  if (existing !== undefined) {
    return existing;
  }
  if (partial.has(data)) {
    return "// circular reference";
  }
  partial.add(data);

  let result: any;
  if (isStream(data)) {
    result = { "// stream": data.schema ?? "no schema" };
  } else if (isCell(data)) {
    result = {
      "// cell": translateCellsAndStreamsToPlainJSON(
        data.get(),
        partial,
        complete,
      ),
    };
  } else if (Array.isArray(data)) {
    result = data.map((value) =>
      translateCellsAndStreamsToPlainJSON(value, partial, complete)
    );
  } else if (isObj(data)) {
    result = Object.fromEntries(
      Object.entries(data).map(([key, value]) => [
        key,
        translateCellsAndStreamsToPlainJSON(value, partial, complete),
      ]),
    );
  } else {
    result = data;
  }
  partial.delete(data);
  complete.set(data, result);
  return result;
}

export default CharmDetailView;
