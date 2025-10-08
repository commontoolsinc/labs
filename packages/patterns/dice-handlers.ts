/// <cts-enable />
import { Cell, Default, handler } from "commontools";

export const roll = handler<
  { result?: Cell<string>; sides?: Default<number, 6> },
  { value: Cell<number> }
>(
  (args, state) => {
    const rawSides = args.sides ?? 6;
    const floored = Math.floor(Number(rawSides));
    const sides = Number.isFinite(floored) && floored > 0 ? floored : 6;
    const rolled = Math.floor(Math.random() * sides) + 1;
    state.value.set(rolled);
    args.result?.set(`Rolled a ${rolled} on a ${sides}-sided die`);
  },
);

export const getValue = handler<
  { result?: Cell<string> },
  { value: Cell<number> }
>(
  (args, state) => {
    const current = state.value.get();
    args.result?.set(`Current die value is ${current}`);
  },
);
