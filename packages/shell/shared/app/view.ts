import { DID, isDID } from "@commontools/identity";

export type AppBuiltInView = "home";

export type AppView = {
  builtin: AppBuiltInView;
} | {
  spaceName: string;
  pieceId?: string;
} | {
  spaceDid: DID;
  pieceId?: string;
};

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
    return typeof view.spaceName === "string" && !!view.spaceName;
  }
  if ("spaceDid" in view) return isDID(view.spaceDid);
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
    return "pieceId" in view
      ? `/${view.spaceName}/${view.pieceId}`
      : `/${view.spaceName}`;
  } else if ("spaceDid" in view) {
    return "pieceId" in view
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
    return pieceId ? { spaceDid: first, pieceId } : { spaceDid: first };
  } else {
    return pieceId ? { spaceName: first, pieceId } : { spaceName: first };
  }
}
