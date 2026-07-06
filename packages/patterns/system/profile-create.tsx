import {
  type Cell,
  Cfc,
  equals,
  handler,
  NAME,
  pattern,
  Stream,
  UI,
  type VNode,
  Writable,
  WriteAuthorizedBy,
} from "commonfabric";
import ProfileHome, { type ProfileHomeOutput } from "./profile-home.tsx";

// Trusted UI surfaces / actions. The create surface authorizes appending a new
// profile to the home `profiles` list; the picker surface authorizes setting the
// default profile and stamping most-recently-used (MRU).
export const TRUSTED_PROFILE_CREATE_SURFACE = "ProfileCreateSurface";
export const TRUSTED_PROFILE_CREATE_ACTION = "CreateProfile";
export const TRUSTED_PROFILE_PICKER_SURFACE = "ProfilePickerSurface";
export const TRUSTED_PROFILE_SET_DEFAULT_ACTION = "SetDefaultProfile";
export const TRUSTED_PROFILE_SET_MRU_ACTION = "SetMruProfile";

// Read a profile link (or list of links) as cell REFERENCES (`asCell`), not
// inlined values. A plain `.get()` deep-resolves each element and collapses the
// whole read to `undefined` when any element links into a space not yet loaded
// in this context (e.g. a freshly-created profile living in its own `inSpace`
// space). Item type is `unknown` to keep the sync shallow (links only). Mirrors
// wish.ts `profileLinkListSchema`; identity comparisons use `equals` on the
// resulting link cells, which never deep-resolves.
//
// These are functions (not const object literals) so the schema object is built
// per call inside the function body — module-top-level mutable data is rejected
// under SES (`__cf_data()`); a function returning a fresh literal is not.
// deno-lint-ignore no-explicit-any
export const profileLinkListSchema = (): any => ({
  type: "array",
  items: { type: "unknown", asCell: ["cell"] },
});
// deno-lint-ignore no-explicit-any
export const profileLinkSchema = (): any => ({
  type: "unknown",
  asCell: ["cell"],
});

export type CreateProfileEvent = {
  detail?: { message?: string };
  key?: string;
  name?: string;
  target?: { value?: string };
};

// Appends a freshly-created profile (its own `inSpace` space) to the home
// `profiles` list. The cross-space `inSpace` child materializes during the push;
// the `.inSpace(...)` call opts the transaction into a multi-space commit (see
// builder/pattern.ts `optIntoInSpaceMultiSpaceCommit` → runner
// `enableCrossSpaceChildCommit`).
//
// CT-1650: the profile space is created via ANONYMOUS `inSpace()` — never
// `inSpace(name)`. A named target derives its DID from
// `fromPassphrase("common user").derive(name)` (createSession spaceName path),
// i.e. the display NAME alone, so two different users picking the same profile
// name — or one user creating two same-named profiles — collide into a single
// shared space. The anonymous case instead derives the DID from this handler's
// frame cause, which carries the creating user's per-home-space input links plus
// the durable per-event id (runner.ts `createPatternFrame` cause): unique per
// user AND per creation event, stable across the cross-space-commit retry. The
// display name flows ONLY to `initialName` (editable later, independent of the
// space identity). Existing profiles keep their already-baked concrete DID link.
export const submitProfileCreation = handler<
  CreateProfileEvent,
  {
    profiles: Writable<ProfileHomeOutput[]>;
  }
>((event, { profiles }) => {
  // The submitted name rides the event: the create surface is a
  // `cf-submit-input`, whose submit-button click carries the typed text as
  // `event.target.value` (and the trusted surface's UI integrity). The handler
  // keeps no draft cell. This is what makes clear-on-submit safe: the push
  // materializes the profile in its own `inSpace` space, so the create is a
  // cross-space (multi-space) commit the runner drives through a pending →
  // resolve → retry cycle plus optimistic-conflict retries. Re-reading a
  // mutable draft on those retries — or clearing one — would race a back-to-back
  // second create; the event payload is fixed per creation, so the name stays
  // stable across retries and nothing is cleared late. The field clears itself
  // in the DOM after submit, with no durable write to clobber.
  const name = (event.name ?? event.detail?.message ?? event.target?.value ??
    "").trim();
  if (name) {
    profiles.push(
      ProfileHome.inSpace()({
        initialName: name,
      }) as ProfileHomeOutput,
    );
  }
});

