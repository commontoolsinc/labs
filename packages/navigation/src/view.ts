import { DID, isDID } from "@commonfabric/identity";
import { isSlugAddress } from "@commonfabric/runner/slugs";

export type AppBuiltInView = "home";

export type AppViewMode = "embed";

const EMBED_PATH_PREFIX = ".embed";

export type PieceViewRef = {
  pieceId?: string;
  pieceSlug?: string;

  /**
   * The member `pieceSlug` names, when that slug names a collection rather
   * than a piece: `/<space>/top/42` holds the slug `top` and the member `42`.
   * One segment reaches a member, so a member's own fields never compete for
   * it, and a view carrying one without a slug addresses nothing.
   */
  pieceMember?: string;
};

export type AppViewModeRef = {
  mode?: AppViewMode;
};

export type AppOpenPathRef = {
  /** One-shot deep link: a target the piece should open on load, captured
   * from `?path=` at boot. Consumed by the shell after the piece loads and
   * never re-emitted into a URL (`appViewToUrlPath` ignores it), so
   * reloads and internal navigation stay clean. */
  openPath?: string;
};

export type AppView =
  | {
    builtin: AppBuiltInView;
  }
  | (
    & {
      spaceName: string;
    }
    & PieceViewRef
    & AppViewModeRef
    & AppOpenPathRef
  )
  | (
    & {
      spaceDid: DID;
    }
    & PieceViewRef
    & AppViewModeRef
    & AppOpenPathRef
  );

export function isAppBuiltInView(view: unknown): view is AppBuiltInView {
  switch (view as AppBuiltInView) {
    case "home":
      return true;
  }
  return false;
}

export function isAppView(view: unknown): view is AppView {
  if (!view || typeof view !== "object") return false;
  if ("builtin" in view) {
    return isAppBuiltInView(view.builtin) && !("mode" in view);
  }
  if (!isAppViewModeRef(view)) return false;
  if (!isPieceViewRef(view)) return false;
  if ("spaceName" in view) {
    return typeof view.spaceName === "string" && !!view.spaceName;
  }
  if ("spaceDid" in view) {
    return isDID(view.spaceDid);
  }
  return false;
}

function isAppViewModeRef(view: object): view is AppViewModeRef {
  return !("mode" in view) || view.mode === "embed";
}

/**
 * Whether a view's piece reference addresses one thing: an id or a slug but
 * never both, and a member only under the slug whose collection holds it.
 */
function isPieceViewRef(view: object): view is PieceViewRef {
  if ("pieceId" in view && "pieceSlug" in view) return false;
  const member = "pieceMember" in view ? view.pieceMember : undefined;
  const slug = "pieceSlug" in view ? view.pieceSlug : undefined;
  return member === undefined ||
    (typeof member === "string" && typeof slug === "string" && !!slug);
}

/**
 * Whether two views address the same thing. Two views are equal when they hold
 * the same fields with the same values, whatever order the route or control
 * that built them wrote those fields in. Every value a view holds is a string,
 * so the values compare by their contents. A field holding `undefined` counts
 * as absent, which is what a URL or a history entry keeps of one.
 */
export function isAppViewEqual(a: AppView, b: AppView): boolean {
  if (a === b) return true;
  const held = (view: AppView) =>
    new Map(Object.entries(view).filter(([, value]) => value !== undefined));
  const fields = held(a);
  const other = held(b);
  return fields.size === other.size &&
    [...fields].every(([name, value]) => other.get(name) === value);
}

export function isEmbeddedView(view: AppView): boolean {
  return "mode" in view && view.mode === "embed";
}

export function preserveAppViewMode(
  currentView: AppView,
  nextView: AppView,
): AppView {
  if (!isEmbeddedView(currentView) || "builtin" in nextView) {
    return nextView;
  }
  if ("mode" in nextView) {
    return nextView;
  }
  return { ...nextView, mode: "embed" };
}

export function isViewingDefaultPatternView(view: AppView): boolean {
  return !(
    ("pieceId" in view && view.pieceId) ||
    ("pieceSlug" in view && view.pieceSlug)
  );
}

export function appViewToUrlPath(view: AppView): `/${string}` {
  const prefix = isEmbeddedView(view) ? `/${EMBED_PATH_PREFIX}` : "";
  if ("builtin" in view) {
    switch (view.builtin) {
      case "home":
        return `/`;
    }
  } else if ("spaceName" in view) {
    return `${prefix}/${view.spaceName}${pieceUrlSegments(view)}`;
  } else if ("spaceDid" in view) {
    return `${prefix}/${view.spaceDid}${pieceUrlSegments(view)}`;
  }
  return `/`;
}

/**
 * The segments a view's piece reference adds after its space, empty for a
 * view naming no piece. A member follows the slug it belongs to; an id
 * carries none, a member being a collection's name for one of its own.
 */
function pieceUrlSegments(view: PieceViewRef): string {
  const pieceSlug = "pieceSlug" in view ? view.pieceSlug : undefined;
  const pieceId = "pieceId" in view ? view.pieceId : undefined;
  const pieceMember = "pieceMember" in view ? view.pieceMember : undefined;
  if (pieceSlug) {
    return pieceMember ? `/${pieceSlug}/${pieceMember}` : `/${pieceSlug}`;
  }
  return pieceId ? `/${pieceId}` : "";
}

export function urlToAppView(url: URL): AppView {
  const segments = url.pathname.split("/");
  segments.shift(); // shift off the pathnames' prefix "/";
  const mode = segments[0] === EMBED_PATH_PREFIX ? "embed" : undefined;
  if (mode) segments.shift();
  const [first, pieceId] = [segments[0], segments[1]];
  const modeRef: AppViewModeRef = mode ? { mode } : {};
  // The segment after a slug selects a member of the collection it names.
  // Reading it apart from resolving it is what keeps this pure: whether the
  // slug names a collection at all is the resolver's question. Exactly one
  // segment reaches a member, so anything past it is no part of the address.
  const member = segments[2] || undefined;
  const memberRef: PieceViewRef = member ? { pieceMember: member } : {};
  // `?path=` is the piece deep link (e.g. a cabinet page Mobile Loom should
  // open). Captured here — the only place the query survives boot — and
  // delivered once by the shell after the piece loads.
  const openPath = url.searchParams.get("path") || undefined;
  const openRef: AppOpenPathRef = openPath ? { openPath } : {};

  if (!first) {
    return { builtin: "home" };
  }
  if (isDID(first)) {
    if (!pieceId) return { spaceDid: first, ...modeRef, ...openRef };
    return isSlugAddress(pieceId)
      ? {
        spaceDid: first,
        pieceSlug: pieceId,
        ...memberRef,
        ...modeRef,
        ...openRef,
      }
      : { spaceDid: first, pieceId, ...modeRef, ...openRef };
  } else {
    if (!pieceId) return { spaceName: first, ...modeRef, ...openRef };
    return isSlugAddress(pieceId)
      ? {
        spaceName: first,
        pieceSlug: pieceId,
        ...memberRef,
        ...modeRef,
        ...openRef,
      }
      : { spaceName: first, pieceId, ...modeRef, ...openRef };
  }
}
