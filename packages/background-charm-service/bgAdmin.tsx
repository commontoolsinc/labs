/// <cts-enable />
import {
  Cell,
  Default,
  derive,
  handler,
  lift,
  NAME,
  pattern,
  UI,
} from "commontools";

const DISABLED_VIA_UI = "Disabled via UI";

type BGCharmEntry = {
  space: string;
  charmId: string;
  integration: string;
  createdAt: number;
  updatedAt: number;
  disabledAt: Default<number, 0>;
  lastRun: Default<number, 0>;
  status: Default<string, "">;
};

type InputSchema = {
  charms: Default<BGCharmEntry[], []>;
};

type ResultSchema = {
  charms: BGCharmEntry[];
};

const deleteCharm = handler<
  never,
  { charms: Cell<BGCharmEntry[]>; charm: Cell<BGCharmEntry> }
>(
  (_, { charm, charms }) => {
    const { space, charmId } = charm.get();
    const newList = charms.get().slice();
    const index = newList.findIndex((i) =>
      i.space === space && i.charmId === charmId
    );
    if (index >= 0 && index < newList.length) {
      newList.splice(index, 1);
      charms.set(newList);
    }
  },
);

const toggleCharm = handler<never, { charm: Cell<BGCharmEntry> }>(
  (_, { charm }) => {
    const data = charm.get();
    if (data.disabledAt) {
      charm.set({ ...data, disabledAt: 0, status: "Initializing..." });
    } else {
      charm.set({ ...data, disabledAt: Date.now(), status: DISABLED_VIA_UI });
    }
  },
);

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

const getRenderData = lift((
  charm: BGCharmEntry,
) => {
  const {
    integration,
    space: rawSpace,
    charmId: rawCharmId,
    createdAt,
    updatedAt,
    disabledAt,
    lastRun,
    status,
  } = charm;
  const space = rawSpace.slice(-4);
  const charmId = rawCharmId.slice(-4);
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

  return {
    statusDisplay,
    disabledAt,
    details,
    integration,
    name,
  };
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

export default pattern<InputSchema, ResultSchema>(
  "BG Admin",
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
            {charms.map((charm) => {
              const {
                details,
                name,
                integration,
                statusDisplay,
              } = getRenderData(charm);
              return (
                <div className="bg-charm-row">
                  <div className="toggle-button">
                    <button
                      onClick={toggleCharm({ charm })}
                      type="button"
                    >
                      {derive(charm, ({ status, disabledAt }) => {
                        const SUCCESS = `#4CAF50`;
                        const UNKNOWN = `#FFC107`;
                        const DISABLED = `#9E9E9E`;
                        const FAILURE = `#F44336`;
                        const statusColor = disabledAt === 0
                          ? status === "Success" ? SUCCESS : UNKNOWN
                          : status === DISABLED_VIA_UI
                          ? DISABLED
                          : FAILURE;
                        const statusTitle =
                          disabledAt === 0 && status === "Success"
                            ? "Running"
                            : status;
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
                      })}
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
            })}
          </div>
        </div>
      ),
      charms,
    };
  },
);
