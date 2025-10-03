/// <cts-enable />
import {
  type Cell,
  cell,
  h,
  handler,
  lift,
  NAME,
  recipe,
  str,
  UI,
} from "commontools";

interface EchoArgs {
  message: string;
}

export const echoUx = recipe<EchoArgs>("Echo (UX)", ({ message }) => {
  const value = lift((text: string) => text)(message);

  // UI state
  const inputField = cell<string>("");

  // Handler to update the message
  const updateMessage = handler(
    (
      _event: unknown,
      context: { message: Cell<string>; input: Cell<string> },
    ) => {
      const text = context.input.get() ?? "";
      if (typeof text === "string" && text.trim() !== "") {
        context.message.set(text);
        context.input.set("");
      }
    },
  );

  const updateHandler = updateMessage({ message, input: inputField });

  const name = str`Echo (${value})`;

  const summary = lift((text: string) => {
    const length = typeof text === "string" ? text.length : 0;
    return `Message length: ${length} characters`;
  })(value);

  return {
    [NAME]: name,
    [UI]: (
      <div style="
          display: flex;
          flex-direction: column;
          gap: 1.5rem;
          max-width: 48rem;
        ">
        <ct-card>
          <div
            slot="content"
            style="
              display: flex;
              flex-direction: column;
              gap: 1.25rem;
            "
          >
            <div style="
                display: flex;
                flex-direction: column;
                gap: 0.25rem;
              ">
              <span style="
                  color: #475569;
                  font-size: 0.75rem;
                  letter-spacing: 0.08em;
                  text-transform: uppercase;
                ">
                Echo Pattern
              </span>
              <h2 style="
                  margin: 0;
                  font-size: 1.3rem;
                  color: #0f172a;
                ">
                Simple message echo
              </h2>
              <p style="
                  margin: 0;
                  font-size: 0.9rem;
                  color: #64748b;
                  line-height: 1.5;
                ">
                Type a message and see it echoed back. This pattern demonstrates
                the basic flow of input, state, and derived values.
              </p>
            </div>

            <div style="
                background: linear-gradient(135deg, #dbeafe 0%, #bfdbfe 100%);
                border-radius: 0.75rem;
                padding: 1.5rem;
                border: 2px solid #93c5fd;
              ">
              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.5rem;
                ">
                <span style="
                    font-size: 0.8rem;
                    color: #1e3a8a;
                    font-weight: 500;
                  ">
                  Current message
                </span>
                <div style="
                    font-size: 1.5rem;
                    color: #1e3a8a;
                    font-weight: 600;
                    min-height: 2rem;
                    word-break: break-word;
                  ">
                  {value}
                </div>
                <span style="
                    font-size: 0.75rem;
                    color: #3b82f6;
                    font-family: monospace;
                  ">
                  {summary}
                </span>
              </div>
            </div>
          </div>
        </ct-card>

        <ct-card>
          <div
            slot="header"
            style="
              display: flex;
              justify-content: space-between;
              align-items: center;
            "
          >
            <h3 style="margin: 0; font-size: 1rem; color: #0f172a;">
              Update message
            </h3>
          </div>
          <div
            slot="content"
            style="
              display: flex;
              flex-direction: column;
              gap: 0.75rem;
            "
          >
            <div style="
                display: flex;
                flex-direction: column;
                gap: 0.4rem;
              ">
              <label
                for="message-input"
                style="
                  font-size: 0.85rem;
                  font-weight: 500;
                  color: #334155;
                "
              >
                New message
              </label>
              <ct-input
                id="message-input"
                type="text"
                $value={inputField}
                aria-label="Enter new message"
                placeholder="Type your message here..."
              >
              </ct-input>
            </div>
            <ct-button
              onClick={updateHandler}
              aria-label="Update message"
            >
              Update
            </ct-button>
          </div>
        </ct-card>

        <div
          role="status"
          aria-live="polite"
          data-testid="status"
          style="font-size: 0.85rem; color: #475569;"
        >
          Echo: {value}
        </div>
      </div>
    ),
    message: value,
  };
});

export default echoUx;
