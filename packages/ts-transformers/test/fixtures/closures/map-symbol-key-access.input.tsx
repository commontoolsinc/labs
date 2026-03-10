/// <cts-enable />
import { NAME, UI, pattern } from "commontools";

interface Entry {
  [NAME]: string;
  [UI]: string;
}

interface Input {
  items: Entry[];
}

const _p = pattern<Input>(({ items }) =>
  items.map((item) => ({ n: item[NAME], u: item[UI] }))
);
