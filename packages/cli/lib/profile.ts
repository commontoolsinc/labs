/**
 * Creating a profile from the command line.
 *
 * A profile is appended to the home root's `profiles` list, which is
 * owner-protected behind the create surface's UI contract: the append must
 * ride an event that a trusted surface attests to. In the shell that surface
 * is the create form, and the html renderer marks its click. Here the CLI is
 * the surface. The person typing the command is the same actor the renderer
 * stands in for, acting under their own key on their own machine, so the CLI
 * builds the event the renderer would have built and marks it the same way
 * (`trusted-action-event.ts`). What the contract refuses is pattern code or
 * untrusted content forging the gesture, and neither can reach this path.
 *
 * The handler itself is the home pattern's `createProfile`, so the profile is
 * made exactly as the shell makes one: in its own space, its display name
 * carried on the event and never on a draft cell.
 */

import type { Cell, IExtendedStorageTransaction } from "@commonfabric/runner";

import { canonicalAddress } from "./callable.ts";
import { loadPieces, type SpaceConfig } from "./piece.ts";
import { buildActionEvent } from "./trusted-action-event.ts";

/**
 * The create surface's `data-ui-pattern` and `data-ui-action`, as
 * `packages/patterns/system/profile-create.tsx` declares them
 * (`TRUSTED_PROFILE_CREATE_SURFACE`, `TRUSTED_PROFILE_CREATE_ACTION`). Named
 * here rather than imported: a pattern is above this package in the layer
 * stack, and the event is matched by string either way.
 */
export const PROFILE_CREATE_SURFACE = "ProfileCreateSurface";
export const PROFILE_CREATE_ACTION = "CreateProfile";

/** What `createProfile()` needs: a connection, and the name to create under. */
export interface ProfileCreateConfig extends SpaceConfig {
  /** The display name, which becomes the profile's `initialName`. */
  name: string;
}

/** A profile `createProfile()` made. */
export interface CreatedProfile {
  /** The display name the profile was created with. */
  name: string;

  /** The profile's own space, which is not the home space. */
  space: string;

  /** The profile piece's id within that space. */
  id: string;

  /** The canonical reference, `/@<space>/<id>`, which `--cell` takes whole. */
  address: string;
}

/** Injectable connection dep, mirroring lib/piece.ts's `RootPatternDeps`. */
export interface CreateProfileDeps {
  loadPieces?: typeof loadPieces;
}

// The list read as link cells, never inlined values: a `.get()` that follows
// each link collapses to `undefined` the moment one element lives in a space
// this runtime has not loaded, which a freshly created profile's always is.
// Mirrors `profileLinkListSchema()` in profile-create.tsx.
const profileLinkListSchema = {
  type: "array",
  items: { type: "unknown", asCell: ["cell"] },
  // deno-lint-ignore no-explicit-any
} as any;

/** The spaces the home root's `profiles` list links into, one per profile. */
function profileSpaces(root: Cell<unknown>): Map<string, Cell<unknown>> {
  const links = (root.key("profiles").asSchema(profileLinkListSchema)
    .get() ?? []) as Cell<unknown>[];
  return new Map(
    links.map((link) => [link.getAsNormalizedFullLink().space, link]),
  );
}

/**
 * Sends the trusted create event on the home root's `createProfile` stream
 * and resolves with the transaction the handler committed.
 *
 * The append's own outcome is not the answer: the handler runs after the
 * append, and the profile exists once the handler's transaction — a
 * multi-space commit, since the profile is born in its own space — has
 * committed. A refused append is the one outcome that never reaches a commit
 * callback, so it rejects here.
 */
function sendCreate(
  root: Cell<unknown>,
  name: string,
): Promise<IExtendedStorageTransaction> {
  const event = buildActionEvent({ name }, {
    surface: PROFILE_CREATE_SURFACE,
    action: PROFILE_CREATE_ACTION,
  });
  return new Promise((resolve, reject) => {
    try {
      // deno-lint-ignore no-explicit-any
      (root.key("createProfile") as Cell<any>).send(event, resolve, {
        onAppended: (delivery, appendedTx) => {
          if (!delivery.delivered && appendedTx.status().status !== "error") {
            reject(new Error(`event append refused: ${delivery.refused}`));
          }
        },
      });
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Creates a profile named `config.name` in the home space of
 * `config.identity`, and returns where it landed.
 *
 * `config.space` is the identity's home space: the home root owns the
 * profile list, and a profile created against any other root would be one
 * nothing resolves. The root is ensured and started first, since the
 * handler runs in this process.
 *
 * @throws Error when the handler's commit fails, or when the list carries no
 * new profile after it — the shape a refused owner-protected write arrives
 * in, since the runtime records the refusal on the transaction it rejected.
 */
export async function createProfile(
  config: ProfileCreateConfig,
  deps: CreateProfileDeps = {},
): Promise<CreatedProfile> {
  const name = config.name.trim();
  if (name.length === 0) {
    throw new Error("A profile needs a name.");
  }
  const pieces = await (deps.loadPieces ?? loadPieces)(config);
  const home = await pieces.ensureDefaultPattern();
  // Rebound to no transaction: the controller's cell rides a read
  // transaction, and a send opens a writable one of its own.
  const root = (home.getCell() as Cell<unknown>).withTx();
  await root.sync();
  const before = profileSpaces(root);

  const committed = await sendCreate(root, name);
  const status = committed.status();
  if (status.status === "error") {
    throw new Error(
      `Creating profile "${name}" failed: ${
        "message" in status.error
          ? String(status.error.message)
          : String(status.error)
      }`,
    );
  }
  // The append lands through the handler's cross-space commit and the
  // retry rounds behind it; the list is read once the runtime is idle and
  // storage has caught up, not off the transaction the send resolved with.
  await pieces.runtime.idle();
  await pieces.synced();
  await root.sync();

  const created = [...profileSpaces(root)].find(([space]) =>
    !before.has(space)
  );
  if (created === undefined) {
    throw new Error(
      `Creating profile "${name}" committed, but the home root's ` +
        "`profiles` list carries no new profile.",
    );
  }
  const [space, link] = created;
  const normalized = link.getAsNormalizedFullLink();
  return {
    name,
    space,
    id: normalized.id,
    address: canonicalAddress({
      space,
      id: normalized.id,
      scope: normalized.scope ?? "space",
    }),
  };
}
