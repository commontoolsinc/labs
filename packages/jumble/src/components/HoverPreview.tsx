import { Cell } from "@commontools/runner";
import { NAME } from "@commontools/builder";
import { CommonCard } from "@/components/common/CommonCard.tsx";
import { CharmRenderer } from "@/components/CharmRunner.tsx";
import { Charm, charmId } from "@commontools/charm";
import { memo, useCallback, useEffect, useState } from "react";

export interface HoverPreviewProps {
  charm: Cell<Charm>;
  position: { x: number; y: number };
}

export const HoverPreview = memo(
  ({ charm, position, scale = 0.75 }: HoverPreviewProps & {
    scale?: number;
  }) => {
    if (!charm) return null;

    const getId = useCallback(() => charmId(charm), [charm]);
    const getName = useCallback(() => charm.get()[NAME] || "Unnamed Charm", [
      charm,
    ]);

    const id = getId();
    const name = getName();

    // Key for animation reset when charm changes
    const [key, setKey] = useState(0);

    // Update key when charm changes to trigger CSS animation restart
    useEffect(() => {
      setKey((prevKey) => prevKey + 1);
    }, [charm]);

    return (
      <div
        key={key}
        className="fixed z-50 w-128 pointer-events-none flex flex-col border border-black shadow-[4px_4px_0px_0px_rgba(0,0,0,0.5)] rounded-[4px] animate-[fadeInScale_0.2s_ease-out]"
        style={{
          left: `${position.x}px`,
          top: `${position.y}px`,
          transform: `scale(${scale})`,
          height: "320px",
          animation: "fadeInScale 0.2s ease-out", // fallback for browsers that don't support @keyframes in class
          transformOrigin: "44% 44%",
          pointerEvents: "none",
          userSelect: "none",
        }}
      >
        <CommonCard className="p-2 shadow-xl bg-white rounded-[4px] flex flex-col h-full">
          <h3 className="text-xl font-semibold text-gray-800 mb-2">
            {name + ` (#${id!.slice(-4)})`}
          </h3>
          <div className="flex-grow bg-gray-50 rounded border border-gray-100 pointer-events-none select-none overflow-hidden">
            <CharmRenderer
              className="w-full h-full rounded-[4px]"
              charm={charm}
            />
          </div>
        </CommonCard>

        <style>
          {`
          @keyframes fadeInScale {
            from {
              opacity: 0.7;
              transform: scale(0.6);
              filter: blur(5px);
            }
            to {
              opacity: 1;
              transform: scale(0.75);
              filter: blur(0);
            }
          }
        `}
        </style>
      </div>
    );
  },
);
