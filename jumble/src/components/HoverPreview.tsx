import { charmId } from "@/utils/charms.ts";
import { Cell } from "@commontools/runner";
import { NAME } from "@commontools/builder";
import { CommonCard } from "@/components/common/CommonCard.tsx";
import { CharmRenderer } from "@/components/CharmRunner.tsx";
import { Charm } from "@commontools/charm";
import { memo, useCallback } from "react";

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

    return (
      <div
        className="fixed z-50 w-128 pointer-events-none
        border border-black shadow-[4px_4px_0px_0px_rgba(0,0,0,0.5)] rounded-[4px]
      "
        style={{
          left: `${position.x}px`,
          top: `${position.y}px`,
          transform: `scale(${scale})`,
        }}
      >
        <CommonCard className="p-2 shadow-xl bg-white rounded-[4px]">
          <h3 className="text-xl font-semibold text-gray-800 mb-4">
            {name + ` (#${id!.slice(-4)})`}
          </h3>
          <div className="w-full bg-gray-50 rounded border border-gray-100 min-h-[256px] pointer-events-none select-none">
            <CharmRenderer className="h-full rounded-[4px]" charm={charm} />
          </div>
        </CommonCard>
      </div>
    );
  },
);
