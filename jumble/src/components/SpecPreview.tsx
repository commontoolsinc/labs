import React from "react";
import { DitheredCube } from "./DitherCube.tsx";
import { animated, useSpring, useTransition } from "@react-spring/web";

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

  // Animation for container sliding in/out
  const containerSpring = useSpring({
    opacity: visible && hasContent ? 1 : 0,
    transform: visible && hasContent ? "translateY(0%)" : "translateY(-20%)",
    height: visible && hasContent ? "auto" : "0px", // Using height: auto for final state
    width: visible && hasContent ? "100%" : "95%",
    config: {
      tension: 280,
      friction: 24,
    },
  });

  // Transition for content sections with absolute positioning to prevent overlap
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
      delay: loading ? 0 : 100, // Delay text animation when transitioning from loading state
    },
  });

  if (!visible) return null;

  // Different styles based on whether it's floating or inline
  const containerClasses = floating
    ? "preview-container border border-2 fixed z-50"
    : "preview-container border-t-2 border-black pt-2 bg-white";

  return (
    <animated.div
      className={containerClasses}
      style={{
        ...containerSpring,
        ...(floating
          ? {
            width: "calc(100% - 2rem)",
            left: "1rem",
            bottom: "calc(100% + 0.5rem)", // Position above the composer
            overflowY: "auto",
            maxHeight: "300px", // Set a fixed maxHeight for floating mode
          }
          : {
            overflowY: "auto", // Always use overflow auto instead of hidden
            maxHeight: visible && hasContent
              ? (loading ? "150px" : "calc(min(500px, 80vh))") // Constrain to 80% of viewport height
              : "0px",
          }),
      }}
    >
      <div className="p-3 bg-gray-200 relative">
        <div
          style={{ position: "relative", minHeight: loading ? "48px" : "auto" }}
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
                  {spec && (
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
                  {!spec && !plan && (
                    <animated.div
                      className="text-xs text-gray-500 italic"
                      style={textSpring}
                    >
                      Your specification preview will appear here as you type...
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
