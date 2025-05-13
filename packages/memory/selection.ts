import {
  Cause,
  Entity,
  Fact,
  FactSelection,
  OfTheCause,
  Select,
  SelectAll,
  SelectAllString,
  The,
} from "./interface.ts";
import { JSONValue } from "../builder/src/index.ts";

export const from = (
  source: Iterable<[fact: Fact, since: number]>,
): OfTheCause<{ is?: JSONValue; since: number }> => {
  const selection = {} as FactSelection;
  for (const [fact, since] of source) {
    const { cause, is } = fact;
    set<{ is?: JSONValue; since: number }>(
      selection,
      fact.of,
      fact.the as The,
      cause.toString(),
      is === undefined ? { since } : { is, since },
    );
  }
  return selection;
};

// We include the permutations of selector or selection,
// setting with or without a cause, empty or non-empty

export const set = <T>(
  selection: OfTheCause<T>,
  of: Entity,
  the: The,
  cause: Cause,
  value: T,
): OfTheCause<T> => {
  const attributes = (of in selection) ? selection[of] : {};
  const causes = (the in attributes) ? attributes[the] : {};
  causes[cause] = value;
  attributes[the] = causes;
  selection[of] = attributes;
  return selection;
};

export const setSelector = <T>(
  selector: Select<Entity, Select<The, Select<Cause, T>>>,
  of: Entity | SelectAll,
  the: The | SelectAll,
  cause: Cause | SelectAll,
  value: T,
): OfTheCause<T> => {
  const attributes = (of in selector)
    ? selector[of] as Select<The, Select<Cause, T>>
    : {};
  const causes = (the in attributes) ? attributes[the] as Select<Cause, T> : {};
  causes[cause] = value;
  attributes[the] = causes;
  selector[of] = attributes;
  return selector;
};

export const setRevision = <T>(
  selection: OfTheCause<T>,
  of: Entity,
  the: The,
  cause: Cause,
  value: T,
): OfTheCause<T> => {
  const attributes = (of in selection) ? selection[of] : {};
  attributes[the] = { [cause]: value };
  selection[of] = attributes;
  return selection;
};

export const setEmptyObj = <T>(
  selection: OfTheCause<T>,
  of: Entity,
  the?: The,
): OfTheCause<T> => {
  const attributes = (of in selection) ? selection[of] : {};
  if (the !== undefined) {
    attributes[the] = {};
  }
  selection[of] = attributes;
  return selection;
};

export const iterate = function* <T>(
  selection: OfTheCause<T>,
): Iterable<{ of: Entity; the: The; cause: Cause; value: T }> {
  for (const [of, attributes] of Object.entries(selection)) {
    for (const [the, causes] of Object.entries(attributes)) {
      for (const [cause, state] of Object.entries(causes)) {
        yield { of: of as Entity, the: the as The, cause, value: state };
      }
    }
  }
};

type EmptyObj = Record<string | number | symbol, never>;
// Selectors can have wildcard strings
// If we're missing a "the" or "cause", we treat these as wildcards
export const iterateSelector = function* <T>(
  selector: Select<Entity, Select<The, Select<Cause, T>>>,
): Iterable<
  {
    of: Entity | SelectAll;
    the: The | SelectAll;
    cause: Cause | SelectAll;
    value: T | EmptyObj;
  }
> {
  for (const [of, attributes] of Object.entries(selector)) {
    let attrEntries = Object.entries(attributes);
    if (attrEntries.length === 0) {
      attrEntries = [[SelectAllString, {}]];
    }
    for (const [the, causes] of attrEntries) {
      let causeEntries: [string, T | EmptyObj][] = Object.entries(causes);
      if (causeEntries.length == 0) {
        causeEntries = [[SelectAllString, {}]];
      }
      for (const [cause, state] of causeEntries) {
        yield {
          of: of as Entity | SelectAll,
          the: the as The | SelectAll,
          cause,
          value: state,
        };
      }
    }
  }
};

// This gets what should be the only cause/value pair for an of/the pair.
export const getRevision = <T>(
  selection: OfTheCause<T>,
  of: Entity,
  the: The | SelectAll,
): T | undefined => {
  if (of in selection) {
    const attributes = selection[of];
    let attrEntries;
    if (the === SelectAllString) {
      attrEntries = Object.entries(attributes);
      if (attrEntries.length === 0) {
        return undefined;
      }
    } else if (the in attributes) {
      attrEntries = [[the, attributes[the]]];
    } else {
      return undefined;
    }
    for (const [_the, causes] of attrEntries) {
      const [change] = Object.entries(causes);
      if (change) {
        const [_cause, value] = change;
        return value;
      }
    }
  }
  return undefined;
};

// Selectors can have wildcard strings, so we can't use the standard version
// This gets what should be the only cause/value pair for an of/the pair.
export const getSelectorRevision = <T>(
  selector: Select<Entity, Select<The, Select<Cause, T>>>,
  of: Entity,
  the: The,
): T | undefined => {
  const attributes = selector[of] ?? selector[SelectAllString];
  if (attributes !== undefined) {
    const changes = attributes[the] ?? attributes[SelectAllString];
    if (changes !== undefined) {
      const [change] = Object.entries(changes);
      if (change) {
        const [_cause, value] = change;
        return value;
      }
    }
  }
  return undefined;
};
