import { UI } from "commonfabric";

const isRecord = (value: unknown): value is Record<PropertyKey, unknown> =>
  typeof value === "object" && value !== null;

export const readValue = (value: unknown): unknown => {
  if (!isRecord(value) || typeof value.get !== "function") {
    return value;
  }
  return (value.get as () => unknown)();
};

export const propsOf = (
  node: unknown,
): Record<PropertyKey, unknown> | undefined => {
  const value = readValue(node);
  if (!isRecord(value)) return undefined;
  const props = readValue(value.props);
  return isRecord(props) ? props : undefined;
};

const childrenArray = (children: unknown): unknown[] => {
  const value = readValue(children);
  if (Array.isArray(value)) return value;
  return value === undefined || value === null || typeof value === "boolean"
    ? []
    : [value];
};

export const childNodes = (node: unknown): unknown[] => {
  const value = readValue(node);
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  const ui = value[UI];
  return [
    ...(ui === undefined || ui === value ? [] : [ui]),
    ...childrenArray(value.children),
  ];
};

export const textContent = (node: unknown): string => {
  const value = readValue(node);
  if (value === undefined || value === null || typeof value === "boolean") {
    return "";
  }
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(textContent).join("");
  }
  if (!isRecord(value)) return "";
  return childNodes(value).map(textContent).join("");
};

export const hasText = (node: unknown, expected: string): boolean =>
  textContent(node).includes(expected);

export const hasExactText = (node: unknown, expected: string): boolean =>
  textContent(node).trim() === expected;

export const findNode = (
  root: unknown,
  predicate: (node: unknown) => boolean,
): unknown | undefined => {
  const value = readValue(root);
  if (predicate(value)) return value;
  return childNodes(value)
    .map((child) => findNode(child, predicate))
    .find((child) => child !== undefined);
};

export const findNodeByText = (
  root: unknown,
  expected: string,
): unknown | undefined => findNode(root, (node) => hasText(node, expected));

export const findElementByText = (
  root: unknown,
  name: string,
  expected: string,
): unknown | undefined =>
  findNode(root, (node) => {
    const value = readValue(node);
    return isRecord(value) && value.name === name && hasText(value, expected);
  });

export const findElementByExactText = (
  root: unknown,
  name: string,
  expected: string,
): unknown | undefined =>
  findNode(root, (node) => {
    const value = readValue(node);
    return isRecord(value) && value.name === name &&
      hasExactText(value, expected);
  });
