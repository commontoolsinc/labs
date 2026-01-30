/// <cts-enable />
import {
  Default,
  handler,
  NAME,
  pattern,
  Stream,
  UI,
  Writable,
} from "commontools";

interface State {
  data: Default<string, "Initial test data">;
  counter: Default<number, 0>;
}

interface WritableState {
  data: Writable<Default<string, "Initial test data">>;
  counter: Writable<Default<number, 0>>;
}

interface Output {
  data: string;
  counter: number;
  updateData: Stream<void>;
}

const updateData = handler<void, WritableState>((_event, state) => {
  const newCount = (state.counter.get() ?? 0) + 1;
  state.counter.set(newCount);
  state.data.set(
    `Updated data #${newCount} - ${Temporal.Now.instant().toString()}`,
  );
});

export default pattern<State, Output>((state) => {
  return {
    [NAME]: "Autosave Test",
    [UI]: (
      <div style="padding: 20px; font-family: sans-serif;">
        <h1>Autosave Test Pattern</h1>
        <p data-testid="data-display">Data: {state.data}</p>
        <p data-testid="counter-display">Counter: {state.counter}</p>

        <div style="display: flex; gap: 10px; margin-top: 20px;">
          <ct-button data-testid="update-btn" onClick={updateData(state)}>
            Update Data
          </ct-button>

          <ct-file-download
            data-testid="autosave-btn"
            allowAutosave
            $data={state.data}
            filename="autosave-test.txt"
            mimeType="text/plain"
            variant="primary"
          >
            Download (Option+click for autosave)
          </ct-file-download>

          <ct-file-download
            data-testid="no-autosave-btn"
            $data={state.data}
            filename="no-autosave.txt"
            mimeType="text/plain"
            variant="secondary"
          >
            No Autosave Button
          </ct-file-download>
        </div>

        <div style="margin-top: 20px; padding: 15px; background: #f5f5f5; border-radius: 8px;">
          <h3>Test Instructions:</h3>
          <ol>
            <li>Click "Download" normally to test regular download</li>
            <li>
              Option+click (Alt+click) on the PRIMARY button to enable autosave
              (will open folder picker)
            </li>
            <li>
              Option+click on "No Autosave Button" to see the shake feedback
            </li>
            <li>
              After enabling autosave, click "Update Data" to see the pending
              indicator (amber pulsing dot)
            </li>
            <li>
              Option+click again on the PRIMARY button to disable autosave
            </li>
          </ol>
        </div>
      </div>
    ),
    data: state.data,
    counter: state.counter,
    updateData: updateData(state),
  };
});
