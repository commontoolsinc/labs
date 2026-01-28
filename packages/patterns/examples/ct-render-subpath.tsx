/// <cts-enable />
/**
 * Test pattern for ct-render subpath behavior.
 *
 * This pattern tests the fix for the ct-render regression where subpath cells
 * like .key("sidebarUI") that intentionally return undefined were being
 * incorrectly blocked by the async-loading detection logic.
 *
 * The pattern has:
 * - A main UI (always present)
 * - sidebarUI: explicitly undefined (should NOT block rendering)
 * - previewUI: a valid UI (should render when accessed via variant)
 */
import { computed, Default, NAME, pattern, UI } from "commontools";

interface State {
  title: Default<string, "Test Pattern">;
}

export default pattern<State>((state) => {
  return {
    [NAME]: computed(() => `Subpath Test: ${state.title}`),
    [UI]: (
      <div id="main-ui">
        <h1>{state.title}</h1>
        <p>This is the main UI. sidebarUI is intentionally undefined.</p>
      </div>
    ),
    // Explicitly undefined - ct-render should NOT wait forever for this
    // For now, exclude the sidebarUI property entirely -- having it in our
    // returned value makes the transformer think it should be required,
    // but since it's undefined, our object won't match the schema.
    //sidebarUI: undefined,
    // Valid UI for testing variant rendering
    previewUI: (
      <div id="preview-ui">
        <span>Preview: {state.title}</span>
      </div>
    ),
    title: state.title,
  };
});
