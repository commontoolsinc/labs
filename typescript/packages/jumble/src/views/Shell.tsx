// This is all you need to import/register the @commontools/ui web components
import "@commontools/ui";
import React, { useRef } from "react";
import { type Charm, runPersistent, addCharms } from "@commontools/charm";
import { effect, idle, run } from "@commontools/runner";
import { render } from "@commontools/html";
import { setIframeContextHandler } from "@commontools/iframe-sandbox";
import { Action, ReactivityLog, addAction, removeAction } from "@commontools/runner";

// FIXME(ja): perhaps this could be in common-charm?  needed to enable iframe with sandboxing
setIframeContextHandler({
  read(context: any, key: string): any {
    return context?.getAsQueryResult ? context?.getAsQueryResult([key]) : context?.[key];
  },
  write(context: any, key: string, value: any) {
    context.getAsQueryResult()[key] = value;
  },
  subscribe(context: any, key: string, callback: (key: string, value: any) => void): any {
    const action: Action = (log: ReactivityLog) =>
      callback(key, context.getAsQueryResult([key], log));

    addAction(action);
    return action;
  },
  unsubscribe(_context: any, receipt: any) {
    removeAction(receipt);
  },
});

export default function Shell() {
  const containerRef = useRef<HTMLDivElement>(null);

  const handleLoadSmolCharm = async () => {
    try {
      // load the recipe, BUT you can't use JSX because
      // JSX here would be react JSX, not common/html JSX
      // even though the recipe imports our `h` function
      const mod = await import("@/recipes/smol.tsx");
      const smolFactory = mod.default;

      // run the charm (this makes the logic go, cells, etc)
      // but nothing about rendering...
      const charm = await runPersistent(smolFactory);
      addCharms([charm]);
      
      await idle();
      run(undefined, undefined, charm);
      await idle();

      // connect the cells of the charm (reactive docs) and the 
      // view (recipe VDOM) to be rendered using common/html
      // into a specific DOM element (created in react)
      console.log("charm", JSON.stringify(charm, null, 2));
      effect(charm.asCell<Charm>(), (charm) => {
        console.log("charm", JSON.stringify(charm, null, 2));
        effect(charm['$UI'], (view) => {
          console.log("view", JSON.stringify(view, null, 2));
          render(containerRef.current as HTMLElement, view);
        });
      });
    } catch (error) {
      console.error("Failed to load counter charm", error);
    }
  };

  return (
    <div className="h-full relative">
      <button
        onClick={handleLoadSmolCharm}
        className="mt-4 ml-4 px-4 py-2 bg-green-500 text-white rounded"
      >
        Load & Run Smol Charm
      </button>

      <div className="border border-red-500 mt-4 p-2">
        <div ref={containerRef}></div>
      </div>
    </div>
  );
}
