import * as __ctHelpers from "commontools";
import { generateObject, type WishState, wish, } from "commontools";
const existingLabelSchema = {
    type: "object",
    properties: {
        label: { type: "string" },
    },
    required: ["label"],
} as const;
// FIXTURE: wish-and-generate-object-contextual
// Verifies: wish() injects schemas from explicit and contextual result types, and generateObject() injects explicit schemas
//   wish<string>({ query }) → wish<string>({ query }, { type: "string" })
//   const state: WishState<{ title: string }> = wish({ query }) → object schema from contextual result type
//   generateObject<T>({ ... }) injects params.schema, but preserves authored schema when already present
export default function TestWishAndGenerateObjectContextual() {
    const explicitWish = wish<string>({ query: "#greeting" }, {
        type: "string"
    } as const satisfies __ctHelpers.JSONSchema);
    const contextualWish: WishState<{
        title: string;
    }> = wish({
        query: "#title",
    }, {
        type: "object",
        properties: {
            result: {
                anyOf: [{
                        type: "undefined"
                    }, {
                        type: "object",
                        properties: {
                            title: {
                                type: "string"
                            }
                        },
                        required: ["title"]
                    }]
            },
            candidates: {
                type: "array",
                items: {
                    type: "object",
                    properties: {
                        title: {
                            type: "string"
                        }
                    },
                    required: ["title"]
                }
            },
            error: true,
            $UI: {
                $ref: "https://commonfabric.org/schemas/vnode.json"
            }
        },
        required: ["result", "candidates"]
    } as const satisfies __ctHelpers.JSONSchema);
    const explicitObject = generateObject<{
        title: string;
    }>({
        model: "gpt-4o-mini",
        prompt: "Return a title",
        schema: {
            type: "object",
            properties: {
                title: {
                    type: "string"
                }
            },
            required: ["title"]
        } as const satisfies __ctHelpers.JSONSchema
    });
    const preSchemaObject = generateObject<{
        label: string;
    }>({
        model: "gpt-4o-mini",
        prompt: "Return a label",
        schema: existingLabelSchema,
    });
    return {
        explicitWish,
        contextualWish,
        explicitObject,
        preSchemaObject,
    };
}
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
