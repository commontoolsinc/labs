import { env, waitFor } from "@commontools/integration";
import { CharmController, CharmsController } from "@commontools/charm/ops";
import { ShellIntegration } from "@commontools/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert, assertEquals } from "@std/assert";
import { Identity } from "@commontools/identity";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

describe("compile-and-run integration test", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let compilerCharm: CharmController;
  let identity: Identity;
  let cc: CharmsController;

  const defaultCode = `// deno-lint-ignore-file jsx-no-useless-fragment
import { derive, h, handler, NAME, recipe, schema, str, UI } from "commontools";

// Different way to define the same schema, using 'schema' helper function,
// let's as leave off \`as const satisfies JSONSchema\`.
const model = schema({
  type: "object",
  properties: {
    value: { type: "number", default: 0, asCell: true },
  },
  default: { value: 0 },
});

const increment = handler({}, model, (_, state) => {
  state.value.set(state.value.get() + 1);
});

const decrement = handler({}, model, (_, state) => {
  state.value.set(state.value.get() - 1);
});

export default recipe(model, model, (cell) => {
  return {
    [NAME]: str\`Simple counter: \${derive(cell.value, String)}\`,
    [UI]: (
      <div>
        <ct-button onClick={decrement(cell)}>-</ct-button>
        {/* use html fragment to test that it works  */}
          <b>{cell.value}</b>
        <ct-button onClick={increment(cell)}>+</ct-button>
      </div>
    ),
    value: cell.value,
  };
});`;

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
    cc = await CharmsController.initialize({
      spaceName: SPACE_NAME,
      apiUrl: new URL(API_URL),
      identity: identity,
    });
    compilerCharm = await cc.create(
      await Deno.readTextFile(
        join(
          import.meta.dirname!,
          "..",
          "compile-and-run.tsx",
        ),
      ),
    );
  });

  afterAll(async () => {
    if (cc) await cc.dispose();
  });

  it("should load compiler, compile default code, and create working counter", async () => {
    const page = shell.page();
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      spaceName: SPACE_NAME,
      charmId: compilerCharm.id,
      identity,
    });

    // Give the page time to fully load
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Take a screenshot for debugging
    await page.screenshot("test-debug-1.png");

    // Wait for compiler status to show "Idle"
    const statusElement = await page.waitForSelector("#compiler-status", {
      strategy: "pierce",
    });
    assert(statusElement, "Should find compiler status element");

    // Wait for the status to contain "Idle"
    await waitFor(async () => {
      const statusText = await statusElement.evaluate((el: HTMLElement) =>
        el.textContent
      );
      return statusText?.includes("Idle") || false;
    });

    // Wait for Navigate button
    const navigateButton = await page.waitForSelector("#navigate-button", {
      strategy: "pierce",
    });
    assert(navigateButton, "Should have Navigate To Charm button");

    // Verify the code contains the default increment logic
    const codeValue = await compilerCharm.result.get(["code"]);
    assert(
      typeof codeValue === "string" && codeValue.includes("+ 1"),
      "Default code should contain '+ 1' increment",
    );

    // Click "Navigate To Charm" button to compile and navigate
    await navigateButton.click();
    console.log("✓ Navigate To Charm button clicked");

    // Wait for navigation to counter charm and verify counter appears
    const counterResult = await page.waitForSelector("#counter-result", {
      strategy: "pierce",
    });
    assert(counterResult, "Should find counter result element");
    console.log("✓ Counter found after navigation");

    // Find increment button and click it
    const plusButton = await page.waitForSelector("#increment-button", {
      strategy: "pierce",
    });
    assert(plusButton, "Should find increment button");
    await plusButton.click();
    console.log("✓ Increment button clicked successfully");
  });
});
