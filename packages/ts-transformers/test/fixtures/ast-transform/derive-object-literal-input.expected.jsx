function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { cell, derive, lift } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const stage = __cfHelpers.__cf_data(cell<string>("initial", {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema).for("stage", true));
const attemptCount = __cfHelpers.__cf_data(cell<number>(0, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema).for("attemptCount", true));
const acceptedCount = __cfHelpers.__cf_data(cell<number>(0, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema).for("acceptedCount", true));
const rejectedCount = __cfHelpers.__cf_data(cell<number>(0, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema).for("rejectedCount", true));
// FIXTURE: derive-object-literal-input
// Verifies: cell(), lift(), and derive() all get schemas injected from type annotations
//   cell<string>("initial")             → cell<string>("initial", { type: "string" })
//   lift((value: string) => value)      → lift(inputSchema, outputSchema, fn)
//   derive({ stage, ... }, fn)          → derive(inputSchema, outputSchema, { stage, ... }, fn)
// Context: No export default; first export-relevant statement is the cells/lifts/derive at top level
const normalizedStage = __cfHelpers.__cf_data(lift({
    type: "string"
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema, (value: string) => value)(stage).for("normalizedStage", true));
const attempts = __cfHelpers.__cf_data(lift({
    type: "number"
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema, (count: number) => count)(attemptCount).for("attempts", true));
const accepted = __cfHelpers.__cf_data(lift({
    type: "number"
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema, (count: number) => count)(acceptedCount).for("accepted", true));
const rejected = __cfHelpers.__cf_data(lift({
    type: "number"
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema, (count: number) => count)(rejectedCount).for("rejected", true));
const _summary = __cfHelpers.__cf_data(derive({
    type: "object",
    properties: {
        stage: {
            type: "string"
        },
        attempts: {
            type: "number"
        },
        accepted: {
            type: "number"
        },
        rejected: {
            type: "number"
        }
    },
    required: ["stage", "attempts", "accepted", "rejected"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema, {
    stage: normalizedStage.for(["_summary", 2, "stage"], true),
    attempts: attempts.for(["_summary", 2, "attempts"], true),
    accepted: accepted.for(["_summary", 2, "accepted"], true),
    rejected: rejected.for(["_summary", 2, "rejected"], true)
}, (snapshot) => `stage:${snapshot.stage} attempts:${snapshot.attempts}` +
    ` accepted:${snapshot.accepted} rejected:${snapshot.rejected}`).for("_summary", true));
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
