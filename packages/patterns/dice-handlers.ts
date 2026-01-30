/// <cts-enable />
import { Default, handler, Writable } from "commontools";

export const roll = handler<
  { sides?: Default<number, 6> },
  { value: Writable<number> }
>(
  (args, state) => {
    const rawSides = args.sides ?? 6;
    const floored = Math.floor(Number(rawSides));
    const sides = Number.isFinite(floored) && floored > 0 ? floored : 6;
    const rolled = Math.floor(
      (crypto.getRandomValues(new Uint32Array(1))[0] / 0xFFFFFFFF) * sides,
    ) + 1;
    state.value.set(rolled);
  },
);

export const getValue = handler<
  { result?: Writable<string> },
  { value: Writable<number> }
>(
  (args, state) => {
    const current = state.value.get();
    args.result?.set(`Current die value is ${current}`);
  },
);
