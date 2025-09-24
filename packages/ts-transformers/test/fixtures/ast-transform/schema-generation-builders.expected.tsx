/// <cts-enable />
import { handler, recipe, UI, JSONSchema } from "commontools";
type TodoState = {
    items: string[];
};
type TodoEvent = {
    add: string;
};
const addTodo = handler({
    type: "object",
    properties: {
        add: {
            type: "string"
        }
    },
    required: ["add"]
} as const satisfies JSONSchema, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                type: "string"
            }
        }
    },
    required: ["items"]
} as const satisfies JSONSchema, (event, state) => {
    state.items.push(event.add);
});
export default recipe({
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                type: "string"
            }
        }
    },
    required: ["items"]
} as const satisfies JSONSchema, (state) => {
    return {
        [UI]: (<div>
        <button type="button" onClick={addTodo({ items: state.items })}>
          Add
        </button>
        <ul>
          {state.items.map((item) => <li key={item}>{item}</li>)}
        </ul>
      </div>),
    };
});
