/// <cts-enable />
import { pattern, UI } from "commontools";

export default pattern<{ list: string[] }>(({ list }) => {
  return {
    [UI]: (
      <div>
        {[0, 1].forEach(() => {
          const project = (value: string) => value.toUpperCase();
          return list.map((item) => project(item));
        })}
      </div>
    ),
  };
});
