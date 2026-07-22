import {
  type Cell,
  computed,
  type Default,
  handler,
  lift,
  NAME,
  pattern,
  UI,
} from "commonfabric";

export const DISABLED_VIA_UI = "Disabled via UI";

export type BGPieceEntry = {
  space: string;
  pieceId: string;
  integration: string;
  createdAt: number;
  updatedAt: number;
  disabledAt: Default<number, 0>;
  lastRun: Default<number, 0>;
  status: Default<string, "">;
};

type InputSchema = {
  pieces: Default<BGPieceEntry[], []>;
};

type ResultSchema = {
  pieces: BGPieceEntry[];
};

export function removePieceFromList(
  list: readonly BGPieceEntry[],
  piece: Pick<BGPieceEntry, "space" | "pieceId">,
): readonly BGPieceEntry[] {
  const index = list.findIndex((i) =>
    i.space === piece.space && i.pieceId === piece.pieceId
  );
  if (index < 0 || index >= list.length) {
    return list;
  }
  const newList = list.slice();
  newList.splice(index, 1);
  return newList;
}

export function toggledPiece(piece: BGPieceEntry): BGPieceEntry {
  if (piece.disabledAt) {
    return { ...piece, disabledAt: 0, status: "Initializing..." };
  }
  return { ...piece, disabledAt: Date.now(), status: DISABLED_VIA_UI };
}

export const deletePiece = handler<
  never,
  { pieces: Cell<BGPieceEntry[]>; piece: Cell<BGPieceEntry> }
>(
  (_, { piece, pieces }) => {
    const currentPieces = pieces.get();
    const nextPieces = removePieceFromList(currentPieces, piece.get());
    if (nextPieces !== currentPieces) {
      pieces.set(nextPieces as BGPieceEntry[]);
    }
  },
  { proxy: true },
);

export const togglePiece = handler<never, { piece: Cell<BGPieceEntry> }>(
  (_, { piece }) => {
    piece.set(toggledPiece(piece.get()));
  },
  { proxy: true },
);

// Minimal "moment" style formatting to get a string
// representation of an (older) date relative to now,
// e.g. "5 seconds ago".
// * Renders "in the future" for all times in the future,
//   we don't currently need e.g. "5 seconds from now".
// * Disregard plural units, "1 minutes ago" is fine.
// * Timezones are hard. Could maybe render "0 years ago".
export function fromNow(then: Date, now: Date = new Date()): string {
  const diffSeconds = Math.floor((now.getTime() - then.getTime()) / 1000);
  if (diffSeconds < 0) return "in the future";
  if (diffSeconds === 0) return "now";
  if (diffSeconds < 60) return `${diffSeconds} seconds ago`;

  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes} minutes ago`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours} hours ago`;

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 365) return `${Math.floor(diffDays)} days ago`;

  return `${Math.floor(diffDays / 365)} years ago`;
}

export function renderDataForPiece(
  piece: BGPieceEntry,
  now: Date = new Date(),
) {
  const {
    integration,
    space: rawSpace,
    pieceId: rawPieceId,
    createdAt,
    updatedAt,
    disabledAt,
    lastRun,
    status,
  } = piece;
  const space = rawSpace.slice(-4);
  const pieceId = rawPieceId.slice(-4);
  const name = `#${space}/#${pieceId}`;

  const createdAtDate = new Date(createdAt);
  const updatedAtDate = new Date(updatedAt);
  const lastRunDate = lastRun ? new Date(lastRun) : null;
  const isSuccessful = status === "Success";
  const statusDisplay = isSuccessful ? "" : status;
  const details = `Created ${
    fromNow(createdAtDate, now)
  } (${createdAtDate.toLocaleString()})
Updated ${fromNow(updatedAtDate, now)} (${updatedAtDate.toLocaleString()})
Last run ${lastRunDate ? fromNow(lastRunDate, now) : "never"} ${
    lastRunDate ? `(${lastRunDate.toLocaleString()})` : ""
  }`;

  return {
    statusDisplay,
    disabledAt,
    details,
    integration,
    name,
  };
}

export function statusIndicatorData(
  status: string,
  disabledAt: number,
): { statusColor: string; statusTitle: string } {
  const SUCCESS = `#4CAF50`;
  const UNKNOWN = `#FFC107`;
  const DISABLED = `#9E9E9E`;
  const FAILURE = `#F44336`;
  const statusColor = disabledAt === 0
    ? status === "Success" ? SUCCESS : UNKNOWN
    : status === DISABLED_VIA_UI
    ? DISABLED
    : FAILURE;
  const statusTitle = disabledAt === 0 && status === "Success"
    ? "Running"
    : status;
  return { statusColor, statusTitle };
}

export function statusIndicator(status: string, disabledAt: number) {
  const { statusColor, statusTitle } = statusIndicatorData(status, disabledAt);
  return (
    <div
      title={statusTitle}
      style={{
        backgroundColor: statusColor,
        width: "20px",
        height: "20px",
        borderRadius: "20px",
      }}
    >
    </div>
  );
}

export const getRenderData = lift(renderDataForPiece);

const css = `
.bg-piece-container {
  display: flex;
  flex-direction: column;
}
.bg-piece-container .ellipsis {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis; 
}
.bg-piece-container button {
  cursor: pointer;
}
.bg-piece-row {
  display: flex;
  flex-direction: row;
  height: 50px;
  align-items: center;
}
.bg-piece-row > * {
  padding: 10px;
}
.bg-piece-row .toggle-button, .bg-piece-row .delete {
  flex: 0;
  display: flex;
}
.bg-piece-row .name {
  width: 250px;
  cursor: help;
}
.bg-piece-row .integration {
  color: #aaa;
  padding-left: 3px;
}
.bg-piece-row .status {
  flex: 1;
}
.bg-piece-container .delete button {
  border: 1px solid black;
}
`;

export const pieceRowPattern = pattern<
  { piece: BGPieceEntry; pieces: BGPieceEntry[] }
>(({ piece, pieces }) => {
  const {
    details,
    name,
    integration,
    statusDisplay,
  } = getRenderData(piece);
  return (
    <div className="bg-piece-row">
      <div className="toggle-button">
        <button
          onClick={togglePiece({ piece })}
          type="button"
        >
          {computed(() => statusIndicator(piece.status, piece.disabledAt))}
        </button>
      </div>
      <div className="name ellipsis" title={details}>
        {name}
        <span className="integration">{integration}</span>
      </div>
      <div className="status ellipsis">{statusDisplay}</div>
      <div className="delete">
        <button
          onClick={deletePiece({ piece, pieces })}
          type="button"
        >
          Delete
        </button>
      </div>
    </div>
  );
});

export default pattern<InputSchema, ResultSchema>(
  ({ pieces }) => {
    computed(() => console.log("bg piece list:", pieces));
    return {
      [NAME]: "BG Updater Management New",
      [UI]: (
        <div>
          <style>{css}</style>
          <div className="bg-piece-container">
            {pieces.map((piece) => pieceRowPattern({ piece, pieces }))}
          </div>
        </div>
      ),
      pieces,
    };
  },
);
