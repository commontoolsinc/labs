/// <cts-enable />
import { NAME, pattern, UI } from "commontools";

export default pattern((_) => {
  return {
    [NAME]: `Home`,
    [UI]: (
      <h1>
        home<strong>space</strong>
      </h1>
    ),
  };
});
