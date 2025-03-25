import React from "react";
import { DitheredCube } from "./DitherCube.tsx";

interface SpecPreviewProps {
  spec: string;
  plan: string;
  loading: boolean;
  visible: boolean;
}

/**
 * Component that shows a live preview of the spec and plan
 */
export function SpecPreview({ 
  spec, 
  plan,
  loading, 
  visible 
}: SpecPreviewProps) {
  if (!visible) return null;

  return (
    <div className="preview-container border-t-2 border-black pt-4 mb-4">
      <div className="flex justify-between items-center mb-2">
        <h3 className="text-sm font-bold">Live Specification Preview</h3>
      </div>
      <div className="border p-3 bg-gray-50 rounded">
        {loading ? (
          <div className="flex items-center justify-center p-4">
            <DitheredCube
              animationSpeed={2}
              width={24}
              height={24}
              animate
              cameraZoom={12}
            />
          </div>
        ) : (
          <div className="space-y-4">
            {plan && (
              <div>
                <div className="text-xs font-bold mb-1">PLAN</div>
                <div className="font-mono text-sm whitespace-pre-wrap">
                  {plan}
                </div>
              </div>
            )}
            {spec && (
              <div>
                <div className="text-xs font-bold mb-1">SPEC</div>
                <div className="font-mono text-sm whitespace-pre-wrap">
                  {spec}
                </div>
              </div>
            )}
            {!spec && !plan && (
              <div className="text-sm text-gray-500 italic">
                Your specification preview will appear here as you type...
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}