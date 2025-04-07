import React, { useRef, useState } from "react";
import { DitheredCube } from "./DitherCube.tsx";
import { animated, useSpring, useTransition } from "@react-spring/web";
import { ToggleButton } from "./common/CommonToggle.tsx";
import type { ExecutionPlan } from "@commontools/charm";

export type WorkflowType = "fix" | "edit" | "rework";

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

function Accordion({ title, children, defaultOpen = false, badge }: AccordionProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  
  const contentStyles = useSpring({
    from: { 
      opacity: 0, 
      height: 0,
      transform: "translateY(-10px)",
      overflow: "hidden",
      display: "none",
    },
    to: {
      opacity: isOpen ? 1 : 0,
      height: isOpen ? "auto" : 0,
      transform: isOpen ? "translateY(0)" : "translateY(-10px)",
      overflow: "hidden",
      display: isOpen ? "block" : "none",
    },
    immediate: !isOpen,
    config: { 
      tension: 300, 
      friction: 26,
      clamp: true,
    }
  });

  return (
    <div className="border border-gray-200 rounded-md mb-2 overflow-hidden">
      <button
        className="w-full p-2 bg-gray-50 text-left flex items-center justify-between text-xs font-bold"
        onClick={() => setIsOpen(!isOpen)}
        type="button"
        aria-expanded={isOpen}
      >
        <div className="flex items-center">
          <span className="mr-2 transition-transform" style={{ 
            transform: isOpen ? "rotate(90deg)" : "rotate(0deg)" 
          }}>▶</span>
          {title}
        </div>
        {badge}
      </button>
      <animated.div style={contentStyles}>
        <div className="p-2 bg-white">{children}</div>
      </animated.div>
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
  onWorkflowChange,
  onFormChange,
}: SpecPreviewProps) {
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

  // Container animation that handles visibility and dimensions
  const containerSpring = useSpring({
    opacity: visible && hasContent ? 1 : 0,
    transform: visible && hasContent ? "translateY(0%)" : "translateY(-20%)",
    // Adjust height based on loading state
    height: !visible || !hasContent
      ? 0
      : loading
      ? loaderHeight
      : maxContentHeight,
    width: visible && hasContent ? "100%" : "95%",
    config: {
      tension: 280,
      friction: 24,
    },
  });

  // Content transition between loading and content
  const contentTransition = useTransition(loading, {
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
  });

  // Text reveal animation
  const textSpring = useSpring({
    opacity: !loading && visible ? 1 : 0,
    transform: !loading && visible ? "translateY(0)" : "translateY(10px)",
    config: {
      tension: 300,
      friction: 20,
    },
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
              {loading ? (
                <div className="flex items-center justify-center w-full py-4">
                  <DitheredCube
                    animationSpeed={2}
                    width={48}
                    height={48}
                    animate
                    cameraZoom={12}
                  />
                </div>
              ) : (
                <div className="space-y-4 w-full">
                  {/* Workflow Classification Section */}
                  {classificationLoading ? (
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
                  ) : (
                    <>
                      <div className="flex flex-col gap-2">
                        <div className="text-xs font-bold mb-1 flex items-center justify-between">
                          <span>WORKFLOW: {workflowType.toUpperCase()}</span>
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
                            { value: "rework", label: "REWORK" },
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
                            {workflowType === "rework" &&
                              "🔄 Rework: Creates new spec with potentially different schema"}
                          </div>
                        </div>

                        {/* Classification Reasoning Accordion */}
                        {workflowReasoning && (
                          <Accordion 
                            title="Classification Reasoning" 
                            defaultOpen={false}
                            badge={
                              <span className="text-xs text-gray-500">
                                {workflowConfidence > 0.8 ? "High confidence" : "Medium confidence"}
                              </span>
                            }
                          >
                            <div className="text-xs text-gray-700 leading-tight">
                              {workflowReasoning}
                            </div>
                          </Accordion>
                        )}
                      </div>
                      
                      {/* Only show plan and spec sections if classification is complete */}
                      {!classificationLoading && (
                        <>
                          {/* Plan Section */}
                          <div className="relative">
                            {planLoading ? (
                              <div className="flex items-center justify-center py-4 border border-gray-200 rounded bg-gray-50">
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
                            ) : plan ? (
                              <Accordion 
                                title="PLAN" 
                                defaultOpen={true}
                                badge={
                                  <span className="text-gray-500 text-xs">
                                    {typeof plan === "string"
                                      ? "1 step"
                                      : `${plan.length} steps`}
                                  </span>
                                }
                              >
                                <animated.div
                                  className="font-mono text-xs whitespace-pre-wrap"
                                  style={{
                                    ...textSpring,
                                    scrollbarWidth: "thin",
                                    scrollbarColor: "#aaa #eee",
                                  }}
                                >
                                  {Array.isArray(plan)
                                    ? plan.map((step, index) => (
                                      <div
                                        key={index}
                                        className="mb-2 pb-2 border-b border-gray-100 last:border-b-0"
                                      >
                                        <strong>{index + 1}.</strong> {step}
                                      </div>
                                    ))
                                    : plan}
                                </animated.div>
                              </Accordion>
                            ) : (
                              <div className="text-xs text-gray-500 italic p-2">
                                Plan will appear here...
                              </div>
                            )}
                          </div>

                          {/* Spec Section - Only for edit/rework workflows */}
                          {workflowType !== "fix" && (spec || planLoading) && (
                            <div>
                              {planLoading ? (
                                <div className="p-4 bg-gray-50 border border-gray-200 rounded text-center text-xs text-gray-500">
                                  Generating specification...
                                </div>
                              ) : spec ? (
                                <Accordion 
                                  title="SPEC" 
                                  defaultOpen={true}
                                >
                                  <animated.div
                                    className="font-mono text-xs whitespace-pre-wrap"
                                    style={{
                                      ...textSpring,
                                      scrollbarWidth: "thin",
                                      scrollbarColor: "#aaa #eee",
                                    }}
                                  >
                                    {spec}
                                  </animated.div>
                                </Accordion>
                              ) : null}
                            </div>
                          )}

                          {/* Original Spec - Only for fix workflow */}
                          {workflowType === "fix" && (spec || planLoading) && (
                            <div>
                              {spec ? (
                                <Accordion 
                                  title="ORIGINAL SPEC" 
                                  defaultOpen={false}
                                  badge={
                                    <span className="text-xs text-blue-600">
                                      (preserved)
                                    </span>
                                  }
                                >
                                  <animated.div
                                    className="font-mono text-xs whitespace-pre-wrap"
                                    style={{
                                      ...textSpring,
                                      scrollbarWidth: "thin",
                                      scrollbarColor: "#aaa #eee",
                                    }}
                                  >
                                    {spec}
                                  </animated.div>
                                </Accordion>
                              ) : (
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
                  {!spec && !plan && !classificationLoading && !planLoading && (
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
