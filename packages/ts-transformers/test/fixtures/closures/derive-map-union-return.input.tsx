/// <cts-enable />
import { derive, pattern, UI } from "commonfabric";

interface ContentPart {
  type: "text" | "image";
  text?: string;
  image?: string;
}

interface Message {
  role: "user" | "assistant";
  content: string | ContentPart[];
}

interface State {
  messages: Message[];
}

// FIXTURE: derive-map-union-return
// Verifies: derive returning a union type (string | null) with nested .map() infers the correct output schema
//   derive(state.messages, fn) → derive(schema, anyOf[string, null], state.key("messages"), fn)
//   inner .map() inside derive callback → NOT transformed (plain array after unwrap)
// Context: previously caused schema to fall back to `true` when the callback became synthetic
export default pattern<State>((state) => {
  // This derive callback contains a nested map and returns string | null
  // The callback becomes synthetic during transformation, which previously
  // caused type inference to fail, resulting in a 'true' schema instead of
  // the correct union type schema.
  const latestMessage = derive(state.messages, (messages) => {
    if (!messages || messages.length === 0) return null;

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]!;
      if (msg.role === "assistant") {
        // This map call inside the derive callback was the key issue
        const content = typeof msg.content === "string"
          ? msg.content
          : msg.content.map((part) => {
              if (part.type === "text") return part.text || "";
              return "";
            }).join("");
        return content;
      }
    }
    return null;
  });

  return {
    [UI]: (
      <div>
        <div>Latest: {latestMessage}</div>
      </div>
    ),
  };
});
