import React, { useRef, useState } from "react";
import { DitheredCube } from "./DitherCube.tsx";
import { animated, useSpring, useTransition } from "@react-spring/web";
import { ToggleButton } from "./common/CommonToggle.tsx";
import type {
  ExecutionPlan,
  WorkflowForm,
  WorkflowType,
} from "@commontools/charm";
import { JSONSchema } from "@commontools/builder";

interface SpecPreviewProps {
  form: Partial<WorkflowForm>;
  loading: boolean;
  classificationLoading?: boolean; // Separate loading state for classification
  planLoading?: boolean; // Separate loading state for plan generation
  visible: boolean;
  floating?: boolean;
  progress?: { classification: boolean; plan: boolean; spec: boolean }; // Progress tracking for staged rendering
  onWorkflowChange?: (workflow: WorkflowType) => void;
  onFormChange?: (formData: Partial<ExecutionPlan>) => void; // Callback to expose form data
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

  // Force update the accordion when content changes
  React.useEffect(() => {
    // Intentionally empty, just to trigger a re-render
    console.log("Accordion content changed:", childrenContentKey);
  }, [childrenContentKey]);

  // Compact accordion with minimal styling
  return (
    <div className="border border-gray-200 rounded-md mb-1 overflow-hidden">
      <button
        className="w-full px-1.5 py-0.5 bg-gray-50 text-left flex items-center justify-between text-[10px] font-medium"
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
          className="p-1 bg-white"
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

export function SpecPreview({
  form,
  loading,
  classificationLoading = false,
  planLoading = false,
  visible,
  floating = false,
  progress = { classification: false, plan: false, spec: false },
  onWorkflowChange,
  onFormChange,
}: SpecPreviewProps) {
  const hasContent = (loading || form.plan?.steps || form.plan?.spec) &&
    visible;

  // Create a reference to measure content height
  const contentRef = useRef<HTMLDivElement>(null);

  // Calculate different heights for different states (more compact)
  const loaderHeight = 60; // Height for just the loader (smaller cube + padding)
  const maxContentHeight = floating
    ? 280
    : typeof window !== "undefined"
    ? Math.min(260, globalThis.innerHeight * 0.45)
    : 280;

  // Force a re-render when any of these change
  React.useEffect(() => {
    // This effect just forces a re-render
    console.log("Content/Progress changed:", {
      hasContent,
      form,
      progress,
    });

    // Force a re-render when plan data arrives
    // if (plan && progress.plan) {
    //   const forceUpdate = setTimeout(() => {
    //     console.log("Force updating component due to plan data");
    //   }, 50);
    //   return () => clearTimeout(forceUpdate);
    // }
  }, [hasContent, form, progress]);

  // Directly set the height style without animation
  const containerHeight = React.useMemo(() => {
    // Never show content if not visible or no actual content to display
    if (!visible || !hasContent) {
      return 0;
    }

    // If we're loading and no progress, show minimal height
    if (loading && !progress.classification) {
      return loaderHeight;
    }

    // If we have any content, show full height
    if (progress.classification || form.plan?.spec) {
      return maxContentHeight;
    }

    // Default to zero height for empty state
    return 0;
  }, [
    visible,
    hasContent,
    loading,
    progress.classification,
    form,
    loaderHeight,
    maxContentHeight,
  ]);

  // Create a key that changes when progress state changes to force re-renders
  const progressKey =
    `${progress.classification}-${progress.plan}-${progress.spec}-${
      Boolean(form.plan?.steps)
    }-${Boolean(form.plan?.spec)}`;

  // Container animation that handles visibility only
  const containerSpring = useSpring({
    opacity: visible && hasContent ? 1 : 0,
    transform: visible && hasContent ? "translateY(0%)" : "translateY(-20%)",
    width: visible && hasContent ? "100%" : "95%",
    height: containerHeight,
    config: {
      tension: 280,
      friction: 24,
    },
    // Reset on significant changes
    reset: true,
    key: progressKey,
  });

  // Content transition between loading and content states
  const contentTransition = useTransition(!loading || progress.classification, {
    from: { opacity: 0, transform: "scale(0.9)" },
    enter: { opacity: 1, transform: "scale(1)" },
    leave: {
      opacity: 0,
      transform: "scale(0.9)",
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
    },
    config: {
      tension: 300,
      friction: 26,
    },
    // Reset when progress changes to prevent animation glitches
    reset: true,
    key: progressKey,
  });

  // Text reveal animation - updates based on progress state not just loading
  const textSpring = useSpring({
    opacity: (visible && (!loading || progress.classification)) ? 1 : 0,
    transform: (visible && (!loading || progress.classification))
      ? "translateY(0)"
      : "translateY(10px)",
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

  // Format the confidence as a percentage
  const confidencePercentage = Math.round(
    (form.classification?.confidence ?? 0) * 100,
  );

  if (
    !form.plan?.spec && (!form.plan?.steps || form.plan?.steps.length === 0) &&
    !progress.classification &&
    !loading && !planLoading
  ) {
    return null;
  }

  return (
    <animated.div
      className={containerClasses}
      style={{
        ...containerSpring,
        ...(floating
          ? {
            width: "calc(100% - 2rem)",
            left: "1rem",
            bottom: "calc(100% + 0.5rem)",
            overflowY: "auto",
          }
          : {
            overflowY: "auto",
          }),
        // Use visibility to completely hide when not visible
        display: !visible || !hasContent ? "none" : "block",
        visibility: containerSpring.opacity.to((o) =>
          o === 0 ? "hidden" : "visible"
        ),
        pointerEvents: containerSpring.opacity.to((o) =>
          o === 0 ? "none" : "auto"
        ),
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
              {/* Only show main loading spinner while we wait for classification */}
              {loading && !progress.classification
                ? (
                  <div className="flex items-center justify-center w-full py-2">
                    <DitheredCube
                      animationSpeed={2}
                      width={32}
                      height={32}
                      animate
                      cameraZoom={12}
                    />
                  </div>
                )
                : (
                  <div className="space-y-2 w-full">
                    {/* Workflow Classification Section */}
                    {(classificationLoading ||
                        !form.classification?.workflowType)
                      ? (
                        <div className="flex items-center justify-center py-2">
                          <DitheredCube
                            animationSpeed={2}
                            width={24}
                            height={24}
                            animate
                            cameraZoom={12}
                          />
                          <span className="ml-2 text-xs">
                            Classifying workflow...
                          </span>
                        </div>
                      )
                      : (
                        <>
                          <div className="flex flex-col gap-1">
                            <div className="flex items-center w-full mb-0.5">
                              <ToggleButton
                                options={[
                                  { value: "fix", label: "FIX" },
                                  { value: "edit", label: "EDIT" },
                                  { value: "imagine", label: "IMAGINE" },
                                ]}
                                value={form.classification?.workflowType}
                                onChange={(value) =>
                                  onWorkflowChange?.(value as WorkflowType)}
                                size="small"
                                className="w-full"
                              />
                            </div>

                            {/* Compact workflow explanation */}
                            {
                              /* <div className="text-[10px] text-gray-600 mb-1">
                              {workflowType === "fix" &&
                                "🛠️ Preserves existing spec, only modifies code"}
                              {workflowType === "edit" &&
                                "✏️ Preserves data structure, updates functionality"}
                              {workflowType === "imagine" &&
                                "🔄 Creates new spec with potentially different schema"}
                            </div> */
                            }
                          </div>

                          {/* Show plan and spec in a 2-column layout */}
                          {
                            <div className="grid grid-cols-2 gap-1">
                              {/* Spec Section */}
                              {form.classification?.workflowType !== "fix"
                                ? (
                                  <div className="bg-gray-50 rounded p-1">
                                    <div className="text-xs font-bold mb-1">
                                      SPEC
                                    </div>
                                    {/* Show spec when available, otherwise loading */}
                                    {form.plan?.spec
                                      ? (
                                        <div className="font-mono text-[10px] whitespace-pre-wrap overflow-y-auto">
                                          {form.plan?.spec}
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
                                          <span className="ml-1 text-[10px]">
                                            Generating...
                                          </span>
                                        </div>
                                      )}
                                  </div>
                                )
                                : (
                                  <div className="bg-gray-50 rounded p-1">
                                    <div className="text-xs font-bold mb-1">
                                      ORIGINAL SPEC{" "}
                                      <span className="text-[10px] text-blue-600">
                                        (preserved)
                                      </span>
                                    </div>
                                    {form.plan?.spec
                                      ? (
                                        <div className="font-mono text-[10px] whitespace-pre-wrap overflow-y-auto">
                                          {form.plan?.spec}
                                        </div>
                                      )
                                      : (
                                        <div className="text-[10px] text-gray-500 italic">
                                          Loading original specification...
                                        </div>
                                      )}
                                  </div>
                                )}
                              {/* Plan Section */}
                              <div className="bg-gray-50 rounded p-1">
                                <div className="text-xs font-bold mb-1">
                                  PLAN
                                </div>
                                {/* Show loading spinner whenever plan is still loading */}
                                {(loading || planLoading) && !progress.plan
                                  ? (
                                    <div className="flex items-center py-1">
                                      <DitheredCube
                                        animationSpeed={2}
                                        width={20}
                                        height={20}
                                        animate
                                        cameraZoom={12}
                                      />
                                      <span className="ml-1 text-[10px]">
                                        Generating...
                                      </span>
                                    </div>
                                  )
                                  : form.plan?.steps
                                  ? (
                                    <div className="font-mono text-[10px] whitespace-pre-wrap">
                                      {form.plan?.steps.map((step, index) => (
                                        <div
                                          key={index}
                                          className="py-0.5 border-t first:border-t-0 border-gray-100"
                                        >
                                          <span className="font-bold">
                                            {index + 1}.
                                          </span>{" "}
                                          {step}
                                        </div>
                                      ))}
                                    </div>
                                  )
                                  : (
                                    <div className="text-[10px] text-gray-500 italic">
                                      Plan will appear here...
                                    </div>
                                  )}
                              </div>
                            </div>
                          }
                        </>
                      )}

                    {/* Classification Reasoning Accordion */}
                    {form.classification?.reasoning && (
                      <Accordion
                        title={
                          <div className="text-[10px] inline-flex gap-1">
                            <span>Reasoning</span>

                            {form.classification?.confidence > 0 && (
                              <span
                                className={`text-[10px] ${
                                  form.classification?.confidence > 0.7
                                    ? "text-green-700"
                                    : "text-amber-600"
                                }`}
                              >
                                ({confidencePercentage}% confidence)
                              </span>
                            )}
                          </div>
                        }
                        defaultOpen={false}
                        badge={null}
                      >
                        <div className="text-[10px] text-gray-700 leading-tight max-h-16 overflow-y-auto">
                          {form.classification?.reasoning}
                        </div>
                      </Accordion>
                    )}

                    {form.plan?.schema && (
                      <Accordion
                        title={<span className="text-[10px]">Schema</span>}
                        defaultOpen={false}
                        badge={null}
                      >
                        <pre className="text-[10px] text-gray-700 leading-tight max-h-32 overflow-y-auto">
                          {JSON.stringify(form.plan.schema, null, 2)}
                        </pre>
                      </Accordion>
                    )}

                    {/* Empty state message */}
                    {!form.plan?.spec && !form.plan?.steps &&
                      !classificationLoading && !planLoading &&
                      (
                        <animated.div
                          className="text-xs text-gray-500 italic py-4 text-center"
                          style={textSpring}
                        >
                          Your preview will appear here as you type...
                        </animated.div>
                      )}
                  </div>
                )}
            </div>
          )}
        </div>
      </div>
    </animated.div>
  );
}
