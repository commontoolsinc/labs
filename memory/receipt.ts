import { Receipt } from "./interface.ts";

/**
 * Formats receipt to a string representation.
 */
export const toString = <
  Command extends NonNullable<unknown>,
  Result extends NonNullable<unknown>,
  Effect,
>(
  receipt: Receipt<Command, Result, Effect>,
) => JSON.stringify(receipt);

/**
 * Parses receipt from a string representation.
 */
export const fromString = <
  Command extends NonNullable<unknown>,
  Result extends NonNullable<unknown>,
  Effect,
>(
  source: string,
): Receipt<Command, Result, Effect> => JSON.parse(source);

export const fromStringStream = <
  Command extends NonNullable<unknown>,
  Result extends NonNullable<unknown>,
  Effect,
>() =>
  new TransformStream<string, Receipt<Command, Result, Effect>>({
    transform(source, controller) {
      controller.enqueue(fromString(source));
    },
  });

export const toStringStream = <
  Command extends NonNullable<unknown>,
  Result extends NonNullable<unknown>,
  Effect,
>() =>
  new TransformStream<Receipt<Command, Result, Effect>, string>({
    transform(source, controller) {
      controller.enqueue(toString(source));
    },
  });
