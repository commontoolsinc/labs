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

const IntegrationSpaceCharmSchema = {
  type: "object",
  properties: {
    space: { type: "string" },
    charmId: { type: "string" },
  },
} as const satisfies JSONSchema;
type IntegrationSpaceCell = Schema<typeof IntegrationSpaceCharmSchema>;

const InputSchema = {
  type: "object",
  properties: {
    charms: { type: "array", items: IntegrationSpaceCharmSchema },
  },
} as const satisfies JSONSchema;

const ResultSchema = {
  type: "object",
  properties: {
    charms: {
      type: "array",
      items: IntegrationSpaceCharmSchema,
    },
  },
} as const satisfies JSONSchema;

export default recipe(
  InputSchema,
  ResultSchema,
  ({ charms }) => {
    derive(charms, (charms) => {
      console.log("charms", charms);
    });
    return {
      [NAME]: "Google Integration Management 2",
      [UI]: (
        <div>
          <h1>Google Integration Management</h1>
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