// Sets the user's default profile — the one `#profile` resolves to in headless
// mode and orders first in the picker. The chosen profile is bound per-row via
// handler state (mirrors how home's removeSpaceHandler binds its item).
export const setDefaultProfile = handler<
  unknown,
  {
    // CT-1845 — CFC derives the walked write-authorization schema from THIS
    // handler-state declaration (the write TARGET the handler binds). Declaring
    // it `Writable<ProfileHomeOutput | undefined>` bakes the walkable
    // owner-protected `/avatar` (etc.) into the write path, so overwriting an
    // already-set default trips `writeAuthorizedBy failed at /avatar` (the picker
    // writer ≠ `setAvatar`). It MUST be the opaque `DefaultProfileCell` — every
    // site whose type flows into this write (home durable cell, picker input,
    // this handler param) must be consistently opaque or the walk fires again.
    // See the `TrustedDefaultProfile` / `DefaultProfileCell` notes below.
    defaultProfile: DefaultProfileCell;
    // Take the profile as an OPAQUE LINK cell, not a resolved value and not the
    // walkable `ProfileHomeOutput`: the handler only needs the link to write into
    // defaultProfile, a link argument doesn't require the profile's cross-space
    // values to be loaded at event time (resolving the full value here would fail
    // required-field validation — "stream action argument is undefined … not
    // running" — whenever the profile's space hasn't materialized locally yet),
    // AND an opaque param keeps the serialized link's carried schema free of the
    // walkable owner-protected sub-fields (CT-1845, same rationale as the write
    // target above).
    profile: Cell<OpaqueProfileLinkTarget>;
  }
>((_, { defaultProfile, profile }) => {
  if (profile) {
    defaultProfile.set(profile as any);
  }
});

// Stamps a profile as most-recently-used: prepend to the MRU list (deduped by
// link identity). Drives the picker's "default first, then by MRU" ordering.
export const setMruProfile = handler<
  unknown,
  {
    mru: Writable<ProfileHomeOutput[]>;
    // Link cell, not a resolved value — same event-time-validation reason as
    // setDefaultProfile above.
    profile: Cell<ProfileHomeOutput>;
  }
>((_, { mru, profile }) => {
  if (!profile) return;
  // Read existing entries as link cells (not inlined values) so an entry that
  // links into an unloaded space doesn't collapse the whole read to `undefined`
  // and silently wipe MRU history. Dedup by link identity via `equals`.
  const current = ((mru as any).asSchema(profileLinkListSchema()).get() ??
    []) as ProfileHomeOutput[];
  const filtered = current.filter((entry) => !equals(entry, profile));
  mru.set([profile, ...filtered] as any);
});

// A single owner-protected link to a profile pattern in its own space, created
// through the trusted create surface. This element contract gates adding or
// replacing a link (a changed element value); the array container additionally
// carries `writeAuthorizedBy` to gate structural changes (see TrustedProfileList
// below).
export type TrustedProfileLink = Cfc<
  WriteAuthorizedBy<Cell<ProfileHomeOutput>, typeof submitProfileCreation>,
  {
    addIntegrity: ["profile-link"];
    uiContract: {
      helper: "UiAction";
      action: typeof TRUSTED_PROFILE_CREATE_ACTION;
      trustedPattern: typeof TRUSTED_PROFILE_CREATE_SURFACE;
      requiredEventIntegrity: [typeof TRUSTED_PROFILE_CREATE_SURFACE];
    };
  }
>;

