/// <cts-enable />
import {
  Cell,
  cell,
  derive,
  handler,
  link,
  NAME,
  recipe,
  UI,
  wish,
} from "commontools";

/**
 * Handler to create a link between two charm cells
 * Exported for use in chatbot.tsx
 *
 * Uses the built-in `link` function which handles path parsing,
 * charm lookup, and write redirect link creation.
 */
export const createLinkHandler = handler<
  {
    source: string;
    target: string;
    result?: Cell<string>;
  },
  Record<string, never>
>(({ source, target, result }) => {
  // Call the built-in link function
  const linkResult = link(source, target);

  // Copy result to the result cell if provided
  if (result) {
    const outcome = derive(linkResult, (r) => {
      if (r?.error) return `Error: ${r.error}`;
      if (r?.success) return r.success;
      return "Unknown result";
    });
    result.set(outcome);
  }

  // Handlers should not return OpaqueRefs - they're for side effects only
});

type LinkToolInput = Record<string, never>;
type LinkToolOutput = {
  [NAME]: string;
  [UI]: any;
  createLink: any;
};

export default recipe<LinkToolInput, LinkToolOutput>(
  "Link Tool",
  (_input) => {
    return {
      [NAME]: "Link Tool",
      [UI]: (
        <div>
          <h3>Link Tool</h3>
          <p>Create links between charm cells</p>
          <details>
            <summary>Usage</summary>
            <pre>
              {`{
  source: "SourceCharm/result/value",
  target: "TargetCharm/input/field"
}`}
            </pre>
          </details>
        </div>
      ),
      createLink: createLinkHandler({}),
    };
  },
);
