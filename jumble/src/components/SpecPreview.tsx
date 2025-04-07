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
            // Set a smooth transition if needed for immediate inner content changes
            transition: "min-height 0.3s ease",
          }}
        >
          {contentTransition((style, isLoading) =>
            isLoading
              ? (
                <animated.div
                  className="flex items-center justify-center w-full"
                  style={style}
                >
                  <DitheredCube
                    animationSpeed={2}
                    width={48}
                    height={48}
                    animate
                    cameraZoom={12}
                  />
                </animated.div>
              )
              : (
                <animated.div className="space-y-4 w-full" style={style}>
                  {/* Workflow section with its own loading state */}
                  <div className="mb-3 relative">
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
                          {workflowReasoning && (
                            <div className="text-xs text-gray-600 italic mt-1">
                              {workflowReasoning}
                            </div>
                          )}

                          {/* Display workflow explanation with descriptive labels */}
                          <div className="mt-2 p-2 bg-gray-100 rounded-md">
                            <div className="text-xs font-semibold">
                              {workflowType === "fix" &&
                                "🛠️ Fix: Preserves existing spec, only modifies code"}
                              {workflowType === "edit" &&
                                "✏️ Edit: Preserves data structure, updates functionality"}
                              {workflowType === "rework" &&
                                "🔄 Rework: Creates new spec with potentially different schema"}
                            </div>
                            {workflowReasoning && (
                              <div className="text-xs text-gray-700 mt-1 leading-tight bg-white p-2 rounded my-1 border border-gray-200 max-h-32 overflow-y-auto">
                                <strong>Classification reasoning:</strong>
                                <br />
                                {workflowReasoning}
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                  </div>

                  {/* Plan section with its own loading state */}
                  <div className="relative">
                    <div className="text-xs font-bold mb-1 flex justify-between items-center">
                      <span>PLAN</span>
                      {!planLoading && plan && (
                        <span className="text-gray-500 text-xs">
                          {typeof plan === "string"
                            ? "1 step"
                            : `${plan.length} steps`}
                        </span>
                      )}
                    </div>

                    {planLoading
                      ? (
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
                      )
                      : plan
                      ? (
                        <animated.div
                          className="font-mono text-xs whitespace-pre-wrap max-h-60 overflow-y-auto p-2 bg-gray-50 rounded border border-gray-200"
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
                      )
                      : (
                        <div className="text-xs text-gray-500 italic p-2">
                          Plan will appear here...
                        </div>
                      )}
                  </div>

                  {/* Spec section */}
                  {(spec || planLoading) && workflowType !== "fix" && (
                    <div>
                      <div className="text-xs font-bold mb-1 flex justify-between">
                        <span>SPEC</span>
                      </div>

                      {planLoading
                        ? (
                          <div className="p-4 bg-gray-50 border border-gray-200 rounded text-center text-xs text-gray-500">
                            Generating specification...
                          </div>
                        )
                        : spec
                        ? (
                          <animated.div
                            className="font-mono text-xs whitespace-pre-wrap max-h-48 overflow-y-auto p-2 bg-gray-50 rounded border border-gray-200"
                            style={{
                              ...textSpring,
                              scrollbarWidth: "thin",
                              scrollbarColor: "#aaa #eee",
                            }}
                          >
                            {spec}
                          </animated.div>
                        )
                        : null}
                    </div>
                  )}

                  {/* Display original spec for fix workflow */}
                  {(spec || planLoading) && workflowType === "fix" && (
                    <div>
                      <div className="text-xs font-bold mb-1 flex justify-between">
                        <span>ORIGINAL SPEC</span>
                        <span className="text-xs text-blue-600">
                          (preserved)
                        </span>
                      </div>

                      {spec
                        ? (
                          <animated.div
                            className="font-mono text-xs whitespace-pre-wrap max-h-48 overflow-y-auto p-2 bg-gray-50 rounded border border-gray-200"
                            style={{
                              ...textSpring,
                              scrollbarWidth: "thin",
                              scrollbarColor: "#aaa #eee",
                            }}
                          >
                            {spec}
                          </animated.div>
                        )
                        : (
                          <div className="p-4 bg-gray-50 border border-gray-200 rounded text-center text-xs text-gray-500">
                            Loading original specification...
                          </div>
                        )}
                    </div>
                  )}

                  {!spec && !plan && !classificationLoading && !planLoading && (
                    <animated.div
                      className="text-xs text-gray-500 italic py-4 text-center"
                      style={textSpring}
                    >
                      Your preview will appear here as you type...
                    </animated.div>
                  )}
                </animated.div>
              )
          )}
        </div>
      </div>
    </animated.div>
  );
}
