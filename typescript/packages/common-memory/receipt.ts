import { Receipt } from "./interface.ts";

/**
 * Formats receipt to a string representation.
 */
export const toString = <Command extends {}, Result extends {}, Effect>(
  receipt: Receipt<Command, Result, Effect>,
) => JSON.stringify(receipt);

/**
 * Parses receipt from a string representation.
 */
export const fromString = <Command extends {}, Result extends {}, Effect>(
  source: string,
): Receipt<Command, Result, Effect> => JSON.parse(source);

export const fromStringStream = <
  Command extends {},
  Result extends {},
  Effect,
>() =>
  new TransformStream<string, Receipt<Command, Result, Effect>>({
    transform(source, controller) {
      controller.enqueue(fromString(source));
    },
  });

export const toStringStream = <
  Command extends {},
  Result extends {},
  Effect,
>() =>
  new TransformStream<Receipt<Command, Result, Effect>, string>({
    transform(source, controller) {
      controller.enqueue(toString(source));
    },
  });
