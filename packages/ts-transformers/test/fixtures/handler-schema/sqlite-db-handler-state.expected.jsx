function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { handler, SqliteDb } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface DbState {
    db: SqliteDb;
}
// FIXTURE: sqlite-db-handler-state
// Verifies: a SqliteDb-typed handler-state field lowers to { asCell: ["sqlite"] }
// (the brand recognition added to the schema-generator), so the runtime delivers
// a "sqlite"-kind cell on which db.exec(...) is valid.
const writeNote = handler({
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        db: {
            asCell: ["readonly"]
        }
    },
    required: ["db"]
} as const satisfies __cfHelpers.JSONSchema, (_, { db }) => {
    db.exec("INSERT INTO notes (body) VALUES (?)", ["hi"]);
});
export { writeNote };
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
