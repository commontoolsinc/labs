/// <cts-enable />
import { pattern, UI } from "commontools";

export default pattern<{ value: number }>(({ value }) => {
  return {
    [UI]: <button type="button" onClick={() => console.log(value)}>Log</button>,
  };
});
