import { UI } from "commonfabric";

const isRecord = (value: unknown): value is Record<PropertyKey, unknown> =>
  typeof value === "object" && value !== null;

const readValue = (value: unknown): unknown => {
  if (!isRecord(value) || typeof value.get !== "function") {
    return value;
  }
  return (value.get as () => unknown)();
};

const propsOf = (node: unknown): Record<PropertyKey, unknown> | undefined => {
  const value = readValue(node);
  if (!isRecord(value)) {
    return undefined;
  }
  const props = readValue(value.props);
  return isRecord(props) ? props : undefined;
};

const childrenArray = (children: unknown): unknown[] => {
  const value = readValue(children);
  if (Array.isArray(value)) {
    return value;
  }
  return value === undefined || value === null || typeof value === "boolean"
    ? []
    : [value];
};

const childNodes = (node: unknown): unknown[] => {
  const value = readValue(node);
  if (Array.isArray(value)) {
    return value;
  }
  if (!isRecord(value)) {
    return [];
  }
  const ui = value[UI];
  return [
    ...(ui === undefined || ui === value ? [] : [ui]),
    ...childrenArray(value.children),
  ];
};

export const findNodeByProp = (
  root: unknown,
  prop: string,
  expected: unknown,
): unknown | undefined => {
  const value = readValue(root);
  const props = propsOf(value);
  if (props && readValue(props[prop]) === expected) {
    return value;
  }
  return childNodes(value)
    .map((child) => findNodeByProp(child, prop, expected))
    .find((child) => child !== undefined);
};

export const findNodeById = (
  root: unknown,
  id: string,
): unknown | undefined => findNodeByProp(root, "id", id);

export const propValue = (node: unknown, prop: string): unknown => {
  const props = propsOf(node);
  return props ? readValue(props[prop]) : undefined;
};

const primitiveText = (value: unknown): string => {
  const resolved = readValue(value);
  return typeof resolved === "string" || typeof resolved === "number"
    ? String(resolved)
    : "";
};

export const textContent = (node: unknown): string => {
  const value = readValue(node);
  if (Array.isArray(value)) {
    return value.map(textContent).join(" ");
  }
  if (!isRecord(value)) {
    return primitiveText(value);
  }
  return [
    primitiveText(propValue(value, "label")),
    ...childNodes(value).map(textContent),
  ].filter((text) => text.length > 0).join(" ");
};

export const nodeIncludesText = (
  node: unknown,
  expected: string,
): boolean => textContent(node).includes(expected);
