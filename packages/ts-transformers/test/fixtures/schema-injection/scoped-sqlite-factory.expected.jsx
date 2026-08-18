function __cfBindVerifiedBinding(value: any, metadata: any) {
    if (value && (typeof value === "object" || typeof value === "function") && Object.isExtensible(value)) {
        Object.defineProperty(value, "__cfVerifiedBindingIdentity", {
            value: metadata,
            configurable: true
        });
    }
    if (value && (typeof value === "object" || typeof value === "function") && typeof value.implementation === "function") {
        var implementation = value.implementation;
        if (implementation && (typeof implementation === "object" || typeof implementation === "function") && Object.isExtensible(implementation)) {
            Object.defineProperty(implementation, "__cfVerifiedBindingIdentity", {
                value: metadata,
                configurable: true
            });
        }
    }
    return value;
}
function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { pattern, type PerSession, type PerUser, type SqliteDb, sqliteDatabase, table, } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Input {
    seed?: string;
}
// A SqliteDb declared with a scope wrapper must lower to `sqliteDatabase
// .asScope(<scope>)(...)`, so the runtime binds the db (and its on-disk file)
// to that scope. `sqliteDatabase` is an opaque factory (its public type is
// `(...) => Reactive<SqliteDb>` plus an `asScope` method, with no
// argumentSchema/resultSchema), so this exercises the asScope-method path of
// the contextual-scope lowering.
export default __cfBindVerifiedBinding(pattern(() => {
    const userDb: PerUser<SqliteDb> = sqliteDatabase.asScope("user")({
        tables: { notes: table({ id: "integer primary key", body: "text" }) },
    }).for("userDb", true);
    const sessionDb: PerSession<SqliteDb> = sqliteDatabase.asScope("session")({ tables: {} }).for("sessionDb", true);
    const spaceDb = sqliteDatabase({ tables: {} }).for("spaceDb", true);
    return { userDb: userDb.for(["__patternResult", "userDb"], true), sessionDb: sessionDb.for(["__patternResult", "sessionDb"], true), spaceDb: spaceDb.for(["__patternResult", "spaceDb"], true) };
}, {
    type: "object",
    properties: {
        seed: {
            type: "string"
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        userDb: {
            $ref: "#/$defs/SqliteDatabase",
            asCell: [{
                    kind: "sqlite",
                    scope: "user"
                }]
        },
        sessionDb: {
            $ref: "#/$defs/SqliteDatabase",
            asCell: [{
                    kind: "sqlite",
                    scope: "session"
                }]
        },
        spaceDb: {
            $ref: "#/$defs/SqliteDatabase",
            asCell: ["sqlite"]
        }
    },
    required: ["userDb", "sessionDb", "spaceDb"],
    $defs: {
        SqliteDatabase: {
            type: "object",
            properties: {}
        }
    }
} as const satisfies __cfHelpers.JSONSchema), {
    sourceFile: "/test.tsx",
    position: { line: 21, col: 30 }
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
