import * as __ctHelpers from "commontools";
import { cell, derive, lift } from "commontools";
const stage = cell<string>("initial", {
    type: "string"
} as const satisfies __ctHelpers.JSONSchema);
const attemptCount = cell<number>(0, {
    type: "number"
} as const satisfies __ctHelpers.JSONSchema);
const acceptedCount = cell<number>(0, {
    type: "number"
} as const satisfies __ctHelpers.JSONSchema);
const rejectedCount = cell<number>(0, {
    type: "number"
} as const satisfies __ctHelpers.JSONSchema);
// FIXTURE: derive-object-literal-input
// Verifies: cell(), lift(), and derive() all get schemas injected from type annotations
//   cell<string>("initial")             → cell<string>("initial", { type: "string" })
//   lift((value: string) => value)      → lift(inputSchema, outputSchema, fn)
//   derive({ stage, ... }, fn)          → derive(inputSchema, outputSchema, { stage, ... }, fn)
// Context: No export default; first export-relevant statement is the cells/lifts/derive at top level
const normalizedStage = lift({
    type: "string"
} as const satisfies __ctHelpers.JSONSchema, {
    type: "string"
} as const satisfies __ctHelpers.JSONSchema, (value: string) => value)(stage);
const attempts = lift({
    type: "number"
} as const satisfies __ctHelpers.JSONSchema, {
    type: "number"
} as const satisfies __ctHelpers.JSONSchema, (count: number) => count)(attemptCount);
const accepted = lift({
    type: "number"
} as const satisfies __ctHelpers.JSONSchema, {
    type: "number"
} as const satisfies __ctHelpers.JSONSchema, (count: number) => count)(acceptedCount);
const rejected = lift({
    type: "number"
} as const satisfies __ctHelpers.JSONSchema, {
    type: "number"
} as const satisfies __ctHelpers.JSONSchema, (count: number) => count)(rejectedCount);
const _summary = derive({
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
} as const satisfies __ctHelpers.JSONSchema, {
    type: "string"
} as const satisfies __ctHelpers.JSONSchema, {
    stage: normalizedStage,
    attempts: attempts,
    accepted: accepted,
    rejected: rejected,
}, (snapshot) => `stage:${snapshot.stage} attempts:${snapshot.attempts}` +
    ` accepted:${snapshot.accepted} rejected:${snapshot.rejected}`);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
