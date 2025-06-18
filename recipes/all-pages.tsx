import { h } from "@commontools/html";
import { derive, JSONSchema, NAME, recipe } from "commontools";

const ExtractPagesInputSchema = {
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

const ExtractPagesOutputSchema = {
  type: "object",
  properties: {
    pages: {
      type: "array",
      items: {},
    },
  },
  required: ["pages"],
} as const satisfies JSONSchema;

export default recipe(
  ExtractPagesInputSchema,
  ExtractPagesOutputSchema,
  ({ allCharms }) => {
    const results = derive(allCharms, (cs: any[] | undefined) => {
      return cs?.reduce(
        (
          acc: { path: (string | number)[]; node: any }[],
          charm: any,
          charmIndex: number,
        ) => {
          if (charm && typeof charm === "object") {
            if (
              Array.isArray(charm.lists) && Array.isArray(charm.pages) &&
              Array.isArray(charm.tags) && charm.title
            ) {
              acc.push(charm);
            }
          }
          return acc;
        },
        [],
      ) || [];
    });
    return {
      pages: results,
      [NAME]: "All Pages",
    };
  },
);
