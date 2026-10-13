/**
 * Run with an empty plug cache and NO network: the pinned release can't be
 * resolved, so openSource reports the failure instead of binding. Exercises the
 * download-failure catch in openSource.
 */

import { openSource } from "../../v2/sqlite/native-symbols.ts";
const result = await openSource({ kind: "release" });
console.log(JSON.stringify("problem" in result));
