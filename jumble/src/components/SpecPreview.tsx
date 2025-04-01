import React, { useRef, useState } from "react";
import { DitheredCube } from "./DitherCube.tsx";
import { animated, useSpring, useTransition } from "@react-spring/web";
import { ToggleButton } from "./common/CommonToggle.tsx";

export type WorkflowType = "fix" | "edit" | "rework";

interface SpecPreviewProps {
  spec?: string;
  plan?: string;
  loading: boolean;
  visible: boolean;
  floating?: boolean;
  workflowType?: WorkflowType;
  workflowConfidence?: number;
  workflowReasoning?: string;
  onWorkflowChange?: (workflow: WorkflowType) => void;
}

export function SpecPreview({
  spec,
  plan,
  loading,
  visible,
  floating = false,
  workflowType = "edit",
  workflowConfidence = 0,
  workflowReasoning,
  onWorkflowChange,
}: SpecPreviewProps) {
  const hasContent = loading || plan || spec;

  // Create a reference to measure content height
  const contentRef = useRef<HTMLDivElement>(null);

  // Calculate different heights for different states
  const loaderHeight = 80; // Height for just the loader (48px cube + padding)
  const maxContentHeight = floating
    ? 200
    : typeof window !== "undefined"
    ? Math.min(300, globalThis.innerHeight * 0.5)
    : 200;

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
                  {/* Workflow selector */}
                  {onWorkflowChange && (
                    <div className="mb-3">
                      <div className="flex flex-col gap-2">
                        <div className="text-xs font-bold mb-1 flex items-center justify-between">
                          <span>WORKFLOW</span>
                          {workflowConfidence > 0 && (
                            <span className="text-gray-500 text-xs">
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
                            onWorkflowChange(value as WorkflowType)}
                          size="small"
                        />
                        {workflowReasoning && (
                          <div className="text-xs text-gray-600 italic mt-1">
                            {workflowReasoning}
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {plan && (
                    <div>
                      <div className="text-xs font-bold mb-1">PLAN</div>
                      <animated.div
                        className="font-mono text-xs whitespace-pre-wrap"
                        style={textSpring}
                      >
                        {plan}
                      </animated.div>
                    </div>
                  )}

                  {spec && workflowType !== "fix" && (
                    <div>
                      <div className="text-xs font-bold mb-1">SPEC</div>
                      <animated.div
                        className="font-mono text-xs whitespace-pre-wrap"
                        style={textSpring}
                      >
                        {spec}
                      </animated.div>
                    </div>
                  )}

                  {!spec && !plan && !isLoading && (
                    <animated.div
                      className="text-xs text-gray-500 italic"
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
