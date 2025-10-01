import { cell, derive, lift, JSONSchema } from "commontools";
const stage = cell<string>("initial");
const attemptCount = cell<number>(0);
const acceptedCount = cell<number>(0);
const rejectedCount = cell<number>(0);
const normalizedStage = lift({
    type: "string"
} as const satisfies JSONSchema, {
    type: "string"
} as const satisfies JSONSchema, (value: string) => value)(stage);
const attempts = lift({
    type: "number"
} as const satisfies JSONSchema, {
    type: "number"
} as const satisfies JSONSchema, (count: number) => count)(attemptCount);
const accepted = lift({
    type: "number"
} as const satisfies JSONSchema, {
    type: "number"
} as const satisfies JSONSchema, (count: number) => count)(acceptedCount);
const rejected = lift({
    type: "number"
} as const satisfies JSONSchema, {
    type: "number"
} as const satisfies JSONSchema, (count: number) => count)(rejectedCount);
const summary = derive({
    type: "object",
    properties: {
        stage: {
            type: "string",
            asOpaque: true
        },
        attempts: {
            type: "number",
            asOpaque: true
        },
        accepted: {
            type: "number",
            asOpaque: true
        },
        rejected: {
            type: "number",
            asOpaque: true
        }
    },
    required: ["stage", "attempts", "accepted", "rejected"]
} as const satisfies JSONSchema, {
    type: "string"
} as const satisfies JSONSchema, {
    stage: normalizedStage,
    attempts: attempts,
    accepted: accepted,
    rejected: rejected,
}, (snapshot) => `stage:${snapshot.stage} attempts:${snapshot.attempts}` +
    ` accepted:${snapshot.accepted} rejected:${snapshot.rejected}`);
