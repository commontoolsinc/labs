/// <cts-enable />
import { handler, recipe, UI } from "commontools";

declare global {
  namespace JSX {
    interface IntrinsicElements {
      "ct-button": any;
    }
  }
}

interface State {
  count: number;
}

const existing = handler((_event, { state }: { state: State }) => {
  console.log(state.count);
});

export default recipe<State>("Existing", (state) => {
  return {
    [UI]: (
      <ct-button onClick={existing({ state })}>
        Existing
      </ct-button>
    ),
  };
});
