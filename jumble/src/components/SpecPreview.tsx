import React from "react";
import { DitheredCube } from "./DitherCube.tsx";
import { animated, useSpring } from "@react-spring/web";

interface SpecPreviewProps {
  spec: string;
  plan: string;
  loading: boolean;
  visible: boolean;
  floating?: boolean;
}

/**
 * Component that shows a live preview of the spec and plan
 */
export function SpecPreview({
  spec,
  plan,
  loading,
  visible,
  floating = false,
}: SpecPreviewProps) {
  // Calculate if we have content to show
  const hasContent = loading || plan || spec;

  // Animation for sliding in/out
  const springProps = useSpring({
    opacity: visible && hasContent ? 1 : 0,
    transform: visible && hasContent ? "translateY(0%)" : "translateY(-20%)",
    maxHeight: visible && hasContent ? "500px" : "0px",
    config: {
      tension: 280,
      friction: 24,
    },
  });

  if (!visible) return null;

  // Different styles based on whether it's floating or inline
  const containerClasses = floating
    ? "preview-container border border-2 overflow-hidden fixed z-50"
    : "preview-container border-t-2 border-black pt-2 bg-white";

  return (
    <animated.div
      className={containerClasses}
      style={{
        ...springProps,
        ...(floating
          ? {
            width: "calc(100% - 2rem)",
            left: "1rem",
            bottom: "calc(100% + 0.5rem)", // Position above the composer
            maxHeight: "300px",
            overflowY: "auto",
          }
          : {}),
      }}
    >
      <div className="p-3 bg-gray-200">
        {loading
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
            <div className="space-y-4">
              {plan && (
                <div>
                  <div className="text-xs font-bold mb-1">PLAN</div>
                  <div className="font-mono text-xs whitespace-pre-wrap">
                    {plan}
                  </div>
                </div>
              )}
              {spec && (
                <div>
                  <div className="text-xs font-bold mb-1">SPEC</div>
                  <div className="font-mono text-xs whitespace-pre-wrap">
                    {spec}
                  </div>
                </div>
              )}
              {!spec && !plan && (
                <div className="text-xs text-gray-500 italic">
                  Your specification preview will appear here as you type...
                </div>
              )}
            </div>
          )}
      </div>
    </animated.div>
  );
}
