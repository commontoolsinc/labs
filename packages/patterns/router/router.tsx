/// <cts-enable />
import { Default, NAME, pattern, UI, type VNode } from "commontools";

interface RouterInput {}

interface RouterOutput {
  [NAME]: string;
  [UI]: VNode;
}

export default pattern<RouterInput, RouterOutput>(() => {
  return {
    [NAME]: "Router",
    [UI]: (
      <ct-screen>
        <ct-router-provider>
          <ct-route></ct-route>
        </ct-router-provider>
      </ct-screen>
    ),
  };
});
