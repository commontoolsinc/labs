import React, { useRef, useState } from "react";
import { DitheredCube } from "./DitherCube.tsx";
import { animated, useSpring, useTransition } from "@react-spring/web";
import { ToggleButton } from "./common/CommonToggle.tsx";
import type { ExecutionPlan, WorkflowType } from "@commontools/charm";

interface SpecPreviewProps {
  spec?: string;
  plan?: string[] | string;
  loading: boolean;
  classificationLoading?: boolean; // Separate loading state for classification
  planLoading?: boolean; // Separate loading state for plan generation
  visible: boolean;
  floating?: boolean;
  workflowType?: WorkflowType;
  workflowConfidence?: number;
  workflowReasoning?: string;
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

  // This is a much simpler approach that doesn't rely on react-spring for height animation
  return (
    <div className="border border-gray-200 rounded-md mb-2 overflow-hidden">
      <button
        className="w-full p-2 bg-gray-50 text-left flex items-center justify-between text-xs font-bold"
        onClick={() => setIsOpen(!isOpen)}
        type="button"
        aria-expanded={isOpen}
      >
        <div className="flex items-center">
          <span
            className="mr-2 transition-transform"
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
          className="p-2 bg-white"
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
  spec,
  plan,
  loading,
  classificationLoading = false,
  planLoading = false,
  visible,
  floating = false,
  workflowType = "edit",
  workflowConfidence = 0,
  workflowReasoning,
  progress = { classification: false, plan: false, spec: false },
  onWorkflowChange,
  onFormChange,
}: SpecPreviewProps) {
  
  // Debug all incoming props for comprehensive tracking
  React.useEffect(() => {
    console.log("SpecPreview FULL PROPS:", {
      spec: spec ? `${spec.substring(0, 30)}...` : null,
      plan,
      workflowType,
      progress,
      loading,
      classificationLoading,
      planLoading
    });
  }, [spec, plan, workflowType, progress, loading, classificationLoading, planLoading]);
  // Create the current form state
  const formData = React.useMemo<Partial<ExecutionPlan>>(() => ({
    workflowType,
    plan: plan || [],
    spec,
  }), [workflowType, plan, spec]);

  // Notify parent when form data changes
  React.useEffect(() => {
    if (onFormChange) {
      onFormChange(formData);
    }
  }, [formData, onFormChange]);
  const hasContent = loading || plan || spec;

  // Create a reference to measure content height
  const contentRef = useRef<HTMLDivElement>(null);

  // Calculate different heights for different states
  const loaderHeight = 80; // Height for just the loader (48px cube + padding)
  const maxContentHeight = floating
    ? 320
    : typeof window !== "undefined"
    ? Math.min(300, globalThis.innerHeight * 0.5)
    : 320;

  // Force a re-render when any of these change
  React.useEffect(() => {
    // This effect just forces a re-render
    console.log("Content/Progress changed:", {
      hasContent,
      planLoaded: Boolean(plan),
      planType: typeof plan,
      planIsArray: Array.isArray(plan),
      planData: plan,
      specLoaded: Boolean(spec),
      progress,
    });
    
    // Force a re-render when plan data arrives
    if (plan && progress.plan) {
      const forceUpdate = setTimeout(() => {
        console.log("Force updating component due to plan data");
      }, 50);
      return () => clearTimeout(forceUpdate);
    }
  }, [hasContent, plan, spec, progress]);

  // Directly set the height style without animation
  const containerHeight = React.useMemo(() => {
    if (!visible || !hasContent) {
      return 0;
    }

    // If we're loading and no progress, show minimal height
    if (loading && !progress.classification) {
      return loaderHeight;
    }

    // If we have any content, show full height
    if (progress.classification || plan || spec) {
      return maxContentHeight;
    }

    return maxContentHeight;
  }, [
    visible,
    hasContent,
    loading,
    progress.classification,
    plan,
    spec,
    loaderHeight,
    maxContentHeight,
  ]);

  // Create a key that changes when progress state changes to force re-renders
  const progressKey =
    `${progress.classification}-${progress.plan}-${progress.spec}-${
      Boolean(plan)
    }-${Boolean(spec)}`;

  // Container animation that handles visibility only
  const containerSpring = useSpring({
    opacity: visible && hasContent ? 1 : 0,
    transform: visible && hasContent ? "translateY(0%)" : "translateY(-20%)",
    width: visible && hasContent ? "100%" : "95%",
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
  const confidencePercentage = Math.round(workflowConfidence * 100);

  return (
    <animated.div
      className={containerClasses}
      style={{
        ...containerSpring,
        // Set height directly without animation
        height: containerHeight,
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
        // Use visibility instead of display for animation purposes
        visibility: containerSpring.opacity.to((o) =>
          o === 0 ? "hidden" : "visible"
        ),
        pointerEvents: containerSpring.opacity.to((o) =>
          o === 0 ? "none" : "auto"
        ),
      }}
    >
      <div className="p-3 relative" ref={contentRef}>
        <div
          className="space-y-4"
          style={{
            position: "relative",
            minHeight: loading ? "48px" : "auto",
            transition: "min-height 0.3s ease",
          }}
        >
          {!visible ? null : (
            <div className="space-y-4 w-full">
              {/* Only show main loading spinner while we wait for classification */}
              {loading && !progress.classification
                ? (
                  <div className="flex items-center justify-center w-full py-4">
                    <DitheredCube
                      animationSpeed={2}
                      width={48}
                      height={48}
                      animate
                      cameraZoom={12}
                    />
                  </div>
                )
                : (
                  <div className="space-y-4 w-full">
                    {/* Workflow Classification Section */}
                    {classificationLoading
                      ? (
                        <div className="flex items-center justify-center py-4">
                          <DitheredCube
                            animationSpeed={2}
                            width={32}
                            height={32}
                            animate
                            cameraZoom={12}
                          />
                          <span className="ml-2 text-sm">
                            Classifying workflow...
                          </span>
                        </div>
                      )
                      : (
                        <>
                          <div className="flex flex-col gap-2">
                            <div className="text-xs font-bold mb-1 flex items-center justify-between">
                              <span>
                                WORKFLOW: {workflowType.toUpperCase()}
                              </span>
                              {workflowConfidence > 0 && (
                                <span
                                  className={`text-xs ${
                                    workflowConfidence > 0.7
                                      ? "text-green-700"
                                      : "text-amber-600"
                                  }`}
                                >
                                  {confidencePercentage}% confidence
                                </span>
                              )}
                            </div>
                            <ToggleButton
                              options={[
                                { value: "fix", label: "FIX" },
                                { value: "edit", label: "EDIT" },
                                { value: "imagine", label: "IMAGINE" },
                              ]}
                              value={workflowType}
                              onChange={(value) =>
                                onWorkflowChange?.(value as WorkflowType)}
                              size="small"
                            />

                            {/* Workflow explanation */}
                            <div className="mt-2 p-2 bg-gray-100 rounded-md">
                              <div className="text-xs font-semibold">
                                {workflowType === "fix" &&
                                  "🛠️ Fix: Preserves existing spec, only modifies code"}
                                {workflowType === "edit" &&
                                  "✏️ Edit: Preserves data structure, updates functionality"}
                                {workflowType === "imagine" &&
                                  "🔄 Imagine: Creates new spec with potentially different schema"}
                              </div>
                            </div>

                            {/* Classification Reasoning Accordion */}
                            {workflowReasoning && (
                              <Accordion
                                title="Classification Reasoning"
                                defaultOpen={false}
                                badge={
                                  <span className="text-xs text-gray-500">
                                    {workflowConfidence > 0.8
                                      ? "High confidence"
                                      : "Medium confidence"}
                                  </span>
                                }
                              >
                                <div className="text-xs text-gray-700 leading-tight">
                                  {workflowReasoning}
                                </div>
                              </Accordion>
                            )}
                          </div>

                          {/* Always show the plan and spec sections - with appropriate state for each */}
                          {(
                            <>
                              {/* Plan Section */}
                              <div className="relative bg-gray-50 border border-gray-200 rounded p-2">
                                <div className="text-sm font-bold mb-2">PLAN</div>
                                {/* Show loading spinner whenever plan is still loading */}
                                {(loading || planLoading) && !progress.plan
                                  ? (
                                    <div className="flex items-center justify-center py-4">
                                      <DitheredCube
                                        animationSpeed={2}
                                        width={32}
                                        height={32}
                                        animate
                                        cameraZoom={12}
                                      />
                                      <span className="ml-2 text-sm">
                                        Generating plan...
                                      </span>
                                    </div>
                                  )
                                  : plan
                                  ? (
                                    <div className="font-mono text-xs whitespace-pre-wrap">
                                      {/* Debug output */}
                                      <div className="bg-red-100 p-2 mb-2">
                                        Plan data: {JSON.stringify({
                                          planType: typeof plan,
                                          isArray: Array.isArray(plan),
                                          length: Array.isArray(plan) ? plan.length : (plan ? plan.length : 0)
                                        })}
                                      </div>
                                      
                                            {/* Display the plan contents */}
                                      <div className="font-mono text-xs whitespace-pre-wrap">
                                        {Array.isArray(plan)
                                        ? plan.map((step, index) => (
                                          <div
                                            key={index}
                                            className="mb-2 pb-2 border-b border-gray-100 last:border-b-0"
                                          >
                                            <strong>{index + 1}.</strong>{" "}
                                            {step}
                                          </div>
                                        ))
                                        : plan}
                                      </div>
                                    </div>
                                  )
                                  : (
                                    <div className="text-xs text-gray-500 italic p-2">
                                      Plan will appear here...
                                    </div>
                                  )}
                              </div>

                              {/* Spec Section - Always show for edit/imagine workflows after classification */}
                              {workflowType !== "fix" && (
                                <div className="bg-gray-50 border border-gray-200 rounded p-2">
                                  <div className="text-sm font-bold mb-2">SPEC</div>
                                  {/* Show spec when available, otherwise loading */}
                                  {spec ? (
                                    <div className="font-mono text-xs whitespace-pre-wrap">
                                      {spec}
                                    </div>
                                  ) : (
                                    <div className="flex items-center justify-center py-4">
                                      <DitheredCube
                                        animationSpeed={2}
                                        width={32}
                                        height={32}
                                        animate
                                        cameraZoom={12}
                                      />
                                      <span className="ml-2 text-sm">
                                        Generating specification...
                                      </span>
                                    </div>
                                  )}
                                </div>
                              )}

                              {/* Original Spec - Only for fix workflow */}
                              {workflowType === "fix" &&
                                (spec || progress.classification) && (
                                <div className="bg-gray-50 border border-gray-200 rounded p-2">
                                  <div className="text-sm font-bold mb-2">
                                    ORIGINAL SPEC <span className="text-xs text-blue-600">(preserved)</span>
                                  </div>
                                  {spec
                                    ? (
                                      <div className="font-mono text-xs whitespace-pre-wrap">
                                        {spec}
                                      </div>
                                    )
                                    : (
                                      <div className="p-4 bg-gray-50 border border-gray-200 rounded text-center text-xs text-gray-500">
                                        Loading original specification...
                                      </div>
                                    )}
                                </div>
                              )}
                            </>
                          )}
                        </>
                      )}

                    {/* Empty state message */}
                    {!spec && !plan && !classificationLoading && !planLoading &&
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
