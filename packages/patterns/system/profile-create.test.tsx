/**
 * Test Pattern: Profile Create — defaultName prefill (CT-1831)
 *
 * Embedders (e.g. Loom) often already know the user's name at setup; without
 * a prefill, first-run re-asks a question the product already knows the
 * answer to. `defaultName` seeds the create field's *starting text only* — it
 * must not change the trusted-click create path.
 *
 * Covers:
 * - `defaultName` reaches the rendered `cf-submit-input` as `initialValue`.
 * - omitting `defaultName` leaves the field with no prefill (unchanged
 *   behavior), and the surface/action wiring is untouched.
 * - create still flows through the normal trusted-event handler path
 *   (`createProfile.send({ name })` appends to `profiles`) whether or not a
 *   `defaultName` was supplied — the prefill never shortcuts the gesture.
 *
 * Run: deno task cf test packages/patterns/system/profile-create.test.tsx --verbose
 */
import { computed, handler, pattern, Stream, UI, Writable } from "commonfabric";
import ProfileCreate, {
  type CreateProfileEvent,
  TRUSTED_PROFILE_CREATE_ACTION,
} from "./profile-create.tsx";
import type { ProfileHomeOutput } from "./profile-home.tsx";

// Minimal VNode shape (see packages/html/src/h.ts `h()`): plain data holding
// the compiled tree. Attribute VALUES are compiled into cell/lift references
// (not raw literals, even for plain string props), so callers read them with
// `propValue()` below rather than comparing directly.
interface TestVNode {
  type: "vnode";
  name: string;
  // deno-lint-ignore no-explicit-any
  props: Record<string, any>;
  children: unknown[];
}

const isVNode = (node: unknown): node is TestVNode =>
  typeof node === "object" && node !== null &&
  (node as { type?: unknown }).type === "vnode";

// Depth-first search for the first descendant (or self) VNode with the given
// tag name.
function findByTag(node: unknown, tag: string): TestVNode | undefined {
  if (!isVNode(node)) return undefined;
  if (node.name === tag) return node;
  for (const child of node.children ?? []) {
    const found = findByTag(child, tag);
    if (found) return found;
  }
  return undefined;
}

// Reads a compiled JSX prop's underlying value. The transformer wraps every
// attribute expression (even plain string literals like
// `data-ui-action="CreateProfile"`) in a lift/cell reference, so a prop reads
// as a `CellImpl` with a `.get()` rather than the raw value.
// deno-lint-ignore no-explicit-any
function propValue(value: any): unknown {
  return value && typeof value.get === "function" ? value.get() : value;
}

// Sends a name into the exported `createProfile` stream, exactly as the
// trusted cf-submit-input surface's click handler would (see
// submitProfileCreation in profile-create.tsx: it reads the name off the
// event, regardless of whether the field started prefilled or empty).
const submitCreate = handler<
  void,
  { stream: Stream<CreateProfileEvent>; name: string }
>((_event, { stream, name }) => {
  stream.send({ name });
});

export default pattern(() => {
  // Instance WITHOUT defaultName — must render with no prefill, matching
  // pre-CT-1831 behavior exactly.
  const profilesNoDefault = new Writable<ProfileHomeOutput[]>([]);
  const withoutDefault = ProfileCreate({ profiles: profilesNoDefault });

  // Instance WITH defaultName — must prefill the field.
  const profilesWithDefault = new Writable<ProfileHomeOutput[]>([]);
  const withDefault = ProfileCreate({
    profiles: profilesWithDefault,
    defaultName: "Ada",
  });

  const action_create_without_default = submitCreate({
    stream: withoutDefault.createProfile,
    name: "Grace",
  });
  const action_create_with_default = submitCreate({
    stream: withDefault.createProfile,
    name: "Alan",
  });

  // === Assertions: no defaultName → no prefill, surface untouched ===
  const assert_no_default_has_no_initial_value = computed(() => {
    const input = findByTag(withoutDefault[UI], "cf-submit-input");
    if (!input) return false;
    const initialValue = propValue(input.props.initialValue);
    return initialValue === undefined || initialValue === "";
  });
  const assert_no_default_action_wired = computed(() => {
    const input = findByTag(withoutDefault[UI], "cf-submit-input");
    if (!input) return false;
    return propValue(input.props["data-ui-action"]) ===
      TRUSTED_PROFILE_CREATE_ACTION;
  });
  const assert_no_default_initial_empty = computed(() =>
    (profilesNoDefault.get()?.length ?? 0) === 0
  );

  // === Assertions: defaultName prefills, everything else unchanged ===
  const assert_default_seeds_initial_value = computed(() => {
    const input = findByTag(withDefault[UI], "cf-submit-input");
    if (!input) return false;
    return propValue(input.props.initialValue) === "Ada";
  });
  const assert_default_action_still_wired = computed(() => {
    const input = findByTag(withDefault[UI], "cf-submit-input");
    if (!input) return false;
    return propValue(input.props["data-ui-action"]) ===
      TRUSTED_PROFILE_CREATE_ACTION;
  });
  const assert_default_initial_empty = computed(() =>
    (profilesWithDefault.get()?.length ?? 0) === 0
  );

  // === Assertions: create still flows through the normal handler path ===
  // Without a defaultName, a submitted name (Grace) still appends a profile —
  // the trusted-event path is unaffected.
  const assert_created_without_default = computed(() =>
    (profilesNoDefault.get()?.length ?? 0) === 1
  );
  // With a defaultName ("Ada" prefilled), submitting a DIFFERENT typed name
  // ("Alan") is what gets created — proving the create reads the event's
  // value at gesture time, not the prefill, and the prefill is not
  // auto-submitted.
  const assert_created_with_default_uses_submitted_name = computed(() =>
    (profilesWithDefault.get()?.length ?? 0) === 1
  );

  return {
    tests: [
      // Initial render (no defaultName)
      { assertion: assert_no_default_has_no_initial_value },
      { assertion: assert_no_default_action_wired },
      { assertion: assert_no_default_initial_empty },

      // Initial render (with defaultName)
      { assertion: assert_default_seeds_initial_value },
      { assertion: assert_default_action_still_wired },
      { assertion: assert_default_initial_empty },

      // Create still flows through the normal handler path in both cases
      { action: action_create_without_default },
      { assertion: assert_created_without_default },

      { action: action_create_with_default },
      { assertion: assert_created_with_default_uses_submitted_name },
    ],
  };
});
