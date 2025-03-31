import { generatePath, matchPath } from "react-router-dom";

// Define route patterns using React Router syntax
export const ROUTES = {
  root: "/",
  defaultReplica: "/common-knowledge",
  replicaRoot: "/:replicaName",
  charmShow: "/:replicaName/:charmId",
  stackedCharms: "/:replicaName/stack/:charmIds",
  charmDetail: "/:replicaName/:charmId/detail",
  spellbookIndex: "/spellbook",
  spellbookDetail: "/spellbook/:spellId",
  spellbookLaunch: "/spellbook/launch/:replicaName/:spellId",
  utilityJsonGen: "/utility/json-gen",
  inspector: "/inspector",
} as const;

// Infer parameter types from route patterns
type RouteParams<T extends string> = string extends T ? Record<string, string>
  : T extends `${string}:${infer Param}/${infer Rest}`
    ? { [K in Param | keyof RouteParams<Rest>]: string }
  : T extends `${string}:${infer Param}` ? { [K in Param]: string }
  : unknown;

// Create a type map for all route parameters
export type RouteParamsMap = {
  [K in keyof typeof ROUTES]: RouteParams<(typeof ROUTES)[K]>;
};

// Create the URL builder functions
export const createPath = <T extends keyof typeof ROUTES>(
  route: T,
  params?: RouteParamsMap[T],
) => generatePath(ROUTES[route], params || ({} as any));

// Optional: Create type guard for checking if a path matches a route
export const matchesRoute = <T extends keyof typeof ROUTES>(
  route: T,
  path: string,
): path is string => {
  return matchPath(ROUTES[route], path) !== null;
};

export function createPathWithQuery<T extends keyof typeof ROUTES>(
  route: T,
  params?: RouteParamsMap[T],
  query?: Record<string, string>,
) {
  const path = createPath(route, params);
  if (!query) return path;

  const searchParams = new URLSearchParams(query);
  return `${path}?${searchParams.toString()}`;
}

export function createPathWithHash<T extends keyof typeof ROUTES>(
  route: T,
  params?: RouteParamsMap[T],
  hash?: string,
) {
  const path = createPath(route, params);
  if (!hash) return path;

  return `${path}#${hash}`;
}

/**
 * Attempts to match the route that has replica name in them and returns params
 * or `{}` otherwise.
 */
export const matchSpace = (path: string): { replicaName?: string } =>
  matchPath(ROUTES.replicaRoot, path)?.params ??
    matchPath(ROUTES.charmShow, path)?.params ??
    matchPath(ROUTES.stackedCharms, path)?.params ??
    matchPath(ROUTES.charmDetail, path)?.params ??
    {};

export type CharmRouteParams = {
  charmId: string;
  replicaName?: string;
};

export type StackedCharmsRouteParams = {
  charmIds: string;
};
