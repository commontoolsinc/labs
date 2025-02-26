import { saveNewRecipeVersion, IFrameRecipe, Charm, getIframeRecipe } from "@commontools/charm";
import React, {
  useEffect,
  useState,
  useCallback,
  useRef,
  memo,
  createContext,
  useContext,
} from "react";
import { useParams, useLocation, useNavigate } from "react-router-dom";
import { useCharmManager } from "@/contexts/CharmManagerContext.tsx";
import { LoadingSpinner } from "@/components/Loader.tsx";
import { useCharm } from "@/hooks/use-charm.ts";
import CodeMirror from "@uiw/react-codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { CharmRenderer } from "@/components/CharmRunner.tsx";
import { iterateCharm } from "@/utils/charm-operations.ts";
import { charmId } from "@/utils/charms.ts";
import { DitheredCube } from "@/components/DitherCube.tsx";
import {
  generateCharmSuggestions,
  type CharmSuggestion,
} from "@/utils/prompt-library/charm-suggestions.ts";
import { Cell } from "@commontools/runner";

type Tab = "iterate" | "code" | "data";

const variantModels = [
  "anthropic:claude-3-5-sonnet-latest",
  "anthropic:claude-3-7-sonnet-latest",
  "groq:llama-3.3-70b-versatile",
  "google:gemini-2.0-pro",
] as const;

// Memoized CharmRenderer to prevent unnecessary re-renders
const MemoizedCharmRenderer = memo(CharmRenderer);

// =================== Context for Shared State ===================
interface IterationContextType {
  iterationInput: string;
  setIterationInput: (input: string) => void;
  selectedModel: string;
  setSelectedModel: (model: string) => void;
  showVariants: boolean;
  setShowVariants: (show: boolean) => void;
  loading: boolean;
  variants: Cell<Charm>[];
  selectedVariant: Cell<Charm> | null;
  setSelectedVariant: (variant: Cell<Charm> | null) => void;
  expectedVariantCount: number;
  handleIterate: () => void;
  handleCancelVariants: () => void;
}

const IterationContext = createContext<IterationContextType | null>(null);

const useIterationContext = () => {
  const context = useContext(IterationContext);
  if (!context) {
    throw new Error("useIterationContext must be used within an IterationProvider");
  }
  return context;
};

// =================== Custom Hooks ===================

// Hook for managing bottom sheet functionality
function useBottomSheet(initialHeight = 420) {
  const [sheetHeight, setSheetHeight] = useState<number>(initialHeight);
  const [isResizing, setIsResizing] = useState(false);
  const resizeStartY = useRef<number | null>(null);
  const startHeight = useRef<number | null>(null);

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      resizeStartY.current = e.clientY;
      startHeight.current = sheetHeight;
      setIsResizing(true);

      // Add a layer over the entire document to capture events
      const overlay = document.createElement("div");
      overlay.id = "resize-overlay";
      overlay.style.position = "fixed";
      overlay.style.top = "0";
      overlay.style.left = "0";
      overlay.style.width = "100%";
      overlay.style.height = "100%";
      overlay.style.zIndex = "9999";
      overlay.style.cursor = "ns-resize";
      document.body.appendChild(overlay);

      const handleResizeMove = (e: MouseEvent) => {
        if (resizeStartY.current !== null && startHeight.current !== null) {
          const diff = resizeStartY.current - e.clientY;
          const newHeight = Math.max(
            150,
            Math.min(window.innerHeight * 0.8, startHeight.current + diff),
          );
          setSheetHeight(newHeight);
        }
      };

      const handleResizeEnd = () => {
        resizeStartY.current = null;
        startHeight.current = null;
        setIsResizing(false);

        // Remove overlay
        const overlay = document.getElementById("resize-overlay");
        if (overlay) {
          document.body.removeChild(overlay);
        }

        document.removeEventListener("mousemove", handleResizeMove);
        document.removeEventListener("mouseup", handleResizeEnd);
      };

      document.addEventListener("mousemove", handleResizeMove);
      document.addEventListener("mouseup", handleResizeEnd);
    },
    [sheetHeight],
  );

  const handleTouchResizeStart = useCallback(
    (e: React.TouchEvent) => {
      e.preventDefault();
      if (e.touches.length === 1) {
        resizeStartY.current = e.touches[0].clientY;
        startHeight.current = sheetHeight;
        setIsResizing(true);
      }

      const handleTouchMove = (e: TouchEvent) => {
        if (
          resizeStartY.current !== null &&
          startHeight.current !== null &&
          e.touches.length === 1
        ) {
          const diff = resizeStartY.current - e.touches[0].clientY;
          const newHeight = Math.max(
            150,
            Math.min(window.innerHeight * 0.8, startHeight.current + diff),
          );
          setSheetHeight(newHeight);
        }
      };

      const handleTouchEnd = () => {
        resizeStartY.current = null;
        startHeight.current = null;
        setIsResizing(false);
        document.removeEventListener("touchmove", handleTouchMove);
        document.removeEventListener("touchend", handleTouchEnd);
      };

      document.addEventListener("touchmove", handleTouchMove, { passive: false });
      document.addEventListener("touchend", handleTouchEnd);
    },
    [sheetHeight],
  );

  return {
    sheetHeight,
    isResizing,
    handleResizeStart,
    handleTouchResizeStart,
  };
}

