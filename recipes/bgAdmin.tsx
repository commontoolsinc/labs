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

const BGCharmEntrySchema = {
  type: "object",
  properties: {
    space: { type: "string" },
    charmId: { type: "string" },
    integration: { type: "string" },
    createdAt: { type: "number" },
    updatedAt: { type: "number" },
    disabledAt: { type: "number" },
    lastRun: { type: "number" },
    status: { type: "string" },
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

export default recipe(
  InputSchema,
  ResultSchema,
  ({ charms }) => {
    derive(charms, (charms) => {
      console.log("bg charm list:", charms);
    });
    return {
      [NAME]: "BG Updater Management",
      [UI]: (
        <os-container>
          <table>
            <thead>
              <tr>
                <th style="padding: 10px;">Space</th>
                <th style="padding: 10px;">Charm ID</th>
                <th style="padding: 10px;">Integration</th>
                <th style="padding: 10px;">Created At</th>
                <th style="padding: 10px;">Updated At</th>
                <th style="padding: 10px;">Last Run</th>
                <th style="padding: 10px;">Status</th>
                <th style="padding: 10px;">Disabled</th>
                <th style="padding: 10px;">Delete</th>
              </tr>
            </thead>
            <tbody>
              {charms.map((charm) => (
                <tr>
                  <td style="padding: 10px;">
                    #{derive(charm, (charm) => charm.space.slice(-4))}
                  </td>
                  <td style="padding: 10px;">
                    #{derive(charm, (charm) => charm.charmId.slice(-4))}
                  </td>
                  <td style="padding: 10px;">{charm.integration}</td>
                  <td style="padding: 10px;">
                    {derive(
                      charm,
                      (charm) => new Date(charm.createdAt).toLocaleString(),
                    )}
                  </td>
                  <td style="padding: 10px;">
                    {derive(
                      charm,
                      (charm) => new Date(charm.updatedAt).toLocaleString(),
                    )}
                  </td>

                  <td style="padding: 10px;">
                    {derive(
                      charm,
                      (charm) =>
                        charm.lastRun
                          ? new Date(charm.lastRun).toLocaleString()
                          : "never",
                    )}
                  </td>
                  <td style="padding: 10px;">{charm.status}</td>
                  <td style="padding: 10px;">
                    {derive(
                      charm,
                      (charm) =>
                        charm.disabledAt
                          ? new Date(charm.disabledAt).toLocaleString()
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
                  <td style="padding: 10px;">
                    <button
                      onClick={deleteCharm({ charm, charms })}
                      type="button"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </os-container>
      ),
      charms,
    };
  },
);
