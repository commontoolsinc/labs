import React, { useRef, useEffect } from "react";
import { effect } from "@commontools/runner";
import type { DocImpl } from "@commontools/runner";
import { createRoot, Root } from "react-dom/client";
import { UI } from "@commontools/builder";

export interface CharmRunnerProps {
  // Accept either a full reactive DocImpl or a plain charm with a ui prop.
  charm: DocImpl<any> | { ui: React.ReactNode };
}

export default function CharmRunner({ charm }: CharmRunnerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<Root | null>(null);

  useEffect(() => {
    // Helper: updates the container with the new view, re-using the root.
    const updateContainer = (view: any) => {
      if (containerRef.current) {
        if (!rootRef.current) {
          rootRef.current = createRoot(containerRef.current);
        }
        if (React.isValidElement(view)) {
          rootRef.current.render(view);
        } else {
          // If view is raw html, update innerHTML
          containerRef.current.innerHTML = view;
        }
      }
    };

    // If the charm doesn't have asCell (i.e. not reactive), immediately update.
    if (typeof (charm as any).asCell !== "function") {
      updateContainer((charm as { ui: React.ReactNode }).ui);
      return;
    }

    // If charm is reactive, subscribe to its UI cell.
    const unsubscribe = effect((charm as DocImpl<any>).asCell(UI), (view: any) => {
      if (!view) {
        console.warn("No UI for charm", charm);
        return;
      }
      updateContainer(view);
    });

    return () => {
      unsubscribe();
    };
  }, [charm]);

  return <div ref={containerRef} />;
}
