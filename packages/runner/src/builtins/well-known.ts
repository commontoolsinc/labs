/**
 * Well-known entity IDs and patterns used by built-in functions.
 */

/**
 * Well-known entity ID for the all charms list.
 */
export const ALL_CHARMS_ID =
  "baedreiahv63wxwgaem4hzjkizl4qncfgvca7pj5cvdon7cukumfon3ioye";

/**
 * Favorites are accessed via wish("#favorites") which resolves to
 * the favorites field in the HOME SPACE's spaceCell.
 *
 * Home space = the SINGULAR space where space DID equals user identity DID
 * (runtime.storageManager.as.did()).
 *
 * There is ONE and ONLY ONE favorites list per user, regardless of how many
 * spaces they access. The favorites list is a singleton that persists with
 * the user's identity and works across all spaces.
 */
