import React from "react";
import { useParams } from "react-router-dom";
import { type StackedCharmsRouteParams } from "@/routes.ts";
import { LoadingSpinner } from "@/components/Loader.tsx";
import { useCharms } from "@/hooks/use-charm.ts";
import { CharmRenderer } from "@/components/CharmRunner.tsx";
import { charmId } from "@/utils/charms.ts";

function StackedCharmsView() {
  const { charmIds: paramCharmIds } = useParams<StackedCharmsRouteParams>();
  const charmIds = React.useMemo(() => {
    return paramCharmIds?.split(",").filter((id: string) => id.trim() !== "") ||
      [];
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
          <React.Fragment
            key={charm ? charmId(charm) : `missing-charm-${index}`}
          >
            {index > 0 && <div className="w-px bg-gray-300 mx-2 h-full"></div>}
            {charm && (
              <CharmRenderer
                className="h-full min-w-[512px]"
                charm={charm}
              />
            )}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

export default StackedCharmsView;
