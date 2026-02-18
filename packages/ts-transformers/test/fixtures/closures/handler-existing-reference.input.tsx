/// <cts-enable />
import { handler, pattern, UI } from "commontools";

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

export default pattern<State>((state) => {
  return {
    [UI]: (
      <ct-button onClick={existing({ state })}>
        Existing
      </ct-button>
    ),
  };
});
