/**
 * Stands in for a service process that dies holding a chat session store. It
 * holds the SQLite store at the path given as its first argument, as the
 * instance named by its second, reports the outcome on stdout as one JSON
 * line, and then stays alive — holding — until its stdin closes or it is
 * killed.
 */

import { toFileUrl } from "@std/path";

import { openSqliteHarnessChatSessionStore } from "../../src/sqlite-session-store.ts";

const [path, instanceId] = Deno.args;
const store = await openSqliteHarnessChatSessionStore({
  url: toFileUrl(path),
});
const outcome = await store.hold({
  instanceId,
  pid: Deno.pid,
  heldSince: new Date().toISOString(),
});
console.log(JSON.stringify(outcome));
for await (const _chunk of Deno.stdin.readable) {
  // Nothing arrives on stdin; the pending read is what keeps this process
  // alive.
}
