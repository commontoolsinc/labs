import * as __ctHelpers from "commontools";
import { toSchema } from "commontools";
interface LinkedData {
    "@link": string;
    "@context": string;
    "@type": string;
    "kebab-case": number;
    "with space": boolean;
    "with-special-chars!": string;
    "default": string;
    "enum": number;
    "class": boolean;
    normalProperty: string;
}
const linkedDataSchema = {
    type: "object",
    properties: {
        "@link": {
            type: "string"
        },
        "@context": {
            type: "string"
        },
        "@type": {
            type: "string"
        },
        "kebab-case": {
            type: "number"
        },
        "with space": {
            type: "boolean"
        },
        "with-special-chars!": {
            type: "string"
        },
        "default": {
            type: "string"
        },
        "enum": {
            type: "number"
        },
        "class": {
            type: "boolean"
        },
        normalProperty: {
            type: "string"
        }
    },
    required: ["@link", "@context", "@type", "kebab-case", "with space", "with-special-chars!", "default", "enum", "class", "normalProperty"]
} as const satisfies __ctHelpers.JSONSchema;
export { linkedDataSchema };
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
