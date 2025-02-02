// This is all you need to import/register the @commontools/ui web components
import "@commontools/ui";
import React from "react";
import { useCharms } from "@/contexts/CharmsContext";
import RunnerWrapper from "@/components/RunnerWrapper";
import CharmRunner from "@/components/CharmRunner";

const handleClick = () => {
  console.log("clicked");
};

import { runPersistent } from "@commontools/lookslike-high-level";

export default function Shell() {
  const { charms, focusedCharm, addCharm, removeCharm, runCharm } = useCharms();

  console.log("charms", charms);
  console.log("focusedCharm", focusedCharm);

  const handleAddDummyCharm = () => {
    const dummyCharm = {
      entityId: Date.now().toString(),
      name: `Charm ${Date.now()}`,
      ui: <div>Dummy charm UI</div>,
    };
    addCharm(dummyCharm);
  };

  const handleLoadSmolCharm = async () => {
    try {
      const mod = await import("@/recipes/smol.tsx");
      const smolFactory = mod.default;
      console.log(smolFactory);
      // const smolCharm = {
      //   entityId: `smol-${Date.now()}`,
      //   name: "smol Charm",
      //   ui: smolFactory,
      // };
      const charm = await runPersistent(smolFactory);
      console.log(charm)
      await runCharm(charm);
    } catch (error) {
      console.error("Failed to load counter charm", error);
    }
  };

  return (
    <div className="h-full relative">
      {/* You still use class="foo" with web components. */}
      <common-button class="wat" onClick={handleClick}>
        click me
      </common-button>
      <button
        onClick={handleAddDummyCharm}
        className="mt-4 px-4 py-2 bg-blue-500 text-white rounded"
      >
        Add Dummy Charm
      </button>
      <button
        onClick={handleLoadSmolCharm}
        className="mt-4 ml-4 px-4 py-2 bg-green-500 text-white rounded"
      >
        Load & Run Smol Charm
      </button>

      <div className="border border-red-500 mt-4 p-2">
        {focusedCharm ? <CharmRunner charm={focusedCharm} /> : <div>No focused charm</div>}
      </div>

      {/* <div className="mt-4">
        {charms.map((charm) => (
          <div key={charm.entityId} className="p-4 mb-4 border rounded">
            <h2 className="text-lg font-bold">{charm.name}</h2>
            <div>{charm.ui}</div>
            <button
              onClick={() => removeCharm(charm.entityId)}
              className="mt-2 px-2 py-1 bg-red-500 text-white rounded"
            >
              Close
            </button>
          </div>
        ))}
      </div> */}
    </div>
  );
}
