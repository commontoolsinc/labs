// This is all you need to import/register the @commontools/ui web components
import "@commontools/ui";
import React, { useRef } from "react";
import { type Charm, runPersistent } from "@commontools/lookslike-high-level";
import { effect, idle, run } from "@commontools/runner";
import { render } from "@commontools/html";

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
      await idle();
      run(undefined, undefined, charm);
      await idle();

      // connect the cells of the charm (reactive docs) and the 
      // view (recipe VDOM) to be rendered using common/html
      // into a specific DOM element (created in react)
      effect(charm.asCell<Charm>(), (charm) => {
        effect(charm['$UI'], (view) => {
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
