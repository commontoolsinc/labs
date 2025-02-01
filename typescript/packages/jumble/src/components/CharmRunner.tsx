import { useState, useEffect } from "react";
import { effect } from "@commontools/runner";
import type { DocImpl } from "@commontools/runner";
import { UI } from "@commontools/builder";

export interface CharmRunnerProps {
  charm: DocImpl<any>;
}

export default function CharmRunner({ charm }: CharmRunnerProps) {
  // The charm's UI property is stored reactively under UI.
  // We "subscribe” and update React state so that React re-renders.
  const [view, setView] = useState<React.ReactNode>(null);

  useEffect(() => {
    // Call effect on charm.asCell(UI) (you might need to call charm.asCell(UI))
    const unsubscribe = effect(charm.asCell(UI), (newView) => {
      // newView is the latest UI from the charm.
      setView(newView);
    });
    return () => {
      unsubscribe();
    };
  }, [charm]);

  return <div>{view}</div>;
}
