// Server URL. Defaults to `http://localhost:8000`
export const API_URL = ensureTrailing(
  Deno.env.get("API_URL") ?? "http://localhost:8000",
);

// Frontend URL. Defaults to `API_URL`.
// Only needs to differ from `API_URL` when running
// integration tests via a dev shell build
// e.g. `http://localhost:5173`.
export const FRONTEND_URL = ensureTrailing(
  Deno.env.get("FRONTEND_URL") ?? API_URL,
);

export const HEADLESS = envToBool(Deno.env.get("HEADLESS"));

function ensureTrailing(value: string): string {
  return value.substr(-1) === "/" ? value : `${value}/`;
}

function envToBool(value?: string): boolean {
  return value ? (value === "true" || value === "1") : false;
}
