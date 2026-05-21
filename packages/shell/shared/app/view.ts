import { DID, isDID } from "@commonfabric/identity";
import { isSlugAddress } from "@commonfabric/runner";

export type AppBuiltInView = "home";

export type PieceViewRef = {
  pieceId?: string;
  pieceSlug?: string;
};

export type AppView = {
  builtin: AppBuiltInView;
} | ({
  spaceName: string;
} & PieceViewRef) | ({
  spaceDid: DID;
} & PieceViewRef);

export function isAppBuiltInView(view: unknown): view is AppBuiltInView {
  switch (view as AppBuiltInView) {
    case "home":
      return true;
  }
  return false;
}

export function isAppView(view: unknown): view is AppView {
  if (!view || typeof view !== "object") return false;
  if ("builtin" in view) return isAppBuiltInView(view.builtin);
  if ("spaceName" in view) {
    return typeof view.spaceName === "string" && !!view.spaceName &&
      !("pieceId" in view && "pieceSlug" in view);
  }
  if ("spaceDid" in view) {
    return isDID(view.spaceDid) && !("pieceId" in view && "pieceSlug" in view);
  }
  return false;
}

export function isAppViewEqual(a: AppView, b: AppView): boolean {
  if (a === b) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

export function appViewToUrlPath(view: AppView): `/${string}` {
  if ("builtin" in view) {
    switch (view.builtin) {
      case "home":
        return `/`;
    }
  } else if ("spaceName" in view) {
    return "pieceSlug" in view && view.pieceSlug
      ? `/${view.spaceName}/${view.pieceSlug}`
      : "pieceId" in view
      ? `/${view.spaceName}/${view.pieceId}`
      : `/${view.spaceName}`;
  } else if ("spaceDid" in view) {
    return "pieceSlug" in view && view.pieceSlug
      ? `/${view.spaceDid}/${view.pieceSlug}`
      : "pieceId" in view
      ? `/${view.spaceDid}/${view.pieceId}`
      : `/${view.spaceDid}`;
  }
  return `/`;
}

export function urlToAppView(url: URL): AppView {
  const segments = url.pathname.split("/");
  segments.shift(); // shift off the pathnames' prefix "/";
  const [first, pieceId] = [segments[0], segments[1]];

  if (!first) {
    return { builtin: "home" };
  }
  if (isDID(first)) {
    if (!pieceId) return { spaceDid: first };
    return isSlugAddress(pieceId)
      ? { spaceDid: first, pieceSlug: pieceId }
      : { spaceDid: first, pieceId };
  } else {
    if (!pieceId) return { spaceName: first };
    return isSlugAddress(pieceId)
      ? { spaceName: first, pieceSlug: pieceId }
      : { spaceName: first, pieceId };
  }
}
