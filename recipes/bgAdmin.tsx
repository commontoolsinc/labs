import {
  derive,
  h,
  handler,
  JSONSchema,
  lift,
  Mutable,
  NAME,
  recipe,
  Schema,
  UI,
} from "commontools";

const DISABLED_VIA_UI = "Disabled via UI";

// NOTE(ja): this must be the same as the schema in background-charm-service/src/schema.ts
const BGCharmEntrySchema = {
  type: "object",
  properties: {
    space: { type: "string" },
    charmId: { type: "string" },
    integration: { type: "string" },
    createdAt: { type: "number" },
    updatedAt: { type: "number" },
    disabledAt: { type: "number", default: 0 },
    lastRun: { type: "number", default: 0 },
    status: { type: "string", default: "" },
  },
  required: [
    "space",
    "charmId",
    "integration",
    "createdAt",
    "updatedAt",
    "lastRun",
    "status",
  ],
} as const satisfies JSONSchema;
type BGCharmEntry = Mutable<Schema<typeof BGCharmEntrySchema>>;

const BGCharmEntriesSchema = {
  type: "array",
  items: BGCharmEntrySchema,
  default: [],
} as const satisfies JSONSchema;
type BGCharmEntries = Schema<typeof BGCharmEntriesSchema>;

const InputSchema = {
  type: "object",
  properties: {
    charms: BGCharmEntriesSchema,
  },
} as const satisfies JSONSchema;

const ResultSchema = {
  type: "object",
  properties: {
    charms: {
      type: "array",
      items: BGCharmEntrySchema,
    },
  },
} as const satisfies JSONSchema;

const deleteCharm = handler<
  never,
  { charms: BGCharmEntry[]; charm: BGCharmEntry }
>(
  (_, { charm, charms }) => {
    const idx = charms.findIndex((i) =>
      i.space === charm.space && i.charmId === charm.charmId
    );
    if (idx !== -1) charms.splice(idx, 1);
  },
);

const toggleCharm = handler<never, { charm: BGCharmEntry }>((_, { charm }) => {
  if (charm.disabledAt) {
    charm.disabledAt = undefined;
    charm.status = "Initializing...";
  } else {
    charm.disabledAt = Date.now();
    charm.status = DISABLED_VIA_UI;
  }
});

// Minimal "moment" style formatting to get a string
// representation of an (older) date relative to now,
// e.g. "5 seconds ago".
// * Renders "in the future" for all times in the future,
//   we don't currently need e.g. "5 seconds from now".
// * Disregard plural units, "1 minutes ago" is fine.
// * Timezones are hard. Could maybe render "0 years ago".
function fromNow(then: Date): string {
  const now = new Date();
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

  return `${Math.floor(then.getFullYear() - now.getFullYear())} `;
}

function StatusIcon(
  { status, disabledAt }: { status?: string; disabledAt?: number },
) {
  let color;
  let title = status;
  const SUCCESS = `#4CAF50`;
  const UNKNOWN = `#FFC107`;
  const DISABLED = `#9E9E9E`;
  const FAILURE = `#F44336`;
  if (!disabledAt) {
    if (status === "Success") {
      color = SUCCESS;
      title = "Running";
    } else {
      color = UNKNOWN;
    }
  } else {
    if (status === DISABLED_VIA_UI) {
      color = DISABLED;
    } else {
      color = FAILURE;
    }
  }
  return (
    <div
      title={title}
      style={`background-color: ${color}; width: 20px; height: 20px; border-radius: 20px`}
    >
    </div>
  );
}

const BGCharmRow = lift((
  { charm, charms }: { charm: BGCharmEntry; charms: BGCharmEntries },
) => {
  const { integration, createdAt, updatedAt, disabledAt, lastRun, status } =
    charm;
  const space = charm.space.slice(-4);
  const charmId = charm.charmId.slice(-4);
  const name = `#${space}/#${charmId}`;

  const createdAtDate = new Date(createdAt);
  const updatedAtDate = new Date(updatedAt);
  const lastRunDate = lastRun ? new Date(lastRun) : null;
  const isSuccessful = status === "Success";
  const statusDisplay = isSuccessful ? "" : status;
  const details = `Created ${
    fromNow(createdAtDate)
  } (${createdAtDate.toLocaleString()})
Updated ${fromNow(updatedAtDate)} (${updatedAtDate.toLocaleString()})
Last run ${lastRunDate ? fromNow(lastRunDate) : "never"} ${
    lastRunDate ? `(${lastRunDate.toLocaleString()})` : ""
  }`;

  return (
    <div className="bg-charm-row">
      <div className="toggle-button">
        <button
          onClick={toggleCharm({ charm })}
          type="button"
        >
          <StatusIcon status={status} disabledAt={disabledAt}></StatusIcon>
        </button>
      </div>
      <div className="name ellipsis" title={details}>
        {name}
        <span className="integration">{integration}</span>
      </div>
      <div className="status ellipsis">{statusDisplay}</div>
      <div className="delete">
        <button
          onClick={deleteCharm({ charm, charms })}
          type="button"
        >
          Delete
        </button>
      </div>
    </div>
  );
});

const css = `
.bg-charm-container {
  display: flex;
  flex-direction: column;
}
.bg-charm-container .ellipsis {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis; 
}
.bg-charm-container button {
  cursor: pointer;
}
.bg-charm-row {
  display: flex;
  flex-direction: row;
  height: 50px;
  align-items: center;
}
.bg-charm-row > * {
  padding: 10px;
}
.bg-charm-row .toggle-button, .bg-charm-row .delete {
  flex: 0;
  display: flex;
}
.bg-charm-row .name {
  width: 250px;
  cursor: help;
}
.bg-charm-row .integration {
  color: #aaa;
  padding-left: 3px;
}
.bg-charm-row .status {
  flex: 1;
}
.bg-charm-container .delete button {
  border: 1px solid black;
}
`;

export default recipe(
  InputSchema,
  ResultSchema,
  ({ charms }) => {
    derive(charms, (charms) => {
      console.log("bg charm list:", charms);
    });
    return {
      [NAME]: "BG Updater Management New",
      [UI]: (
        <div>
          <style>{css}</style>
          <div className="bg-charm-container">
            {charms.map((charm) => (
              <BGCharmRow
                charms={charms}
                charm={charm}
              >
              </BGCharmRow>
            ))}
          </div>
        </div>
      ),
      charms,
    };
  },
);
