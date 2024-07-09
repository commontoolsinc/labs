import { debug } from "./log.js";
import { isObject } from "./util.js";

/**
 * Create a template object using a template literal.
 * @returns a frozen template object which can be transformed into DOM
 *   via the `render()` function.
 * @example
 * const template = html`<div>${name}</div>`;
 */
export const html = (
  templateParts: TemplateStringsArray,
  ...context: Array<unknown>
): Template => {
  Object.freeze(context);
  const template = Object.freeze({ template: templateParts, context });
  debug("Created template", template);
  return template;
};

export default html;

export type TemplateContext = Readonly<Array<unknown>>;

/**
 * A template object is an array of strings and an array of substitutions.
 * Typically created via the `html` template literal tagging function.
 */
export type Template = {
  template: Readonly<Array<string>>;
  context: TemplateContext;
};

/** Is value a template object? */
export const isTemplate = (value: unknown): value is Template => {
  return (
    isObject(value) &&
    "template" in value &&
    Array.isArray(value.template) &&
    "context" in value &&
    Array.isArray(value.context)
  );
};
