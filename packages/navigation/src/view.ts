import { DID, isDID } from "@commonfabric/identity";
import { asSpaceSegment } from "@commonfabric/runner/fabric-url";
import { isSlugAddress, isValidSlug } from "@commonfabric/runner/slugs";

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

  /**
   * The segments an address carries past its member, joined as written:
   * `/<space>/top/42/comments/7` holds the member `42` and this `comments/7`.
   * Only the member is read out of an address, so these are carried rather
   * than read, and a view holding them addresses nothing that opens. Carrying
   * them is what keeps such a view from being the view of the member alone,
   * and what lets whoever opens it name them in refusing it.
   */
  pieceExtraPath?: string;
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
 *
 * A member is held to the grammar the name in front of it answers to, which
 * `docs/specs/collection-naming.md` fixes as the slug grammar for both. That
 * is what makes a member one URL segment: `appViewToUrlPath` writes it
 * verbatim and `urlToAppView` reads it back verbatim, so a value carrying a
 * separator, resolving away, or reading as empty would name something other
 * than what it says — an empty member addresses the collection's own piece
 * rather than a member of it.
 *
 * Segments past a member are held only beside a member, because they are
 * written after it: without one, `appViewToUrlPath` would put them where a
 * member goes, and the address would read back as naming that member. Their
 * own spelling is not held to a grammar, since a view carrying them is refused
 * by them rather than resolved through them.
 */
function isPieceViewRef(view: object): view is PieceViewRef {
  if ("pieceId" in view && "pieceSlug" in view) return false;
  const member = "pieceMember" in view ? view.pieceMember : undefined;
  const slug = "pieceSlug" in view ? view.pieceSlug : undefined;
  const extraPath = "pieceExtraPath" in view ? view.pieceExtraPath : undefined;
  const memberHeld = member === undefined ||
    (typeof member === "string" && isValidSlug(member) &&
      typeof slug === "string" && !!slug);
  return memberHeld &&
    (extraPath === undefined ||
      (typeof extraPath === "string" && !!extraPath && member !== undefined));
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
 * carries none, a member being a collection's name for one of its own. The
 * segments past a member follow it as they were written, so a page refused by
 * them keeps the address that named them.
 */
function pieceUrlSegments(view: PieceViewRef): string {
  const pieceSlug = "pieceSlug" in view ? view.pieceSlug : undefined;
  const pieceId = "pieceId" in view ? view.pieceId : undefined;
  const pieceMember = "pieceMember" in view ? view.pieceMember : undefined;
  const pieceExtraPath = "pieceExtraPath" in view
    ? view.pieceExtraPath
    : undefined;
  if (pieceSlug) {
    if (!pieceMember) return `/${pieceSlug}`;
    return pieceExtraPath
      ? `/${pieceSlug}/${pieceMember}/${pieceExtraPath}`
      : `/${pieceSlug}/${pieceMember}`;
  }
  return pieceId ? `/${pieceId}` : "";
}

export function urlToAppView(url: URL): AppView {
  const segments = url.pathname.split("/");
  segments.shift(); // shift off the pathnames' prefix "/";
  const mode = segments[0] === EMBED_PATH_PREFIX ? "embed" : undefined;
  if (mode) segments.shift();
  // A leading `@` marks the space, which is how a reference that travels is
  // written: `/@<space>/<collection>/<member>` is the spelling the header
  // hands out, and it addresses what `/<space>/<collection>/<member>` does.
  // The mark is the whole difference, so it comes off and the segment reads
  // as any other space does — which leaves a segment that is nothing but the
  // mark naming no space, the address a bare origin already carries.
  const first = segments[0] === undefined
    ? undefined
    : asSpaceSegment(segments[0]) ?? segments[0];
  const pieceId = segments[1];
  const modeRef: AppViewModeRef = mode ? { mode } : {};
  // The segment after a slug selects a member of the collection it names.
  // Reading it apart from resolving it is what keeps this pure: whether the
  // slug names a collection at all is the resolver's question. Exactly one
  // segment reaches a member, and nothing past it is read. What is past it is
  // still part of what the address says, so it is carried as written — a
  // trailing separator adds nothing — and the view is not the member's alone.
  const member = segments[2] || undefined;
  const extraPath = member
    ? segments.slice(3).join("/") || undefined
    : undefined;
  const memberRef: PieceViewRef = member
    ? {
      pieceMember: member,
      ...(extraPath ? { pieceExtraPath: extraPath } : {}),
    }
    : {};
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
