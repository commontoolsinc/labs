import { saveNewRecipeVersion, IFrameRecipe, Charm, getIframeRecipe } from "@commontools/charm";
import React, { useEffect, useState, useCallback, useRef } from "react";
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
import { VariantTray } from "@/components/VariantTray.tsx";
import {
  generateCharmSuggestions,
  type CharmSuggestion,
} from "@/utils/prompt-library/charm-suggestions.ts";
import { Cell } from "@commontools/runner";
type Tab = "iterate" | "code" | "data";

interface IterationTabProps {
  charm: Cell<Charm>;
}

const variantModels = [
  "anthropic:claude-3-5-sonnet-latest",
  "anthropic:claude-3-7-sonnet-latest",
  "groq:llama-3.3-70b-versatile",
  "google:gemini-2.0-pro",
] as const;

const IterationTab: React.FC<IterationTabProps> = ({ charm }) => {
  const { replicaName } = useParams();
  const navigate = useNavigate();
  const { charmManager } = useCharmManager();

  const [iterationInput, setIterationInput] = useState("");
  const [selectedModel, setSelectedModel] = useState("anthropic:claude-3-7-sonnet-latest");
  const [showVariants, setShowVariants] = useState(false);
  const [loading, setLoading] = useState(false);
  const [variants, setVariants] = useState<Cell<Charm>[]>([]);
  const [selectedVariant, setSelectedVariant] = useState<Cell<Charm> | null>(null);
  const [suggestions, setSuggestions] = useState<CharmSuggestion[]>([]);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [expectedVariantCount, setExpectedVariantCount] = useState(0);
  const [pendingSuggestion, setPendingSuggestion] = useState<CharmSuggestion | null>(null);

  const handleIterate = useCallback(async () => {
    const handleVariants = async () => {
      setLoading(true);
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
      if (!iterationInput) return;
      setLoading(true);
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

  const suggestionsLoadedRef = useRef(false);

  useEffect(() => {
    console.log("Loading suggestions for charm:", charmId(charm));
    if (suggestionsLoadedRef.current) return;

    const loadSuggestions = async () => {
      setLoadingSuggestions(true);
      const iframeRecipe = getIframeRecipe(charm);
      if (!iframeRecipe) {
        console.error("No iframe recipe found in charm, what should we do?");
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

  useEffect(() => {
    if (pendingSuggestion) {
      handleIterate();
      setPendingSuggestion(null);
    }
  }, [pendingSuggestion, handleIterate]);

  const handleSuggestion = (suggestion: CharmSuggestion) => {
    setIterationInput(suggestion.prompt);
    setShowVariants(true);
    setPendingSuggestion(suggestion);
  };

  const handleCancelVariants = () => {
    setVariants([]);
    setSelectedVariant(null);
    setExpectedVariantCount(0);
  };

  return (
    <div className="flex h-full">
      {/* Left Sidebar */}
      <div className="w-80 border-r-2 border-black bg-gray-50 flex flex-col gap-4 pr-8">
        <div className="bg-white border-2 border-black p-4 shadow-[2px_2px_0px_0px_rgba(0,0,0,0.5)]">
          <h2 className="text-sm font-bold mb-4">Iterate</h2>
          <div className="flex flex-col gap-4">
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
              className="w-full h-32 p-2 border-2 border-black resize-none"
            />
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="variants"
                checked={showVariants}
                onChange={(e) => setShowVariants(e.target.checked)}
                className="border-2 border-black"
              />
              <label htmlFor="variants" className="text-sm font-medium">
                Variants
              </label>
            </div>
            <div className="flex flex-col gap-2">
              <label className="text-sm font-bold">Model</label>
              <select
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                className="w-full p-2 border-2 border-black bg-white text-xs"
              >
                <option value="anthropic:claude-3-7-sonnet-latest">
                  Anthropic Claude 3.7 Sonnet ✨
                </option>
                <option value="anthropic:claude-3-5-sonnet-latest">
                  Anthropic Claude 3.5 Sonnet ✨
                </option>
                <option value="groq:llama-3.3-70b-versatile">Groq Llama 3.3 70B 🔥</option>
                <option value="openai:o3-mini-low-latest">OpenAI o3-mini-low</option>
                <option value="openai:o3-mini-medium-latest">OpenAI o3-mini-medium</option>
                <option value="openai:o3-mini-high-latest">OpenAI o3-mini-high</option>
                <option value="google:gemini-2.0-pro">Google Gemini 2.0 Pro</option>
                <option value="google:gemini-2.0-flash">Google Gemini 2.0 Flash</option>
                <option value="google:gemini-2.0-flash-thinking">
                  Google Gemini 2.0 Flash Thinking
                </option>
                <option value="perplexity:sonar-pro">Perplexity Sonar Pro 🌐</option>
              </select>
            </div>
            <button
              onClick={handleIterate}
              disabled={loading}
              className="px-4 py-2 border-2 text-sm border-white bg-black text-white flex items-center gap-2"
            >
              {loading && (
                <DitheredCube
                  animationSpeed={2}
                  width={24}
                  height={24}
                  animate={true}
                  cameraZoom={12}
                />
              )}
              {loading ? (
                "Iterating..."
              ) : (
                <span className="text-xs flex justify-between w-full">
                  Iterate <span className="text-gray-400 font-bold italic">(⌘ + enter)</span>
                </span>
              )}
            </button>
          </div>
        </div>

        {/* New suggestions box */}
        <div className="bg-white border-2 border-black p-4 shadow-[2px_2px_0px_0px_rgba(0,0,0,0.5)]">
          <h2 className="text-sm font-bold mb-4">Suggestions</h2>
          {loadingSuggestions ? (
            <div className="flex items-center justify-center p-4">
              <DitheredCube
                animationSpeed={2}
                width={24}
                height={24}
                animate={true}
                cameraZoom={12}
              />
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {suggestions.map((suggestion, index) => (
                <button
                  key={index}
                  onClick={() => handleSuggestion(suggestion)}
                  className="p-2 text-left text-sm border-2 border-black hover:-translate-y-[2px] hover:shadow-[4px_4px_0px_0px_rgba(0,0,0,0.5)] shadow-[1px_1px_0px_0px_rgba(0,0,0,0.3)] transition-all duration-100 ease-in-out cursor-pointer"
                >
                  <span className="font-medium text-xs uppercase text-gray-500">
                    {suggestion.type}
                  </span>
                  <p className="text-xs">{suggestion.prompt}</p>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      {/* Main Content Area */}
      <div className="flex-1 h-full overflow-y-auto p-4 relative">
        {loading && (
          <div className="absolute inset-0 bg-white/80 flex flex-col items-center justify-center">
            <div className="text-lg font-bold">thinking</div>
            <LoadingSpinner height={1024} width={1024} visible={true} cameraZoom={400} />
          </div>
        )}

        <CharmRenderer className="w-full h-full" charm={selectedVariant || charm} />

        {(variants.length > 0 || expectedVariantCount > 0) && (
          <VariantTray
            variants={variants}
            selectedVariant={selectedVariant}
            onSelectVariant={setSelectedVariant}
            variantModels={variantModels}
            totalExpectedVariants={expectedVariantCount}
            onCancel={handleCancelVariants}
            originalCharm={charm}
          />
        )}
      </div>
    </div>
  );
};

interface CodeTabProps {
  charm: Cell<Charm>;
  iframeRecipe: IFrameRecipe | null;
}

const CodeTab: React.FC<CodeTabProps> = ({ charm, iframeRecipe }) => {
  const [workingSrc, setWorkingSrc] = useState<string | undefined>(undefined);
  const { charmManager } = useCharmManager();

  const saveChanges = () => {
    if (workingSrc && iframeRecipe && charm) {
      saveNewRecipeVersion(charmManager, charm, workingSrc, iframeRecipe.spec);
    }
  };

  const hasUnsavedChanges = workingSrc !== iframeRecipe?.src;

  // Set workingSrc once the iframeRecipe is available
  useEffect(() => {
    if (charm && iframeRecipe) {
      setWorkingSrc(iframeRecipe.src);
    }
  }, [iframeRecipe, charm]);

  return (
    <div className="editor-tab">
      <CodeMirror
        value={workingSrc}
        theme="dark"
        extensions={[javascript()]}
        onChange={(value) => setWorkingSrc(value)}
        basicSetup={{
          lineNumbers: false,
          foldGutter: false,
          indentOnInput: true,
        }}
      />
      <div className="mt-4">
        <button
          onClick={saveChanges}
          disabled={!hasUnsavedChanges}
          className="px-4 py-2 bg-green-500 text-white rounded disabled:opacity-50"
        >
          {hasUnsavedChanges ? "Save Changes" : "Saved"}
        </button>
      </div>
    </div>
  );
};

interface DataTabProps {
  charm: Charm;
}

const DataTab: React.FC<DataTabProps> = ({ charm }) => {
  return (
    <div className="view-tab">
      {charm.sourceCell && (
        <div className="mb-4">
          <h3 className="text-md font-semibold mb-1">Argument</h3>
          <pre className="bg-gray-50 p-2 rounded text-sm overflow-auto">
            {JSON.stringify(charm.sourceCell.get().argument, null, 2)}
          </pre>
        </div>
      )}
      <h2 className="text-lg font-semibold mb-2">Result</h2>
      <div className="mb-4">
        <pre className="bg-gray-50 p-2 rounded text-sm overflow-auto">
          {JSON.stringify(charm.get(), null, 2)}
        </pre>
      </div>
    </div>
  );
};

// FIXME(jake): Eventually, we might move these tab views into their own components and use URL routes for deep linking.

function CharmEditView() {
  const { charmId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();

  // Set initial tab from hash (default to "code")
  const activeTab = location.hash.slice(1) as Tab;

  const { currentFocus: charm, iframeRecipe } = useCharm(charmId);

  if (!charm) {
    return (
      <div className="max-w-xl mx-auto">
        <LoadingSpinner visible={true} />
      </div>
    );
  }

  return (
    <div className="detail-view h-full p-4">
      {/* Tab Navigation */}
      <div className="tabs mb-4 flex gap-2">
        <button
          onClick={() => navigate(`${location.pathname}#iterate`)}
          className={`px-4 py-2 rounded ${
            activeTab === "iterate" ? "bg-gray-200 font-bold" : "bg-gray-100"
          }`}
        >
          Iteration
        </button>
        <button
          onClick={() => navigate(`${location.pathname}#code`)}
          className={`px-4 py-2 rounded ${
            activeTab === "code" ? "bg-gray-200 font-bold" : "bg-gray-100"
          }`}
        >
          Edit Code
        </button>
        <button
          onClick={() => navigate(`${location.pathname}#data`)}
          className={`px-4 py-2 rounded ${
            activeTab === "data" ? "bg-gray-200 font-bold" : "bg-gray-100"
          }`}
        >
          View Data
        </button>
      </div>

      {(() => {
        switch (activeTab) {
          case "code":
            return <CodeTab charm={charm} iframeRecipe={iframeRecipe} />;
          case "data":
            return <DataTab charm={charm} />;
          case "iterate":
          default:
            return <IterationTab charm={charm} />;
        }
      })()}
    </div>
  );
}

export default CharmEditView;
