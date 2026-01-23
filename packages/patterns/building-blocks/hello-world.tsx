/// <cts-enable />
/**
 * Hello World - Permission test pattern
 * This exists to trigger all permission types for unattended work.
 */
import {
  computed,
  Default,
  NAME,
  pattern,
  UI,
  type VNode,
  Writable,
} from "commontools";

interface Input {
  message?: Writable<Default<string, "Hello, Building Blocks!">>;
}

interface Output {
  [NAME]: string;
  [UI]: VNode;
  message: string;
}

export default pattern<Input, Output>(({ message }) => {
  return {
    [NAME]: computed(() => `Hello: ${message.get()}`),
    [UI]: (
      <ct-screen>
        <ct-vstack gap="2" style="padding: 1rem;">
          <ct-heading level={2}>{message}</ct-heading>
          <ct-input $value={message} placeholder="Enter message..." />
        </ct-vstack>
      </ct-screen>
    ),
    message,
  };
});
