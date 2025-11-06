/// <cts-enable />
import {
  link,
  NAME,
  patternTool,
  recipe,
  UI,
} from "commontools";

/**
 * Pattern tool for creating links between charm cells
 * Exported for use in chatbot.tsx
 */
export const createLinkTool = patternTool(
  ({ source, target }: { source: string; target: string }) => {
    return link(source, target);
  },
);

type LinkToolInput = Record<string, never>;
type LinkToolOutput = {
  [NAME]: string;
  [UI]: any;
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
    };
  },
);
