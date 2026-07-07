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

// 1×1 transparent PNG served by the mocked generation endpoint; the expected
// `imageDataUrl` is its exact data URL (bytes → base64 identity round-trip).
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const EXPECTED_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

export const fetchMocks = [
  {
    urlIncludes: "/api/ai/img",
    contentType: "image/png",
    base64Body: TINY_PNG_BASE64,
  },
];

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

  // The generation path (mocked endpoint): a generation-allowed instance
  // with nothing stored fetches and exposes its fetch-derived outputs.
  const generating = GeneratedArt({
    prompt: "Sushi Place",
    shouldGenerate: true,
  });

  // The static instances assert via the rendered UI; the generating instance
  // ALSO asserts direct reads of fetch-derived outputs (`fetchState`,
  // `imageDataUrl`) — parent-readable since the CT-1836 traversal fix (the
  // CT-1811-family gap that once forced a notify-stream seam here).
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

  const assert_generation_outputs_materialize = computed(() =>
    readValue(generating.fetchState) === "generated" &&
    readValue(generating.imageDataUrl) === EXPECTED_DATA_URL
  );

  const assert_generated_overlay_renders = computed(() =>
    findNodeByName(generating[UI], "cf-image") !== undefined
  );

  return {
    tests: [
      { assertion: assert_stored_image_renders_directly },
      { assertion: assert_gated_instance_shows_fallback_only },
      { assertion: assert_empty_prompt_shows_fallback_only },
      // Drives the generating instance's mocked fetch to completion.
      { settle: true },
      { assertion: assert_generation_outputs_materialize },
      { assertion: assert_generated_overlay_renders },
    ],
  };
});
