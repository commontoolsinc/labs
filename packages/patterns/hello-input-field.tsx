/// <cts-enable />
import {
  computed,
  type Default,
  NAME,
  pattern,
  UI,
  type VNode,
  Writable,
} from "commontools";

interface HelloInputFieldInput {
  text: Writable<Default<string, "">>;
}

interface HelloInputFieldOutput {
  [NAME]: string;
  [UI]: VNode;
  text: string;
}

const HelloInputField = pattern<HelloInputFieldInput, HelloInputFieldOutput>(
  ({ text }) => {
    return {
      [NAME]: "Hello Input Field",
      text,
      [UI]: computed(() => (
        <div
          style={{
            padding: "24px",
            fontFamily:
              "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif",
            maxWidth: "480px",
            margin: "0 auto",
          }}
        >
          <div
            style={{
              fontSize: "20px",
              fontWeight: "600",
              color: "#1d1d1f",
              marginBottom: "12px",
            }}
          >
            Hello Input Field
          </div>
          <ct-textarea
            $value={text}
            placeholder="Type something..."
            rows={4}
            style="width: 100%; font-size: 14px; border-radius: 8px;"
          />
        </div>
      )),
    };
  },
);

export default HelloInputField;
