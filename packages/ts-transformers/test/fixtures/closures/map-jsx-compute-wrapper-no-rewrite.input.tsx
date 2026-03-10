/// <cts-enable />
import { pattern, UI } from "commontools";

export default pattern<{ list: string[] }>(({ list }) => {
  return {
    [UI]: <div>{[0, 1].forEach(() => list.map((item) => item))}</div>,
  };
});
