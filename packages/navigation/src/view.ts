import { DID, isDID } from "@commonfabric/identity";
import { isSlugAddress } from "@commonfabric/runner/slugs";

export type AppBuiltInView = "home";

export type AppViewMode = "embed";

const EMBED_PATH_PREFIX = ".embed";

export type PieceViewRef = {
  pieceId?: string;
  pieceSlug?: string;
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
  if ("spaceName" in view) {
    return typeof view.spaceName === "string" && !!view.spaceName &&
      !("pieceId" in view && "pieceSlug" in view);
  }
  if ("spaceDid" in view) {
    return isDID(view.spaceDid) && !("pieceId" in view && "pieceSlug" in view);
  }
  return false;
}

function isAppViewModeRef(view: object): view is AppViewModeRef {
  return !("mode" in view) || view.mode === "embed";
}

export function isAppViewEqual(a: AppView, b: AppView): boolean {
  if (a === b) return true;
  return JSON.stringify(a) === JSON.stringify(b);
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
    const pieceSlug = "pieceSlug" in view ? view.pieceSlug : undefined;
    const pieceId = "pieceId" in view ? view.pieceId : undefined;
    return pieceSlug
      ? `${prefix}/${view.spaceName}/${pieceSlug}`
      : pieceId
      ? `${prefix}/${view.spaceName}/${pieceId}`
      : `${prefix}/${view.spaceName}`;
  } else if ("spaceDid" in view) {
    const pieceSlug = "pieceSlug" in view ? view.pieceSlug : undefined;
    const pieceId = "pieceId" in view ? view.pieceId : undefined;
    return pieceSlug
      ? `${prefix}/${view.spaceDid}/${pieceSlug}`
      : pieceId
      ? `${prefix}/${view.spaceDid}/${pieceId}`
      : `${prefix}/${view.spaceDid}`;
  }
  return `/`;
}

export function urlToAppView(url: URL): AppView {
  const segments = url.pathname.split("/");
  segments.shift(); // shift off the pathnames' prefix "/";
  const mode = segments[0] === EMBED_PATH_PREFIX ? "embed" : undefined;
  if (mode) segments.shift();
  const [first, pieceId] = [segments[0], segments[1]];
  const modeRef: AppViewModeRef = mode ? { mode } : {};
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
      ? { spaceDid: first, pieceSlug: pieceId, ...modeRef, ...openRef }
      : { spaceDid: first, pieceId, ...modeRef, ...openRef };
  } else {
    if (!pieceId) return { spaceName: first, ...modeRef, ...openRef };
    return isSlugAddress(pieceId)
      ? { spaceName: first, pieceSlug: pieceId, ...modeRef, ...openRef }
      : { spaceName: first, pieceId, ...modeRef, ...openRef };
  }
}
