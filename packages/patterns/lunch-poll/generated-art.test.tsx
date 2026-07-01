import { computed, pattern, UI } from "commonfabric";
import GeneratedArt from "./generated-art.tsx";

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

const childNodes = (node: unknown): unknown[] => {
  const value = readValue(node);
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  const ui = value[UI];
  return [
    ...(ui === undefined || ui === value ? [] : [ui]),
    ...childrenArray(value.children),
  ];
};

const findNodeByProp = (
  root: unknown,
  prop: string,
  expected: unknown,
): unknown | undefined => {
  const value = readValue(root);
  const props = propsOf(value);
  if (props && readValue(props[prop]) === expected) return value;
  return childNodes(value)
    .map((child) => findNodeByProp(child, prop, expected))
    .find((child) => child !== undefined);
};

const STORED_IMAGE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ";

export default pattern(() => {
  const art = GeneratedArt({
    prompt: "Sushi Place",
    sourceUrl: STORED_IMAGE,
    shouldGenerate: false,
  });

  const assert_stored_image_renders_directly = computed(() =>
    findNodeByProp(art[UI], "src", STORED_IMAGE) !== undefined
  );

  return {
    tests: [
      { assertion: assert_stored_image_renders_directly },
    ],
  };
});
