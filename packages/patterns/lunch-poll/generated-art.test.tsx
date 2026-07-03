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

// Walk the rendered tree for a vnode by element name (e.g. "img", "cf-image").
const findNodeByName = (
  root: unknown,
  name: string,
): unknown | undefined => {
  const value = readValue(root);
  if (isRecord(value) && readValue(value.name) === name) return value;
  return childNodes(value)
    .map((child) => findNodeByName(child, name))
    .find((child) => child !== undefined);
};

export default pattern(() => {
  const art = GeneratedArt({
    prompt: "Sushi Place",
    sourceUrl: STORED_IMAGE,
    shouldGenerate: false,
  });

  // The gate: a non-generating instance (a non-host viewer) with nothing
  // stored renders only the fallback — no stored <img>, no generated overlay.
  const gated = GeneratedArt({
    prompt: "Sushi Place",
    shouldGenerate: false,
  });

  // The prompt guard (CT-1820 adjacent): a transiently-empty prompt must not
  // build a generation request even when generation is allowed; only the
  // fallback renders.
  const empty = GeneratedArt({
    prompt: "",
    shouldGenerate: true,
  });

  // NOTE: assertions walk the rendered UI rather than reading `fetchState`:
  // child outputs computed from fetch-builtin cells do not materialize for
  // parent readers (CT-1811-family runtime gap) — which is also why the
  // persistence seam is the `onGenerated` stream, not an output read.
  const assert_stored_image_renders_directly = computed(() =>
    findNodeByProp(art[UI], "src", STORED_IMAGE) !== undefined
  );

  const assert_gated_instance_shows_fallback_only = computed(() =>
    findNodeByName(gated[UI], "img") === undefined &&
    findNodeByName(gated[UI], "cf-image") === undefined
  );

  const assert_empty_prompt_shows_fallback_only = computed(() =>
    findNodeByName(empty[UI], "img") === undefined &&
    findNodeByName(empty[UI], "cf-image") === undefined
  );

  return {
    tests: [
      { assertion: assert_stored_image_renders_directly },
      { assertion: assert_gated_instance_shows_fallback_only },
      { assertion: assert_empty_prompt_shows_fallback_only },
    ],
  };
});
