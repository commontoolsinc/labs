import { Fact, FactSelection } from "./interface.ts";
import { set } from "./changes.ts";

export const from = (
  source: Iterable<[fact: Fact, since: number]>,
): FactSelection => {
  const selection = {} as FactSelection;
  for (const [fact, since] of source) {
    const at = [fact.of, fact.the];
    const { cause, is } = fact;
    set(
      selection,
      at,
      cause.toString(),
      is === undefined ? { since } : { is, since },
    );
  }

  return selection;
};
