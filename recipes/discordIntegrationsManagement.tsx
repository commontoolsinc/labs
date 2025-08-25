import { derive, h, JSONSchema, NAME, recipe, Schema, UI } from "commontools";

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
      [NAME]: "Discord Integration Management",
      [UI]: (
        <div>
          <h1>Discord Integration Management</h1>
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
