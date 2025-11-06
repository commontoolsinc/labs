import * as __ctHelpers from "commontools";
import { Cell, recipe, UI } from "commontools";
declare global {
    interface MouseEvent {
        detail: number;
    }
}
interface State {
    metrics: Cell<number>;
    user?: {
        clicks: Cell<number>;
    };
}
export default recipe({
    type: "object",
    properties: {
        metrics: {
            type: "number",
            asCell: true
        },
        user: {
            type: "object",
            properties: {
                clicks: {
                    type: "number",
                    asCell: true
                }
            },
            required: ["clicks"]
        }
    },
    required: ["metrics"]
} as const satisfies __ctHelpers.JSONSchema, (state) => {
    return {
        [UI]: (<button type="button" onClick={__ctHelpers.handler({
            type: "object",
            properties: {
                detail: true
            },
            required: ["detail"]
        } as const satisfies __ctHelpers.JSONSchema, {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        user: {
                            type: "object",
                            properties: {
                                clicks: {
                                    type: "number",
                                    asCell: true
                                }
                            },
                            required: ["clicks"]
                        },
                        metrics: {
                            type: "number",
                            asCell: true
                        }
                    },
                    required: ["user", "metrics"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, (event, { state }) => state.user?.clicks.set(event.detail + state.metrics.get()))({
            state: {
                user: {
                    clicks: state.user?.clicks
                },
                metrics: state.metrics
            }
        })}>
        Track
      </button>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
