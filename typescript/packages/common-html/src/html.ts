import * as hole from "./hole.js";
import { Reactive } from "./reactive.js";
import * as logger from "./logger.js";
import cid from "./cid.js";
import { view, View } from "./view.js";

export const html = (
  strings: TemplateStringsArray,
  ...values: Array<Reactive<unknown>>
): View => {
  if (values.length > strings.length - 1) {
    throw TypeError("Too many values provided");
  }

  // Create pairs of name/value by generating name
  const namedValues: Array<[string, Reactive<unknown>]> = values.map(
    (value) => {
      return [cid(), value];
    },
  );

  // Flatten template string
  const markup = strings.reduce((result, string, i) => {
    const namedValue = namedValues[i];
    if (namedValue == null) {
      return result + string;
    }
    const [name] = namedValue;
    return result + string + hole.markup(name);
  }, "");

  logger.debug("Flattened", markup);

  // Build context object from entries, indexing by name.
  const context = Object.fromEntries(namedValues);

  return view(markup, context);
};

export default html;
