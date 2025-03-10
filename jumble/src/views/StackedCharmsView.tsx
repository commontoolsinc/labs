import React from "react";
import { useParams } from "react-router-dom";
import { LoadingSpinner } from "@/components/Loader.tsx";
import { useCharm, useCharms } from "@/hooks/use-charm.ts";
import { CharmRenderer } from "@/components/CharmRunner.tsx";
import { charmId } from "@/utils/charms.ts";

function StackedCharmsView() {
  const { charmIds: paramCharmIds } = useParams();
  const charmIds = React.useMemo(() => {
    return paramCharmIds?.split(",").filter((id) => id.trim() !== "") || [];
  }, [paramCharmIds]);

  if (!charmIds || charmIds.length === 0) {
    throw new Error("Missing charmIds");
  }

  const { charms } = useCharms(...charmIds);

  if (!charms || charms.length === 0) {
    return (
      <div className="max-w-xl mx-auto">
        <LoadingSpinner visible />
      </div>
    );
  }

  return (
    <div className="h-full">
      <div className="flex flex-row w-full h-full p-2">
        {charms.map((charm, index) => (
          <React.Fragment key={charmId(charm)}>
            {index > 0 && <div className="w-px bg-gray-300 mx-2 h-full"></div>}
            <CharmRenderer
              className="h-full min-w-[512px]"
              charm={charm}
            />
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

export default StackedCharmsView;
