import type {
  CauseString,
  Changes,
  Fact,
  FactSelection,
  MIME,
  OfTheCause,
  Select,
  SelectAll,
  StorableDatum,
  URI,
} from "./interface.ts";
import { SelectAllString } from "./schema.ts";

export const from = (
  source: Iterable<[fact: Fact, since: number]>,
): OfTheCause<{ is?: StorableDatum; since: number }> => {
  const selection = {} as FactSelection;
  for (const [fact, since] of source) {
    const { cause, is } = fact;
    set<
      { is?: StorableDatum; since: number },
      OfTheCause<{ is?: StorableDatum; since: number }>
    >(
      selection,
      fact.of,
      fact.the,
      cause.toString() as CauseString,
      is === undefined ? { since } : { is, since },
    );
  }
  return selection;
};

// We include the permutations of selector or selection,
// setting with or without a cause, empty or non-empty

export const set = <T, U extends OfTheCause<T> | Changes<MIME, URI>>(
  selection: U,
  of: URI,
  the: MIME,
  cause: CauseString,
  value: T,
): U => {
  const attributes = (of in selection) ? selection[of] : {};
  const causes = (the in attributes) ? attributes[the] : {};
  causes[cause] = value;
  attributes[the] = causes;
  selection[of] = attributes;
  return selection;
};

/**
 * Like set, but the selector can have wildcard strings.
 */
export const setSelector = <T>(
  selector: Select<URI, Select<MIME, Select<CauseString, T>>>,
  of: URI | SelectAll,
  the: MIME | SelectAll,
  cause: CauseString | SelectAll,
  value: T,
): Select<URI, Select<MIME, Select<CauseString, T>>> => {
  const attributes = (of in selector)
    ? selector[of] as Select<MIME, Select<CauseString, T>>
    : {};
  const causes = (the in attributes)
    ? attributes[the] as Select<CauseString, T>
    : {};
  causes[cause] = value;
  attributes[the] = causes;
  selector[of] = attributes;
  return selector;
};

/**
 * Like set, but setRevision will only have a single cause/value entry.
 */
export const setRevision = <T>(
  selection: OfTheCause<T>,
  of: URI,
  the: MIME,
  cause: CauseString,
  value: T,
): OfTheCause<T> => {
  const attributes = (of in selection) ? selection[of] : {};
  attributes[the] = { [cause]: value };
  selection[of] = attributes;
  return selection;
};

export const setEmptyObj = <T>(
  selection: OfTheCause<T>,
  of: URI,
  the?: MIME,
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
): Iterable<{ of: URI; the: MIME; cause: CauseString; value: T }> {
  for (const [of, attributes] of Object.entries(selection)) {
    for (const [the, causes] of Object.entries(attributes)) {
      for (const [cause, state] of Object.entries(causes)) {
        yield {
          of: of as URI,
          the: the as MIME,
          cause: cause as CauseString,
          value: state,
        };
      }
    }
  }
};

type EmptyObj = Record<string | number | symbol, never>;
// Selectors can have wildcard strings
// If we're missing a "the" or "cause", we treat these as wildcards
export const iterateSelector = function* <T>(
  selector: Select<URI, Select<MIME, Select<CauseString, T>>>,
  defaultValue: T,
): Iterable<
  {
    of: URI | SelectAll;
    the: MIME | SelectAll;
    cause: CauseString | SelectAll;
    value: T;
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
        causeEntries = [[SelectAllString, defaultValue]];
      }
      // we will extract at most one cause from the selector
      const [[cause, state]] = causeEntries;
      yield {
        of: of as URI | SelectAll,
        the: the as MIME | SelectAll,
        cause: cause as CauseString | SelectAll,
        value: state,
      };
    }
  }
};

// This gets what should be the only cause/value pair for an of/the pair.
export const getRevision = <T>(
  selection: OfTheCause<T>,
  of: URI,
  the: MIME | SelectAll,
): T | undefined => {
  const [_cause, value] = getChange(selection, of, the) ?? [null, undefined];
  return value;
};

export const getChange = <T>(
  selection: OfTheCause<T>,
  of: URI,
  the: MIME | SelectAll,
): [CauseString, T] | undefined => {
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
        return change as [CauseString, T];
      }
    }
  }
  return undefined;
};

// Selectors can have wildcard strings, so we can't use the standard version
// This gets what should be the only cause/value pair for an of/the pair.
export const getSelectorRevision = <T>(
  selector: Select<URI, Select<MIME, Select<CauseString, T>>>,
  of: URI,
  the: MIME,
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
