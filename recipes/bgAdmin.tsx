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
          <pre>
            {derive(charms, (charms) => {
              return JSON.stringify(charms, null, 2);
            })}
          </pre>
        </div>
      ),
      charms,
    };
  },
);
