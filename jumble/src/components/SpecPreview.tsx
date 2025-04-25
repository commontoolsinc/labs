import React, { useEffect, useRef, useState } from "react";
import { DitheredCube } from "./DitherCube.tsx";
import { useSpring } from "@react-spring/web";
import type { WorkflowForm, WorkflowType } from "@commontools/charm";
import { SpellRecord, WORKFLOWS } from "../../../charm/src/workflow.ts";
import CodeMirror from "@uiw/react-codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { EditorView } from "@codemirror/view";
import { useActivityContext } from "@/contexts/ActivityContext.tsx";
import CharmLink from "@/components/CharmLink.tsx";

interface SpecPreviewProps {
  form: Partial<WorkflowForm>;
  loading: boolean;
  classificationLoading?: boolean; // Separate loading state for classification
  planLoading?: boolean; // Separate loading state for plan generation
  visible: boolean;
  floating?: boolean;
  onWorkflowChange?: (workflow: WorkflowType) => void;
  onSelectedCastChange?: (charmId: string, spellId: string) => void;
}

// Accordion component for collapsible sections
interface AccordionProps {
  title: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
  badge?: React.ReactNode;
}

function Accordion(
  { title, children, defaultOpen = false, badge }: AccordionProps,
) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  // Force a rerender when children content changes to fix animation issues
  const childrenContentKey = React.useMemo(() => {
    return typeof children === "string" ? children : JSON.stringify(
      React.Children.toArray(children).map((child) =>
        React.isValidElement(child) ? child.key : child
      ),
    );
  }, [children]);

  const contentStyles = useSpring({
    from: {
      opacity: 0,
      height: 0,
      transform: "translateY(-10px)",
      overflow: "hidden",
      visibility: "hidden",
    },
    to: {
      opacity: isOpen ? 1 : 0,
      height: isOpen ? "auto" : 0,
      transform: isOpen ? "translateY(0)" : "translateY(-10px)",
      overflow: "hidden",
      visibility: isOpen ? "visible" : "hidden",
    },
    // Reset animation when content changes to avoid stale animations
    reset: true,
    // Only animate when closing, immediate when opening to avoid height calculation issues
    immediate: !isOpen,
    config: {
      tension: 300,
      friction: 26,
      clamp: true,
    },
  });

  // Compact accordion with minimal styling
  return (
    <div className="border border-gray-200 rounded-md mb-1 overflow-hidden">
      <button
        className="w-full px-1.5 py-0.5 bg-gray-50 text-left flex items-center justify-between text-xs font-medium"
        onClick={() => setIsOpen(!isOpen)}
        type="button"
        aria-expanded={isOpen}
      >
        <div className="flex items-center">
          <span
            className="mr-1 transition-transform text-[8px]"
            style={{
              transform: isOpen ? "rotate(90deg)" : "rotate(0deg)",
            }}
          >
            ▶
          </span>
          {title}
        </div>
        {badge}
      </button>
      {/* Simplified rendering that doesn't use react-spring for height */}
      {isOpen && (
        <div
          className="p-1"
          style={{
            opacity: isOpen ? 1 : 0,
            transition: "opacity 200ms ease-in-out",
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

// JobStatusIndicator component to display job status based on generationId
const JobStatusIndicator = ({ generationId }: { generationId?: string }) => {
  const { jobs } = useActivityContext();
  if (!generationId || !jobs[generationId]) {
    return null;
  }

  const job = jobs[generationId];

  return (
    <div className="text-xs ml-2 flex items-center">
      {job.state === "running" && (
        <>
          <div className="w-2 h-2 mr-1 bg-blue-500 rounded-full animate-pulse">
          </div>
          <span className="text-blue-600">{job.status}</span>
        </>
      )}
      {job.state === "completed" && (
        <span className="text-green-600">{job.status}</span>
      )}
      {job.state === "failed" && (
        <span className="text-red-600">{job.status}</span>
      )}
    </div>
  );
};

function getSpellPreviewName(spell: SpellRecord) {
  return spell.recipe.result.$NAME || "Unnamed Spell";
}

export function SpecPreview({
  form,
  loading,
  visible,
  floating = false,
  onWorkflowChange,
  onSelectedCastChange,
}: SpecPreviewProps) {
  const hasContent = (loading || form.classification || form.plan ||
    form.searchResults) &&
    visible;

  // Get the current generation ID from the form metadata
  const generationId = form.meta?.generationId;

  // Local state for workflow type to make the select behave properly
  const [localWorkflowType, setLocalWorkflowType] = useState<
    WorkflowType | undefined
  >(form.classification?.workflowType);

  // Sync local state with form data when it changes
  useEffect(() => {
    if (form.classification?.workflowType !== localWorkflowType) {
      setLocalWorkflowType(form.classification?.workflowType);
    }
  }, [form.classification?.workflowType]);

  // Create a reference to measure content height
  const contentRef = useRef<HTMLDivElement>(null);

  // Calculate different heights for different states (more compact)
  const loaderHeight = 60; // Height for just the loader (smaller cube + padding)
  const maxContentHeight = floating
    ? 240
    : typeof window !== "undefined"
    ? Math.min(240, globalThis.innerHeight * 0.5)
    : 240;

  // Directly set the height style without animation
  const containerHeight = React.useMemo(() => {
    // Never show content if not visible or no actual content to display
    if (!visible || !hasContent) {
      return 0;
    }

    // If we're loading and no progress, show minimal height
    if (loading && !form.classification) {
      return loaderHeight;
    }

    // If we have a complete plan, show full height
    if (form.plan) {
      return maxContentHeight;
    }

    // If we only have classification, show half height
    if (form.classification) {
      const height = maxContentHeight / 3 * 2;
      return height;
    }

    // Default height for other cases
    return maxContentHeight;
  }, [
    visible,
    hasContent,
    loading,
    form.classification,
    form.plan,
    loaderHeight,
    maxContentHeight,
  ]);

  // Create a key that changes when progress state changes to force re-renders
  const progressKey = `${Boolean(form.classification)}-${Boolean(form.plan)}`;

  // Create springs for animation with proper types
  const springs = useSpring({
    opacity: visible ? 1 : 0,
    y: visible && hasContent ? 0 : -20,
    config: {
      tension: 280,
      friction: 24,
    },
    // Don't reset on height changes to allow smooth transitions
    reset: false,
  });

  // Text reveal animation - updates based on progress state not just loading
  const textSpring = useSpring({
    opacity: (visible && (!loading || form.classification)) ? 1 : 0,
    y: (visible && (!loading || form.classification)) ? 0 : 10,
    config: {
      tension: 300,
      friction: 20,
    },
    // Reset animation when progress changes
    reset: true,
    // Add key to force update when progress changes
    key: progressKey,
  });

  const containerClasses = floating
    ? "preview-container border border-2 fixed z-50 bg-gray-200"
    : "preview-container border-t-2 border-black pt-2 bg-gray-200 ";

  // Detect mobile viewport with responsive handling
  const [isMobile, setIsMobile] = useState(
    typeof globalThis !== "undefined" && globalThis.innerWidth <= 768,
  );

  // Update mobile state on window resize
  React.useEffect(() => {
    const handleResize = () => {
      setIsMobile(globalThis.innerWidth <= 768);
    };

    if (typeof globalThis !== "undefined") {
      globalThis.addEventListener("resize", handleResize);
      return () => globalThis.removeEventListener("resize", handleResize);
    }
  }, []);

  // Format the confidence as a percentage
  const confidencePercentage = Math.round(
    (form.classification?.confidence ?? 0) * 100,
  );

  // Create a SpellList component to display available spells as radio button-like options
  const SpellList = () => {
    if (!form.searchResults?.castable) return null;

    return (
      <div className="p-2 space-y-4">
        <div className="text-sm font-bold mb-2">AVAILABLE SPELLS</div>
        {Object.entries(form.searchResults.castable).map(
          ([charmId, spellsArray]) => {
            // Ensure spellsArray is an array
            const spells = Array.isArray(spellsArray) ? spellsArray : [];
            return (
              <div key={charmId} className="space-y-2">
                <div className="text-xs font-semibold text-gray-700">
                  {charmId}
                </div>
                {spells.length === 0
                  ? (
                    <div className="text-xs text-gray-500 italic">
                      No spells available
                    </div>
                  )
                  : (
                    <div className="grid grid-cols-1 gap-px">
                      {spells.map((
                        result,
                        index,
                      ) => {
                        // Check if this spell is currently selected
                        const isSelected =
                          form.spellToCast?.charmId === charmId &&
                          form.spellToCast?.spellId === result.id;

                        return (
                          <div
                            key={`${charmId}-${index}`}
                            className={`border border-gray-300 p-2 cursor-pointer ${
                              isSelected
                                ? "bg-gray-100"
                                : "bg-white hover:bg-gray-50"
                            }`}
                            onClick={() =>
                              onSelectedCastChange?.(charmId, result.id)}
                          >
                            <div className="flex items-center">
                              <div className="mr-2 flex-shrink-0 w-4 h-4 border border-gray-400 rounded-full flex items-center justify-center">
                                {isSelected && (
                                  <div className="w-2 h-2 bg-gray-700 rounded-full">
                                  </div>
                                )}
                              </div>
                              <div className="font-medium text-sm">
                                {getSpellPreviewName(result.spell)}
                              </div>
                            </div>
                            <div className="text-xs text-gray-600 mt-1 ml-6">
                              {getSpellPreviewName(result.spell)}
                            </div>
                            {result.spell.recipeName && (
                              <div className="text-xs text-gray-500 mt-1 ml-6 line-clamp-2">
                                {result.spell.recipeName}
                              </div>
                            )}
                            {result.spell.blobCreatedAt && (
                              <div className="flex items-center text-xs text-gray-500 mt-2 ml-6">
                                <span className="mr-1">Created:</span>
                                {new Date(result.spell.blobCreatedAt)
                                  .toLocaleDateString()}
                                {result.spell.blobAuthor && (
                                  <span className="ml-2">
                                    by {result.spell.blobAuthor}
                                  </span>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
              </div>
            );
          },
        )}
      </div>
    );
  };

  if (
    !form.plan &&
    !form.classification &&
    !form.searchResults &&
    !loading
  ) {
    return null;
  }

  // Create static styles
  const containerStyle = {
    width: floating ? (isMobile ? "100vw" : "calc(100% + 2rem)") : "100%",
    left: floating ? (isMobile ? "50%" : "-1rem") : undefined,
    maxWidth: floating
      ? (isMobile ? "100vw" : undefined)
      : (isMobile ? "100%" : undefined),
    bottom: floating ? "calc(100% + 0.5rem)" : undefined,
    overflowY: "auto" as const,
    height: containerHeight,
    transition: "height 500ms ease-in-out",
    display: !visible || !hasContent ? "none" : "block",
  };

  return (
    <div
      className={containerClasses}
      style={{
        ...containerStyle,
        opacity: springs.opacity.get(),
        transform: `translateY(${springs.y.get()}%)`,
        visibility: springs.opacity.get() === 0 ? "hidden" : "visible",
        pointerEvents: springs.opacity.get() === 0 ? "none" : "auto",
      }}
    >
      <div className="p-2 relative" ref={contentRef}>
        <div
          className="space-y-2"
          style={{
            position: "relative",
            minHeight: loading ? "32px" : "auto",
            transition: "min-height 0.3s ease",
          }}
        >
          {!visible ? null : (
            <div className="space-y-2 w-full">
              {/* Display SpellList when form.results is present */}
              {form.searchResults
                ? <SpellList />
                : loading
                ? (
                  <div className="flex items-center justify-center w-full py-2">
                    <DitheredCube
                      animationSpeed={2}
                      width={32}
                      height={32}
                      animate
                      cameraZoom={12}
                    />
                    <JobStatusIndicator generationId={generationId} />
                  </div>
                )
                : (
                  <div className="space-y-2 w-full">
                    {/* Spec as full-width section */}
                    <div className="w-full space-y-1">
                      {/* Spec Section */}
                      <div className="p-1">
                        {/* Show spec when available, otherwise loading */}
                        {form.plan?.description
                          ? (
                            <div className="font-mono text-xs whitespace-pre-wrap overflow-y-auto">
                              {form.plan?.description}
                            </div>
                          )
                          : (
                            <div className="flex items-center py-1">
                              <DitheredCube
                                animationSpeed={2}
                                width={20}
                                height={20}
                                animate
                                cameraZoom={12}
                              />
                              <span className="ml-1 text-xs">
                                Thinking...
                              </span>
                              <JobStatusIndicator
                                generationId={generationId}
                              />
                            </div>
                          )}
                      </div>
                    </div>

                    <div>
                      {form.plan?.charms && form.plan?.charms.length > 0 && (
                        <>
                          <div className="text-sm font-bold mb-2">
                            FROM YOUR SPACE
                          </div>
                          <div className="flex flex-row flex-wrap gap-2">
                            {form.plan.charms.map((result) => (
                              <div
                                key={result.name}
                                className="text-sm px-3 py-1 bg-gray-100"
                              >
                                <CharmLink charm={result.charm} />
                              </div>
                            ))}
                          </div>
                        </>
                      )}
                    </div>

                    <div>
                      {form.plan?.features
                        ? (
                          <div className="font-mono text-xs whitespace-pre-wrap">
                            {form.plan?.features.map((step, index) => (
                              <div
                                key={index}
                                className="py-0.5 border-t first:border-t-0 border-gray-100"
                              >
                                {step}
                              </div>
                            ))}
                          </div>
                        )
                        : (
                          <div className="text-xs text-gray-500 italic">
                            Plan will appear here...
                          </div>
                        )}
                    </div>
                  </div>
                )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
