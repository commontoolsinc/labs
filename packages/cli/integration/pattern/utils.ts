/// <cts-enable />
import { Default, handler, Writable } from "commontools";

export interface UserData {
  user?: {
    name?: string;
    age?: number;
  };
}

export interface CounterInput {
  value?: Writable<Default<number, 0>>;
  stringField?: string;
  numberField?: number;
  booleanField?: boolean;
  arrayField?: number[];
  userData?: UserData;
  listField?: string[];
}

export const increment = handler<void, { value: Writable<number> }>(
  (_, state) => {
    state.value.set(state.value.get() + 1);
  },
);

export const decrement = handler<void, { value: Writable<number> }>(
  (_, state) => {
    state.value.set(state.value.get() - 1);
  },
);