// The home `profiles` list. Protection is two-layered:
//   - elements (`TrustedProfileLink`) carry the create `uiContract` — gates
//     adding/replacing a link (a changed element value) to the trusted surface;
//   - the array container carries `writeAuthorizedBy: submitProfileCreation` —
//     gates STRUCTURAL changes (truncation / removal / reorder) that the
//     element-wildcard contract misses, because CFC's element-applies check only
//     visits *changed* elements of the new array, so a `set([])` or shrink would
//     otherwise be unmediated. Container `writeAuthorizedBy` (identity-based)
//     rather than `uiContract` (per-event) so a legit append — which also
//     rewrites the container — passes under the create handler's identity
//     instead of re-triggering a per-event trusted requirement it can't satisfy.
export type TrustedProfileList = Cfc<
  WriteAuthorizedBy<TrustedProfileLink[], typeof submitProfileCreation>,
  { addIntegrity: ["profile-link"] }
>;

// A profile link written via the trusted picker surface (default / MRU writes).
// `LinkTarget` is the referenced schema — the walkable `ProfileHomeOutput` for
// the MRU array, or the opaque `OpaqueProfileLinkTarget` for the single default
// slot (see the CT-1845 note on `TrustedDefaultProfile`).
type PickerProfileLink<
  Binding,
  Action extends string,
  LinkTarget = ProfileHomeOutput,
> = Cfc<
  WriteAuthorizedBy<Cell<LinkTarget>, Binding>,
  {
    addIntegrity: ["profile-link"];
    uiContract: {
      helper: "UiAction";
      action: Action;
      trustedPattern: typeof TRUSTED_PROFILE_PICKER_SURFACE;
      requiredEventIntegrity: [typeof TRUSTED_PROFILE_PICKER_SURFACE];
    };
  }
>;

// The home `defaultProfile` OUTPUT slot: write authorized by `setDefaultProfile`.
//
// CT-1845: the referenced link target is OPAQUE (`OpaqueProfileLinkTarget`, an
// empty object), NOT the walkable `ProfileHomeOutput`, kept consistent with the
// `DefaultProfileCell` sites below (the real runtime lever is the handler's own
// write target — see its note). `defaultProfile` is a SINGLE owner-protected
// slot; the write-authorization schema CFC walks derives from the binding site.
// With a walkable `ProfileHomeOutput`, CFC
// (`walkIfcSchema`) emits owner-protected entries for the target's OWN fields —
// `/name`, `/avatar`, `/bio`, each `writeAuthorizedBy: set…`. OVERWRITING the
// default with a different profile changes the container link, which
// `ifcEntryAppliesToAttemptedWrite` marks as "touching" the nested `/avatar`;
// its RESOLVED value is a concrete string, so the entry APPLIES and CFC enforces
// `/avatar`'s `writeAuthorizedBy: setAvatar` against the PICKER writer
// (`setDefaultProfile` ≠ `setAvatar`) — the commit is rejected with
// `writeAuthorizedBy failed at /avatar`. A first write from EMPTY has no prior
// resolved `/avatar` to touch, so it passes — the bug is overwrite-specific. The
// MRU array dodges this because CFC checks its owner-protected element under a
// wildcard `*` per changed element, not as a single walked container. Prior fix
// PR #4539 (`profile.getAsLink()`) was disproven in-browser. An OPAQUE link
// target carries no walkable sub-fields, so no nested `/avatar` claim exists to
// enforce. Reads are unaffected — the picker/wish resolve `defaultProfile` via
// `resolveAsCell()` / `profileLinkSchema()` (identity only), never the slot's
// declared schema.
export type TrustedDefaultProfile =
  | PickerProfileLink<
    typeof setDefaultProfile,
    typeof TRUSTED_PROFILE_SET_DEFAULT_ACTION,
    OpaqueProfileLinkTarget
  >
  | undefined;

