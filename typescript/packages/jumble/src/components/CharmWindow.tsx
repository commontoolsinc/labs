import { useEffect } from "react";
import CharmRunner from "@/components/CharmRunner";
import type { DocImpl } from "@commontools/runner";
import { getEntityId } from "@commontools/runner";

export interface CharmWindowProps {
  charm: DocImpl<any>;
  onClose: (charmId: string) => void;
}

export default function CharmWindow({ charm, onClose }: CharmWindowProps) {
  // Use charm.entityId (converted to string) as a unique ID.
  const charmId = JSON.stringify(getEntityId(charm));

  return (
    <div className="window" data-charm-id={charmId}>
      <div className="window-toolbar">
        <h1
          className="window-title"
          onClick={() => {
            // Set focus on this charm if needed.
          }}
        >
          {charm.getAsQueryResult()?.name || "Untitled"}
        </h1>
        <button className="close-button" onClick={() => onClose(charmId)}>
          x
        </button>
      </div>
      <div className="charm">
        <CharmRunner charm={charm} />
      </div>
    </div>
  );
}
