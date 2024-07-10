import { debug } from "./log.js";
import { isObject, isString } from "./util.js";

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
  Object.freeze(templateParts);
  Object.freeze(context);
  const template = Object.freeze({ template: templateParts, context });
  debug("Created template", template);
  return template;
};

export default html;

/**
 * A template object is an array of strings and an array of substitutions.
 * Typically created via the `html` template literal tagging function.
 */
export type Template = {
  template: Readonly<Array<string>>;
  context: TemplateContext;
};

export type TemplateContext = Readonly<Array<unknown>>;

/** Is value a template object? */
export const isTemplate = (value: unknown): value is Template => {
  return (
    isObject(value) &&
    "template" in value &&
    isTemplateParts(value.template) &&
    "context" in value &&
    isTemplateContext(value.context)
  );
};

/** Is valid template parts array? */
export const isTemplateParts = (value: unknown): value is Array<string> => {
  return (
    Array.isArray(value) && Object.isFrozen(value) && value.every(isString)
  );
};

export const isTemplateContext = (value: unknown): value is TemplateContext => {
  return Array.isArray(value) && Object.isFrozen(value);
};
