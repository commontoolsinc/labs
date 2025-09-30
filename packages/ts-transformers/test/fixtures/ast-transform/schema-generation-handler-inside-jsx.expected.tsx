/// <cts-enable />
import { handler, h, JSONSchema } from "commontools";
interface ClickEvent {
    x: number;
    y: number;
}
interface AppState {
    clicks: number;
    lastPosition: {
        x: number;
        y: number;
    };
}
export const result = (<div>
    {handler({
        type: "object",
        properties: {
            x: {
                type: "number"
            },
            y: {
                type: "number"
            }
        },
        required: ["x", "y"]
    } as const satisfies JSONSchema, {
        type: "object",
        properties: {
            clicks: {
                type: "number"
            },
            lastPosition: {
                type: "object",
                properties: {
                    x: {
                        type: "number"
                    },
                    y: {
                        type: "number"
                    }
                },
                required: ["x", "y"]
            }
        },
        required: ["clicks", "lastPosition"]
    } as const satisfies JSONSchema, (event: ClickEvent, state: AppState) => ({
        clicks: state.clicks + 1,
        lastPosition: { x: event.x, y: event.y },
    }))}
  </div>);