// The opaque referenced schema for the single `defaultProfile` slot: an object
// with no properties, so no owner-protected sub-field is walked on write. The
// link's identity is all the read side needs.
export type OpaqueProfileLinkTarget = Record<never, never>;

// The OPAQUE type for the home `defaultProfile` cell.
//
// CT-1845: CFC derives the walked write-authorization schema from the BINDING
// SITE of the `setDefaultProfile` write — primarily the handler's OWN
// `defaultProfile` state param (its `asCell:["writeonly"]` write target), which
// the type flows into from the home durable cell (`new Writable<…>().for(
// "defaultProfile")`) and the picker input. If ANY of those sites declares the
// walkable `Writable<ProfileHomeOutput | undefined>`, CFC (`walkIfcSchema`)
// emits owner-protected entries for the target's OWN `/name`, `/avatar`, `/bio`,
// and overwriting the default with a different profile trips
// `writeAuthorizedBy failed at /avatar` (see `TrustedDefaultProfile` above).
// `OpaqueProfileLinkTarget` (an empty object) carries no walkable sub-fields, so
// the overwrite commits. EVERY site that flows into the setDefaultProfile write
// MUST use this opaque type — the handler param (above), the home durable cell,
// and the picker input — or the walk fires again from the site that was missed.
export type DefaultProfileCell = Writable<OpaqueProfileLinkTarget | undefined>;

// The home `mru` list: elements carry the picker `uiContract`; the array
// container carries `writeAuthorizedBy: setMruProfile` to gate structural
// changes (truncation/removal), same two-layer rationale as TrustedProfileList.
export type TrustedProfileMru = Cfc<
  WriteAuthorizedBy<
    PickerProfileLink<
      typeof setMruProfile,
      typeof TRUSTED_PROFILE_SET_MRU_ACTION
    >[],
    typeof setMruProfile
  >,
  { addIntegrity: ["profile-link"] }
>;

export type ProfileCreateInput = {
  profiles: Writable<ProfileHomeOutput[]>;
  inputId?: string;
  // Optional prefill for the create field. Embedders often already know the
  // user's name (e.g. Loom asks at setup) — without this, first-run re-asks a
  // question the product already knows the answer to. UI PREFILL ONLY: it
  // seeds cf-submit-input's `initialValue`, which the component copies into
  // its own editable field state once, on first render (see
  // cf-submit-input.ts `willUpdate` / `_seeded`), and the field stays
  // uncontrolled after that. The create still flows through the same trusted
  // click — `submitProfileCreation` reads the name from the event at gesture
  // time exactly as before — so a prefilled value is a head start on typing,
  // never a shortcut around the gesture.
  defaultName?: string;
};

export type ProfileCreateOutput = {
  [NAME]: string;
  [UI]: VNode;
  createProfile: Stream<CreateProfileEvent>;
};

export default pattern<ProfileCreateInput, ProfileCreateOutput>(
  ({ profiles, inputId, defaultName }) => {
    const createProfile = submitProfileCreation({
      profiles: profiles as any,
    });
    return {
      [NAME]: "Create Profile",
      createProfile,
      [UI]: (
        <cf-vstack
          id="profile-create-surface"
          data-ui-pattern={TRUSTED_PROFILE_CREATE_SURFACE}
          data-ui-event-integrity={TRUSTED_PROFILE_CREATE_SURFACE}
          gap="1"
        >
          {
            /* The submit-button click carries the typed name as
              event.target.value with this surface's trusted UI integrity, so
              the create needs no draft cell and the field self-clears.
              `initialValue` only seeds the field's starting text (a one-time,
              uncontrolled copy inside cf-submit-input) — it does not touch the
              trusted-click path. */
          }
          <cf-submit-input
            inputId={inputId ?? "profile-name-input"}
            data-ui-action={TRUSTED_PROFILE_CREATE_ACTION}
            placeholder="Your name..."
            buttonText="Create profile"
            initialValue={defaultName ?? ""}
            onClick={createProfile}
          />
        </cf-vstack>
      ),
    };
  },
);
