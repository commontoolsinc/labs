/**
 * Home space schemas package.
 *
 * Contains schema definitions for home space data structures:
 * - Favorites: user's favorited pieces
 * - Spaces: user's managed spaces list
 *
 * This package exists to break the circular dependency between
 * @commonfabric/runner and @commonfabric/piece. Both packages can
 * safely import schemas from here.
 */

import { JSONSchema } from "@commonfabric/api";
import { Schema } from "@commonfabric/api/schema";

export {
  type FavoriteEntry,
  favoriteEntrySchema,
  type FavoriteList,
  favoriteListSchema,
} from "./favorites.ts";

export {
  type SpaceEntry,
  spaceEntrySchema,
  type SpacesList,
  spacesListSchema,
} from "./spaces.ts";

export { type Home, homeSchema } from "./home.ts";

export const objectStubSchema = {
  type: "unknown",
} as const satisfies JSONSchema;
export type ObjectStub = Schema<typeof objectStubSchema>;
