/// <cts-enable />
import { derive, JSONSchema, NAME, pattern } from "commontools";

const ExtractListsInputSchema = {
  type: "object",
  properties: {
    allCharms: {
      type: "array",
      items: {},
      default: [],
    },
  },
  required: ["allCharms"],
} as const satisfies JSONSchema;

const ExtractListsOutputSchema = {
  type: "object",
  properties: {
    lists: {
      type: "array",
      items: {},
    },
  },
  required: ["lists"],
} as const satisfies JSONSchema;

export default pattern(
  ExtractListsInputSchema,
  ExtractListsOutputSchema,
  ({ allCharms }: any) => {
    const results = derive(allCharms, (cs: any[] | undefined) => {
      return cs?.reduce(
        (
          acc: { path: (string | number)[]; node: any }[],
          charm: any,
        ) => {
          if (charm && typeof charm === "object") {
            if (Array.isArray(charm.items)) {
              acc.push(charm);
            }
          }
          return acc;
        },
        [],
      ) || [];
    });
    return {
      lists: results,
      [NAME]: "All Lists",
    };
  },
);
