import * as __ctHelpers from "commontools";
import { pattern } from "commontools";
declare function fetchAny(): any;
// FIXTURE: pattern-any-result-structural-recovery
// Verifies: inferred pattern results can still emit concrete object schemas when
// `any` only appears in nested properties.
//   pattern<Input>(fn) → pattern(fn, inputSchema, objectResultSchema)
// Context: the top-level result stays structural, but `title` degrades to `true`.
export default pattern((__ct_pattern_input) => {
    const prompt = __ct_pattern_input.key("prompt");
    return { title: fetchAny().title, prompt };
}, {
    type: "object",
    properties: {
        prompt: {
            type: "string"
        }
    },
    required: ["prompt"]
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        title: true,
        prompt: {
            type: "string"
        }
    },
    required: ["title", "prompt"]
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
