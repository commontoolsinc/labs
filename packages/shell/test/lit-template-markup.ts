/**
 * Flattens a Lit template result, its values included, to its markup, so
 * that a test can assert on what a render method produced without a DOM.
 */
export function templateMarkup(value: unknown): string {
  if (Array.isArray(value)) return value.map(templateMarkup).join("");
  if (value === null || value === undefined) return "";
  if (typeof value !== "object") return String(value);
  const template = value as {
    strings?: readonly string[];
    values?: readonly unknown[];
  };
  if (template.strings === undefined) return "";
  return template.strings.map((part, index) =>
    part + templateMarkup(template.values?.[index])
  ).join("");
}
