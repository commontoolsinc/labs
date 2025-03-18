import { h } from "@commontools/html";
import {
  cell,
  derive,
  handler,
  ID,
  JSONSchema,
  NAME,
  recipe,
  Schema,
  str,
  UI,
} from "@commontools/builder";
import { Cell } from "@commontools/runner";

export const CharmEntrySchema = {
  type: "object",
  properties: {
    space: { type: "string" },
    charmId: { type: "string" },
    integration: { type: "string" },
    createdAt: { type: "number" },
    updatedAt: { type: "number" },
    enabled: { type: "boolean" },
    runs: { type: "number", default: 0 },
  },
  required: [
    "space",
    "charmId",
    "integration",
    "createdAt",
    "updatedAt",
    "enabled",
    "runs",
  ],
} as const satisfies JSONSchema;
type CharmEntry = Schema<typeof CharmEntrySchema>;

const InputSchema = {
  type: "object",
  properties: {
    charms: {
      type: "array",
      items: CharmEntrySchema,
      default: [],
    },
  },
} as const satisfies JSONSchema;

const ResultSchema = {
  type: "object",
  properties: {
    charms: {
      type: "array",
      items: CharmEntrySchema,
    },
  },
} as const satisfies JSONSchema;

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
        <div>
          <h1>BG Updater Management</h1>
          <table>
            <thead>
              <tr>
                <th style="padding: 10px;">Space</th>
                <th style="padding: 10px;">Charm ID</th>
                <th style="padding: 10px;">Integration</th>
                <th style="padding: 10px;">Created At</th>
                <th style="padding: 10px;">Updated At</th>
                <th style="padding: 10px;">Enabled</th>
                <th style="padding: 10px;">Runs</th>
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
                  <td style="padding: 10px;">{charm.enabled}</td>
                  <td style="padding: 10px;">{charm.runs}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ),
      charms,
    };
  },
);
