import { handler, cell, Cell, toSchema } from "commontools";
// Test case 1: Simple handler with type parameters
interface EventType {
    message: string;
    count: number;
}
interface StateType {
    value: number;
    items: string[];
}
const simpleHandler = handler(toSchema<EventType>(), toSchema<StateType>(), (event, state) => {
    state.value = event.count;
    state.items.push(event.message);
});
// Test case 2: Handler with Cell types
interface CellEvent {
    data: string;
    cellValue: Cell<number>; // @asCell
}
interface CellState {
    count: Cell<number>; // @asCell
    messages: string[];
}
const cellHandler = handler(toSchema<CellEvent>(), toSchema<CellState>(), (event, state) => {
    state.count.set(event.cellValue.get() + 1);
    state.messages.push(event.data);
});
// Test case 3: Handler with nested types
interface NestedEvent {
    user: {
        name: string;
        age: number;
    };
    timestamp: Date;
}
interface NestedState {
    users: Array<{
        name: string;
        age: number;
    }>;
    lastUpdate: Date;
}
const nestedHandler = handler(toSchema<NestedEvent>(), toSchema<NestedState>(), (event, state) => {
    state.users.push(event.user);
    state.lastUpdate = event.timestamp;
});
// Test case 4: Handler with optional and union types
interface ComplexEvent {
    type: "add" | "remove";
    item?: string;
    priority?: number;
}
interface ComplexState {
    items: string[];
    priorities: Map<string, number>;
}
const complexHandler = handler(toSchema<ComplexEvent>(), toSchema<ComplexState>(), (event, state) => {
    if (event.type === "add" && event.item) {
        state.items.push(event.item);
        if (event.priority) {
            state.priorities.set(event.item, event.priority);
        }
    }
});
// Test case 5: Handler with generic constraints
interface GenericEvent<T> {
    data: T;
    id: string;
}
interface GenericState<T> {
    items: Map<string, T>;
}
const genericHandler = handler(toSchema<GenericEvent<string>>(), toSchema<GenericState<string>>(), (event, state) => {
    state.items.set(event.id, event.data);
});