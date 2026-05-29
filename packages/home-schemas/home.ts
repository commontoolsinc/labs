import { favoriteEntrySchema, favoriteListSchema } from "./favorites.ts";
import { spacesListSchema } from "./spaces.ts";
import type { JSONSchema } from "@commonfabric/api";
import type { Schema } from "@commonfabric/api/schema";

export const homeSchema = {
  type: "object",
  properties: {
    favorites: favoriteListSchema,
    spaces: spacesListSchema,
    defaultAppUrl: { type: "string", default: "" },
    addFavorite: { ...favoriteEntrySchema, asCell: ["stream"] },
    removeFavorite: { ...favoriteEntrySchema, asCell: ["stream"] },
  },
} as const satisfies JSONSchema;

export type Home = Schema<typeof homeSchema>;
