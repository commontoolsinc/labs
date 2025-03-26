import { fromJSON, refer } from "merkle-reference";

export interface Entity<T extends null | NonNullable<unknown>> {
  "@": ToString<Entity<T>>;
}

/**
 * Phantom string type that can captures type parameter.
 */
export type ToString<T> = string & { toString(): ToString<T> };

export const entity = <T extends null | NonNullable<unknown>>(
  description: NonNullable<unknown> | null,
): Entity<T> => {
  return { "@": refer(description).toJSON()["/"] };
};

export const toString = <T extends null | NonNullable<unknown>>(
  entity: Entity<T>,
): string => `@${entity["@"]}`;

export const fromString = <T extends null | NonNullable<unknown>>(
  source: string | ToString<Entity<T>>,
): Entity<T> => {
  if (!source.startsWith("@")) {
    throw new TypeError(
      `Expected formatted entity which starts with @ character instead got ${
        JSON.stringify(
          source,
        )
      }`,
    );
  } else {
    return { "@": fromJSON({ "/": source.slice(1) }).toJSON()["/"] };
  }
};

/**
 * Asserts type of the `source` to be an `Entity`.
 */
export const is = <T extends null | NonNullable<unknown>>(
  source: unknown | Entity<T>,
): source is Entity<T> =>
  source != null && typeof (source as { ["@"]?: string })["@"] === "string";