// Hook for tab management
function useTabNavigation() {
  const location = useLocation();
  const navigate = useNavigate();

  const [activeTab, setActiveTab] = useState<Tab>((location.hash.slice(1) as Tab) || "iterate");

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
function useCodeEditor(charm: Cell<Charm> | null, iframeRecipe: IFrameRecipe | null) {
  const { charmManager } = useCharmManager();
  const [workingSrc, setWorkingSrc] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (charm && iframeRecipe) {
      setWorkingSrc(iframeRecipe.src);
    }
  }, [iframeRecipe, charm]);

  const hasUnsavedChanges = workingSrc !== iframeRecipe?.src;

  const saveChanges = useCallback(() => {
    if (workingSrc && iframeRecipe && charm) {
      saveNewRecipeVersion(charmManager, charm, workingSrc, iframeRecipe.spec);
    }
  }, [workingSrc, iframeRecipe, charm, charmManager]);

  return {
    workingSrc,
    setWorkingSrc,
    hasUnsavedChanges,
    saveChanges,
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
  } = useIterationContext();

  const { charmId: paramCharmId } = useParams();
  const { currentFocus: charm, iframeRecipe } = useCharm(paramCharmId);

  if (variants.length === 0 && expectedVariantCount === 0) return null;

  return (
    <div className="variants-container border-t-2 border-black pt-4 mb-4">
      <div className="flex justify-between items-center mb-2">
        <h3 className="text-sm font-bold">
          Variants ({variants.length} of {expectedVariantCount})
        </h3>
        <button onClick={handleCancelVariants} className="text-xs text-gray-600 hover:text-black">
          Clear
        </button>
      </div>
      <div className="variants-scroll flex gap-4 overflow-x-auto pb-4">
        {charm && (
          <div
            onClick={() => setSelectedVariant(charm)}
            className={`variant-item min-w-36 h-24 border-2 cursor-pointer flex-shrink-0 ${
              selectedVariant === charm ? "border-blue-500" : "border-black"
            }`}
          >
            <div className="h-full flex flex-col overflow-hidden">
              <div className="bg-gray-100 text-xs font-bold p-1 border-b border-gray-300">
                Original
              </div>
              <div
                className="flex-grow overflow-clip relative"
                style={{ transform: "scale(0.3)", transformOrigin: "top left" }}
              >
                <div className="absolute inset-0 w-[500%] h-[500%] pointer-events-none">
                  <CharmRenderer className="w-full h-full" charm={charm} />
                </div>
              </div>
            </div>
          </div>
        )}

        {variants.map((variant, idx) => (
          <div
            key={idx}
            onClick={() => setSelectedVariant(variant)}
            className={`variant-item min-w-36 h-24 border-2 cursor-pointer flex-shrink-0 ${
              selectedVariant === variant ? "border-blue-500" : "border-black"
            }`}
          >
            <div className="h-full flex flex-col overflow-hidden">
              <div className="bg-gray-100 text-xs font-bold p-1 border-b border-gray-300">
                {variantModels[idx]?.split(":")[0] || "Model"}
              </div>
              <div
                className="flex-grow overflow-hidden relative"
                style={{ transform: "scale(0.3)", transformOrigin: "top left" }}
              >
                <div className="absolute inset-0 w-[333%] h-[333%] pointer-events-none">
                  <CharmRenderer className="w-full h-full" charm={variant} />
                </div>
              </div>
            </div>
          </div>
        ))}

        {/* Loading placeholders */}
        {Array.from({ length: expectedVariantCount - variants.length }).map((_, idx) => (
          <div
            key={`loading-${idx}`}
            className="variant-item min-w-36 h-24 border-2 border-dashed border-gray-300 flex items-center justify-center flex-shrink-0"
          >
            <DitheredCube
              animationSpeed={2}
              width={24}
              height={24}
              animate={true}
              cameraZoom={12}
            />
          </div>
        ))}
      </div>
    </div>
  );
};

