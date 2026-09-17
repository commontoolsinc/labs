/// <cts-enable />
import { Cell, Default, handler, NAME, navigateTo, pattern, str, UI } from "commontools";

/**
 * Simple Nav Test Pattern
 *
 * Features:
 * - Text field to enter a name
 * - Button that creates a new instance of this pattern with that name
 * - Uses navigateTo to navigate to the new instance
 */

interface Input {
  label: Default<string, "Unnamed">;
}

// Need to define the pattern first, then reference it in the handler
// Using a forward declaration approach

// Handler to create a new instance and navigate to it
const createAndNavigate = handler<
  unknown,
  { inputText: Cell<string> }
>(
  (_event, { inputText }) => {
    const name = inputText.get().trim();
    if (!name) {
      console.log("[Handler] No name entered, skipping navigation");
      return;
    }

    console.log("[Handler] Creating new instance with name:", name);

    // Create a new instance of this pattern with the entered name
    const newInstance = NavTestPattern({
      label: name,
    });

    console.log("[Handler] Navigating to new instance...");
    return navigateTo(newInstance);
  }
);

// The main pattern
const NavTestPattern = pattern<Input, Input>(
  ({ label }) => {
    // Local cell to hold the text input value
    const inputText = Cell.of("");

    return {
      [NAME]: str`Nav Test: ${label}`,
      [UI]: (
        <div style={{ padding: "2rem", maxWidth: "400px", margin: "0 auto" }}>
          <h2 style={{ marginBottom: "1rem" }}>
            Current: {label}
          </h2>

          <div style={{ marginBottom: "1rem" }}>
            <label style={{ display: "block", marginBottom: "0.5rem", fontWeight: "500" }}>
              Enter name for new instance:
            </label>
            <ct-input
              $value={inputText}
              placeholder="Type a name..."
              style="width: 100%; padding: 0.5rem; border: 1px solid #ccc; border-radius: 4px;"
            />
          </div>

          <ct-button
            onClick={createAndNavigate({ inputText })}
            style="background-color: #3b82f6; color: white; padding: 0.75rem 1.5rem; border-radius: 6px; font-weight: 600; cursor: pointer;"
          >
            Create & Navigate
          </ct-button>

          <div style={{ marginTop: "1rem", padding: "1rem", backgroundColor: "#f3f4f6", borderRadius: "4px", fontSize: "0.875rem" }}>
            Click the button to create a new instance of this pattern named with the text you entered.
          </div>
        </div>
      ),
      label,
    };
  }
);

export default NavTestPattern;
