import { expect } from "@std/expect";

import { outputSpotFromBinding } from "../src/builtins/scope-policy.ts";
import type { MemorySpace } from "../src/cell.ts";
import type { NormalizedFullLink } from "../src/link-types.ts";
import type { URI } from "../src/sigil-types.ts";

Deno.test("outputSpotFromBinding returns undefined without a binding", () => {
  expect(outputSpotFromBinding(undefined)).toBeUndefined();
});

Deno.test("outputSpotFromBinding copies identity coordinates", () => {
  const path = ["items", "0"] as const;
  const binding: NormalizedFullLink = {
    space: "did:key:scope-policy-test" as MemorySpace,
    id: "of:scope-policy-test" as URI,
    path,
    scope: "space",
  };

  const spot = outputSpotFromBinding(binding);

  expect(spot).toEqual({
    space: binding.space,
    id: binding.id,
    path: ["items", "0"],
  });
  expect(spot?.path).not.toBe(path);
});
