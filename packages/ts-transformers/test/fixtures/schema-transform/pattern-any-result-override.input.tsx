/// <cts-enable />
import {
  computed,
  pattern,
  UI,
  VNode,
} from "commontools";

// Simulates `any` leaking through a generic function (like generateObject)
declare function fetchAny(): any;

// Case 1: Explicit Output type overrides inferred `any` return
export const TypedFromAny = pattern<{ prompt: string }, string>(({ prompt }) => {
  const result = fetchAny();
  return computed(() => result?.title || prompt || "Untitled");
});

// Case 2: { [UI]: VNode } Output type instead of { [UI]: any }
type Entry = { name: string };
export const TypedUIOutput = pattern<Entry, { [UI]: VNode }>(({ name }) => {
  return {
    [UI]: (<div>{name}</div>),
  };
});
