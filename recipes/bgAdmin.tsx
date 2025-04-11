import { h } from "@commontools/html";
import {
  derive,
  handler,
  JSONSchema,
  NAME,
  recipe,
  Schema,
  UI,
} from "@commontools/builder";

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
} as const as JSONSchema;
type BGCharmEntry = Schema<typeof BGCharmEntrySchema>;

const InputSchema = {
  type: "object",
  properties: {
    charms: {
      type: "array",
      items: BGCharmEntrySchema,
      default: [],
    },
  },
} as const as JSONSchema;

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
  charm.disabledAt = charm.disabledAt ? undefined : Date.now();
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

const css = `
table th {
  padding: 10px;
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
          <os-container>
            <table>
              <thead>
                <tr>
                  <th>Space</th>
                  <th>Charm ID</th>
                  <th>Integration</th>
                  <th>Created At</th>
                  <th>Updated At</th>
                  <th>Last Run</th>
                  <th>Status</th>
                  <th>Disabled</th>
                  <th>Delete</th>
                </tr>
              </thead>
              <tbody>
                {charms.map((charm) => (
                  <tr>
                    <td>
                      #{derive(charm, (charm) => charm.space.slice(-4))}
                    </td>
                    <td>
                      #{derive(charm, (charm) => charm.charmId.slice(-4))}
                    </td>
                    <td>{charm.integration}</td>
                    <td
                      title={derive(
                        charm,
                        (charm) => new Date(charm.createdAt).toLocaleString(),
                      )}
                    >
                      {derive(
                        charm,
                        (charm) => fromNow(new Date(charm.createdAt)),
                      )}
                    </td>
                    <td
                      title={derive(
                        charm,
                        (charm) => new Date(charm.updatedAt).toLocaleString(),
                      )}
                    >
                      {derive(
                        charm,
                        (charm) => fromNow(new Date(charm.updatedAt)),
                      )}
                    </td>

                    <td
                      title={derive(
                        charm,
                        (charm) => new Date(charm.lastRun).toLocaleString(),
                      )}
                    >
                      {derive(
                        charm,
                        (charm) =>
                          charm.lastRun
                            ? fromNow(new Date(charm.lastRun))
                            : "never",
                      )}
                    </td>
                    <td>{charm.status}</td>
                    <td
                      title={derive(
                        charm,
                        (charm) =>
                          charm.disabledAt
                            ? new Date(charm.disabledAt).toLocaleString()
                            : undefined,
                      )}
                    >
                      {derive(
                        charm,
                        (charm) =>
                          charm.disabledAt
                            ? fromNow(new Date(charm.disabledAt))
                            : "enabled",
                      )}&nbsp;
                      <button
                        onClick={toggleCharm({ charm })}
                        type="button"
                      >
                        {derive(
                          charm,
                          (charm) => charm.disabledAt ? "enable" : "disable",
                        )}
                      </button>
                    </td>
                    <td>
                      <button
                        onClick={deleteCharm({ charm, charms })}
                        type="button"
                      >
                        {/* https://fonts.google.com/icons?selected=Material+Symbols+Outlined:delete */}
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          height="24px"
                          viewBox="0 -960 960 960"
                          width="24px"
                          fill="#e3e3e3"
                        >
                          <path d="M280-120q-33 0-56.5-23.5T200-200v-520h-40v-80h200v-40h240v40h200v80h-40v520q0 33-23.5 56.5T680-120H280Zm400-600H280v520h400v-520ZM360-280h80v-360h-80v360Zm160 0h80v-360h-80v360ZM280-720v520-520Z" />
                        </svg>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </os-container>
        </div>
      ),
      charms,
    };
  },
);
