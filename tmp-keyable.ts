import type { Cell } from "@commontools/api";

declare const cell: Cell<{
  user: {
    profile: {
      name: string;
      metadata: Cell<Record<string, unknown>>;
    };
  };
}>;

const userCell = cell.key("user");

type IsAny<T> = 0 extends (1 & T) ? true : false;

const _shouldBeFalse: IsAny<typeof userCell> = true;
