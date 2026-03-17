import type { Cell } from "../cell.ts";
import type { JSONSchema } from "../builder/types.ts";

/** The shape of fetchData's input cell. */
export type FetchDataInputs = {
  url?: string;
  mode?: "text" | "json";
  options?: {
    body?: unknown;
    method?: string;
    headers?: Record<string, string>;
  };
};

export type NormalizedFetchDataInputs = {
  url?: string;
  mode?: "text" | "json";
  options?: {
    body?: string;
    method?: string;
    headers?: Record<string, string>;
  };
};

/**
 * Schema for fetchData inputs. Fully specifying the structure (except body,
 * which is `any`) lets cell.asSchema(schema).get() materialize nested
 * properties like options.headers as plain objects instead of proxies.
 */
export const fetchDataInputSchema = {
  type: "object",
  properties: {
    url: { type: "string" },
    mode: { type: "string" },
    options: {
      type: "object",
      properties: {
        body: {},
        method: { type: "string" },
        headers: {
          type: "object",
          additionalProperties: { type: "string" },
        },
      },
    },
  },
} as const satisfies JSONSchema;

export function normalizeFetchDataInputs(
  snapshot: FetchDataInputs | undefined,
): NormalizedFetchDataInputs {
  const mode = snapshot?.mode === "text" || snapshot?.mode === "json"
    ? snapshot.mode
    : undefined;
  const body = snapshot?.options?.body;
  const options = snapshot?.options
    ? {
      ...snapshot.options,
      body: body !== undefined && typeof body !== "string"
        ? JSON.stringify(body)
        : body,
    }
    : undefined;
  return { url: snapshot?.url, mode, options };
}

export function snapshotFetchDataInputs(
  cell: Cell<FetchDataInputs>,
): NormalizedFetchDataInputs {
  return normalizeFetchDataInputs(
    (cell.asSchema(fetchDataInputSchema).get() as
      | FetchDataInputs
      | undefined) ??
      ({} as FetchDataInputs),
  );
}
