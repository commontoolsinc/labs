// This is all you need to import/register the @commontools/ui web components
import "@commontools/ui";
import React from "react";
import { useCharms } from "@/contexts/CharmsContext";
import RunnerWrapper from "@/components/RunnerWrapper";
import CharmRunner from "@/components/CharmRunner";

const handleClick = () => {
  console.log("clicked");
};

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

  const handleLoadCounterCharm = async () => {
    try {
      const mod = await import("@/recipes/counter.tsx");
      const counterFactory = mod.default;
      const counterCharm = {
        entityId: `counter-${Date.now()}`,
        name: "Counter Charm",
        ui: counterFactory,
      };
      await runCharm(counterCharm);
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
        onClick={handleLoadCounterCharm}
        className="mt-4 ml-4 px-4 py-2 bg-green-500 text-white rounded"
      >
        Load & Run Counter Charm
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
