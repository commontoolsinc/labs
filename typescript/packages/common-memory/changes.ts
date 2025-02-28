import {
  AssertFact,
  Assertion,
  Cause,
  ChangesBuilder,
  ClaimFact,
  Fact,
  FactSelection,
  RetractFact,
  Statement,
} from "./interface.ts";

export const from = <T extends Statement>(statements: Iterable<T>) => {
  const changes = {} as ChangesBuilder;
  for (const statement of statements) {
    const at = [statement.of, statement.the];
    if (statement.cause) {
      const { cause, is } = statement;
      set(changes, at, cause.toString(), is === undefined ? {} : { is });
    } else {
      set(changes, at, statement.fact.toString(), true);
    }
  }

  return changes as T extends Assertion<infer The, infer Of, infer Is>
    ? { [of in Of]: { [the in The]: { [cause: Cause]: { is: Is } } } }
    : T extends Fact<infer The, infer Of, infer Is> ? FactSelection<The, Of, Is>
    : T extends Statement<infer The, infer Of, infer Is>
      ? ChangesBuilder<The, Of, Is>
    : never;
};

export const set = (
  target: Record<string, any>,
  path: string[],
  key: string,
  value: RetractFact | AssertFact | ClaimFact | unknown,
) => {
  let cursor = target;
  for (const at of path) {
    let target = cursor[at];
    if (!target) {
      target = {};
      cursor[at] = target;
    }
    cursor = target;
  }
  cursor[key] = value;
};
