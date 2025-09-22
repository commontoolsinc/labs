/// <cts-enable />
import {
  Cell,
  cell,
  Default,
  derive,
  h,
  handler,
  ifElse,
  lift,
  NAME,
  navigateTo,
  recipe,
  toSchema,
  UI,
} from "commontools";

// note: you may need to zoom in our out in the browser to see the
// content and/or tabs
export default recipe(
  "Aside",
  () => {
    return {
      [NAME]: "Aside",
      [UI]: (
        // ct-screen provides a full-height layout with header/main/footer areas
        <ct-screen>
          {/* Header slot - fixed at top */}
          <div slot="header">
            <h2>Header Section</h2>
          </div>

          {/* ct-autolayout creates responsive multi-panel layout with optional sidebars */}
          {/* tabNames: Labels for main content panels (shown as tabs on mobile) */}
          {/* Shows all panels side-by-side in a grid */}
          <ct-autolayout tabNames={["Main", "Second"]}>
            {/* Left sidebar - use slot="left" */}
            <aside slot="left">
              <h3>Left Sidebar</h3>
              <p>Left content</p>
              <ct-button>Left Button</ct-button>
            </aside>

            {/* Main content panels - no slot attribute needed */}
            {/* Number of divs should match number of tabNames */}
            <div>
              <h1>Main Content Area</h1>
              <p>This is the main content with sidebars</p>
              <ct-button>Main Button</ct-button>
            </div>

            <div>
              <h1>Second Content Area</h1>
              <p>This is the second content with sidebars</p>
              <ct-button>Second Button</ct-button>
            </div>

            {/* Right sidebar - use slot="right" */}
            <aside slot="right">
              <h3>Right Sidebar</h3>
              <p>Right content</p>
              <ct-button>Right Button</ct-button>
            </aside>
          </ct-autolayout>

          {/* Footer slot - fixed at bottom */}
          <div slot="footer">
            <p>Footer Section</p>
          </div>
        </ct-screen>
      ),
    };
  },
);