// Suggestions Component
const Suggestions = () => {
  const { charmId: paramCharmId } = useParams();
  const { currentFocus: charm } = useCharm(paramCharmId);
  const { suggestions, loadingSuggestions } = useSuggestions(charm);
  const { setIterationInput, setShowVariants, handleIterate } = useIterationContext();

  const handleSuggestion = (suggestion: CharmSuggestion) => {
    setIterationInput(suggestion.prompt);
    setShowVariants(true);
    // Use a micro-delay to ensure state updates before iteration
    setTimeout(() => handleIterate(), 0);
  };

  return (
    <div className="suggestions-container mb-4">
      <h3 className="text-sm font-bold mb-2">Suggestions</h3>
      {loadingSuggestions ? (
        <div className="flex items-center justify-center p-4">
          <DitheredCube animationSpeed={2} width={24} height={24} animate={true} cameraZoom={12} />
        </div>
      ) : (
        <div className="flex overflow-x-auto pb-2 gap-3">
          {suggestions.map((suggestion, index) => (
            <button
              key={index}
              onClick={() => handleSuggestion(suggestion)}
              className="p-2 text-left text-sm border border-gray-300 hover:border-black hover:bg-gray-50 shadow-sm transition-all duration-100 ease-in-out cursor-pointer flex-shrink-0 min-w-40 max-w-56"
            >
              <span className="font-medium text-xs uppercase text-gray-500 block">
                {suggestion.type}
              </span>
              <p className="text-xs line-clamp-2">{suggestion.prompt}</p>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

// Iterate Tab Component
const IterateTab = () => {
  const {
    iterationInput,
    setIterationInput,
    selectedModel,
    setSelectedModel,
    showVariants,
    setShowVariants,
    loading,
    handleIterate,
  } = useIterationContext();

  return (
    <div className="flex flex-col p-4">
      <div className="flex flex-col gap-3">
        <textarea
          placeholder="Tweak your charm"
          value={iterationInput}
          onChange={(e) => setIterationInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              handleIterate();
            }
          }}
          className="w-full h-24 p-2 border-2 border-black resize-none"
        />

        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center">
            <input
              type="checkbox"
              id="variants"
              checked={showVariants}
              onChange={(e) => setShowVariants(e.target.checked)}
              className="border-2 border-black mr-2"
            />
            <label htmlFor="variants" className="text-sm font-medium">
              Variants
            </label>
          </div>

          <select
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value)}
            className="p-1 border-2 border-black bg-white text-xs"
          >
            <option value="anthropic:claude-3-7-sonnet-latest">Claude 3.7 ✨</option>
            <option value="anthropic:claude-3-5-sonnet-latest">Claude 3.5 ✨</option>
            <option value="groq:llama-3.3-70b-versatile">Llama 3.3 🔥</option>
            <option value="openai:o3-mini-low-latest">o3-mini-low</option>
            <option value="openai:o3-mini-medium-latest">o3-mini-medium</option>
            <option value="openai:o3-mini-high-latest">o3-mini-high</option>
            <option value="google:gemini-2.0-pro">Gemini 2.0</option>
            <option value="perplexity:sonar-pro">Sonar Pro 🌐</option>
          </select>

          <button
            onClick={handleIterate}
            disabled={loading || !iterationInput}
            className="px-4 py-2 border-2 text-sm border-white bg-black text-white flex items-center gap-2 disabled:opacity-50"
          >
            {loading ? (
              <>
                <DitheredCube
                  animationSpeed={2}
                  width={16}
                  height={16}
                  animate={true}
                  cameraZoom={12}
                />
                <span>Iterating...</span>
              </>
            ) : (
              <span className="text-xs">
                Iterate{" "}
                <span className="hidden md:inline text-gray-400 font-bold italic">(⌘ + enter)</span>
              </span>
            )}
          </button>
        </div>
      </div>

      {/* Content Container with single scrollbar */}
      <div className="flex-grow overflow-auto mt-3 -mx-4 px-4">
        <Variants />
        <Suggestions />
      </div>
    </div>
  );
};

// Code Tab Component
const CodeTab = () => {
  const { charmId: paramCharmId } = useParams();
  const { currentFocus: charm, iframeRecipe } = useCharm(paramCharmId);
  const { workingSrc, setWorkingSrc, hasUnsavedChanges, saveChanges } = useCodeEditor(
    charm,
    iframeRecipe,
  );

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="p-4 flex-grow flex flex-col overflow-hidden">
        <div className="flex-grow overflow-hidden border border-black h-full">
          <CodeMirror
            value={workingSrc}
            theme="dark"
            extensions={[javascript()]}
            onChange={setWorkingSrc}
            basicSetup={{
              lineNumbers: false,
              foldGutter: false,
              indentOnInput: true,
            }}
            style={{ height: "100%", overflow: "auto" }}
          />
        </div>
        <div className="mt-4 flex justify-end">
          <button
            onClick={saveChanges}
            disabled={!hasUnsavedChanges}
            className="px-4 py-2 bg-black text-white border-2 border-black disabled:opacity-50"
          >
            {hasUnsavedChanges ? "Save Changes" : "Saved"}
          </button>
        </div>
      </div>
    </div>
  );
};

// Data Tab Component
const DataTab = () => {
  const { charmId: paramCharmId } = useParams();
  const { currentFocus: charm } = useCharm(paramCharmId);

  if (!charm) return null;

  return (
    <div className="h-full overflow-auto p-4">
      {charm.sourceCell && (
        <div className="mb-4">
          <h3 className="text-md font-semibold mb-1">Argument</h3>
          <pre className="bg-gray-50 p-2 rounded text-sm overflow-auto max-h-36 border border-gray-200">
            {JSON.stringify(charm.sourceCell.get().argument, null, 2)}
          </pre>
        </div>
      )}
      <h2 className="text-lg font-semibold mb-2">Result</h2>
      <div className="mb-4">
        <pre className="bg-gray-50 p-2 rounded text-sm overflow-auto max-h-64 border border-gray-200">
          {JSON.stringify(charm.get(), null, 2)}
        </pre>
      </div>
    </div>
  );
};

// Bottom Sheet Component
const BottomSheet = ({ children }) => {
  const { sheetHeight, isResizing, handleResizeStart, handleTouchResizeStart } = useBottomSheet();
  const { activeTab, handleTabChange } = useTabNavigation();

  return (
    <div
      className="bottom-sheet border-t-2 border-black bg-white shadow-lg flex flex-col overflow-y-auto"
      style={{ height: `${sheetHeight}px` }}
    >
      {/* Resize Handle */}
      <div
        className="resize-handle h-6 w-full cursor-ns-resize flex items-center justify-center border-b border-gray-200"
        onMouseDown={handleResizeStart}
        onTouchStart={handleTouchResizeStart}
      >
        <div className="w-16 h-1 bg-gray-300 rounded-full"></div>
      </div>

      {/* Tab Navigation */}
      <div className="tabs flex gap-0 border-b border-gray-200">
        <button
          onClick={() => handleTabChange("iterate")}
          className={`px-4 py-2 flex-1 text-center ${
            activeTab === "iterate" ? "bg-gray-100 font-bold border-b-2 border-black" : ""
          }`}
        >
          Iteration
        </button>
        <button
          onClick={() => handleTabChange("code")}
          className={`px-4 py-2 flex-1 text-center ${
            activeTab === "code" ? "bg-gray-100 font-bold border-b-2 border-black" : ""
          }`}
        >
          Edit Code
        </button>
        <button
          onClick={() => handleTabChange("data")}
          className={`px-4 py-2 flex-1 text-center ${
            activeTab === "data" ? "bg-gray-100 font-bold border-b-2 border-black" : ""
          }`}
        >
          View Data
        </button>
      </div>

      {/* Tab Content */}
      <div className="tab-content flex-grow overflow-hidden">{children(activeTab, isResizing)}</div>
    </div>
  );
};

// Main CharmDetailView Component
function CharmDetailView() {
  const { charmId: paramCharmId, replicaName } = useParams();
  const { currentFocus: charm, iframeRecipe } = useCharm(paramCharmId);
  const { charmManager } = useCharmManager();
  const navigate = useNavigate();

  // Iteration state
  const [iterationInput, setIterationInput] = useState("");
  const [selectedModel, setSelectedModel] = useState("anthropic:claude-3-7-sonnet-latest");
  const [showVariants, setShowVariants] = useState(false);
  const [loading, setLoading] = useState(false);
  const [variants, setVariants] = useState<Cell<Charm>[]>([]);
  const [selectedVariant, setSelectedVariant] = useState<Cell<Charm> | null>(null);
  const [expectedVariantCount, setExpectedVariantCount] = useState(0);

  // Handle iteration
  const handleIterate = useCallback(async () => {
    if (!iterationInput || !charm) return;
    setLoading(true);

    const handleVariants = async () => {
      setVariants([]);
      setSelectedVariant(charm);

      try {
        const variantPromises = variantModels.map((model) =>
          iterateCharm(charmManager, charmId(charm)!, replicaName!, iterationInput, false, model),
        );

        // Instead of waiting for all promises, handle them as they complete
        let first = true;
        variantPromises.forEach(async (promise) => {
          try {
            const path = await promise;
            if (path) {
              const id = path.split("/").pop()!;
              const newCharm = await charmManager.get(id);
              if (newCharm) {
                setVariants((prev) => [...prev, newCharm]);
                // Set the first completed variant as selected if none selected
                if (first) {
                  setSelectedVariant(newCharm);
                  first = false;
                }
              }
            }
          } catch (error) {
            console.error("Variant generation error:", error);
          }
        });
      } catch (error) {
        console.error("Variants error:", error);
      } finally {
        setLoading(false);
      }
    };

    if (showVariants) {
      setExpectedVariantCount(variantModels.length);
      setVariants([]);
      handleVariants();
    } else {
      try {
        const newPath = await iterateCharm(
          charmManager,
          charmId(charm)!,
          replicaName!,
          iterationInput,
          false,
          selectedModel,
        );
        if (newPath) {
          navigate(`${newPath}/detail#iterate`);
        }
      } catch (error) {
        console.error("Iteration error:", error);
      } finally {
        setLoading(false);
      }
    }
  }, [showVariants, iterationInput, selectedModel, charmManager, charm, replicaName, navigate]);

  const handleCancelVariants = useCallback(() => {
    setVariants([]);
    setSelectedVariant(null);
    setExpectedVariantCount(0);
  }, []);

  // Iteration context value
  const iterationContextValue = {
    iterationInput,
    setIterationInput,
    selectedModel,
    setSelectedModel,
    showVariants,
    setShowVariants,
    loading,
    variants,
    selectedVariant,
    setSelectedVariant,
    expectedVariantCount,
    handleIterate,
    handleCancelVariants,
  };

  if (!charm) {
    return (
      <div className="max-w-xl mx-auto">
        <LoadingSpinner visible={true} />
      </div>
    );
  }

  return (
    <IterationContext.Provider value={iterationContextValue}>
      <div className="detail-view h-full flex flex-col">
        {/* Main Content Area */}
        <div className="flex-grow overflow-hidden relative">
          {loading && (
            <div
              className="absolute inset-0 backdrop-blur-sm bg-white/60 flex flex-col items-center justify-center z-10 transition-opacity duration-300 ease-in-out"
              style={{ opacity: loading ? 1 : 0 }}
            >
              <div className="text-lg font-bold">thinking</div>
              <LoadingSpinner
                blendMode="exclusion"
                height={1024}
                width={1024}
                visible={true}
                cameraZoom={128}
              />
            </div>
          )}

          <MemoizedCharmRenderer
            key="main"
            className="w-full h-full"
            charm={selectedVariant || charm}
          />
        </div>

        {/* Bottom Sheet */}
        <BottomSheet>
          {(activeTab, isResizing) => (
            <>
              {/* Apply pointer-events-none when resizing */}
              <div className={isResizing ? "pointer-events-none" : ""}>
                {activeTab === "iterate" && <IterateTab />}
                {activeTab === "code" && <CodeTab />}
                {activeTab === "data" && <DataTab />}
              </div>
            </>
          )}
        </BottomSheet>
      </div>
    </IterationContext.Provider>
  );
}

export default CharmDetailView;
