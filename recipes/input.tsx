import { h, handler, JSONSchema, NAME, recipe, UI } from "commontools";

const InputSchema = {
  type: "object",
  properties: {
    content: {
      type: "string",
      default: "",
    },
  },
  required: ["content"],
} as const satisfies JSONSchema;

const OutputSchema = InputSchema;

const updateContent = handler<
  { detail: { value: string } },
  { content: string }
>(
  (event, state) => {
    state.content = event.detail?.value ?? "";
  },
);

export default recipe(
  InputSchema,
  OutputSchema,
  ({ content }) => {
    return {
      [NAME]: "<ct-input /> test",
      [UI]: (
        <div style="padding: 1rem; max-width: 1200px; margin: 0 auto;">
          <label>Text (Default - Debounced):</label>
          <ct-input
            $value={content}
            type="text"
            placeholder="Search..."
          />
          <label>Text (Blur):</label>
          <ct-input
            $value={content}
            type="text"
            timingStrategy="blur"
            placeholder="Enter value"
          />
          <label>Text (Throttled):</label>
          <ct-input
            $value={content}
            type="text"
            timingStrategy="throttle"
            timingDelay="100"
            placeholder="Enter something..."
          />
          <label>Text (Immediate):</label>
          <ct-input
            $value={content}
            type="text"
            timingStrategy="immediate"
            placeholder="Updates instantly..."
          />
          <label>Email:</label>
          <ct-input
            $value={content}
            type="email"
            placeholder="Enter something..."
          />
          <label>Password:</label>
          <ct-input
            $value={content}
            type="password"
            placeholder="Enter something..."
          />
          <label>Number:</label>
          <ct-input
            $value={content}
            type="number"
            placeholder="Enter something..."
          />
          <label>Search:</label>
          <ct-input
            $value={content}
            type="search"
            placeholder="Enter something..."
          />
          <label>Tel:</label>
          <ct-input
            $value={content}
            type="tel"
            placeholder="Enter something..."
          />
          <label>URL:</label>
          <ct-input
            $value={content}
            type="url"
            placeholder="Enter something..."
          />
          <label>Date:</label>
          <ct-input
            $value={content}
            type="date"
            placeholder="Enter something..."
          />
          <label>Time:</label>
          <ct-input
            $value={content}
            type="time"
            placeholder="Enter something..."
          />
          <label>DateTime Local:</label>
          <ct-input
            $value={content}
            type="datetime-local"
            placeholder="Enter something..."
          />
          <label>Month:</label>
          <ct-input
            $value={content}
            type="month"
            placeholder="Enter something..."
          />
          <label>Week:</label>
          <ct-input
            $value={content}
            type="week"
            placeholder="Enter something..."
          />
          <label>Color:</label>
          <ct-input
            $value={content}
            type="color"
            placeholder="Enter something..."
          />
          <label>File:</label>
          <ct-input
            $value={content}
            type="file"
            placeholder="Enter something..."
          />
          <label>Range:</label>
          <ct-input
            $value={content}
            type="range"
            placeholder="Enter something..."
          />
        </div>
      ),
      content,
    };
  },
);
