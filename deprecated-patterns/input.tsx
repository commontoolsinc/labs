import { JSONSchema, NAME, pattern, UI } from "commonfabric";

const InputSchema = {
  type: "object",
  properties: {
    content: {
      type: "string",
      default: "",
      asCell: true,
    },
  },
  required: ["content"],
} as const satisfies JSONSchema;

const OutputSchema = InputSchema;

export default pattern(
  ({ content }: any) => {
    return {
      [NAME]: "<cf-input /> test",
      [UI]: (
        <div style="padding: 1rem; max-width: 1200px; margin: 0 auto;">
          <label>Text (Default - Debounced):</label>
          <cf-input
            $value={content}
            type="text"
            placeholder="Search..."
          />
          <label>Text (Blur):</label>
          <cf-input
            $value={content}
            type="text"
            timingStrategy="blur"
            placeholder="Enter value"
          />
          <label>Text (Throttled):</label>
          <cf-input
            $value={content}
            type="text"
            timingStrategy="throttle"
            timingDelay="100"
            placeholder="Enter something..."
          />
          <label>Text (Immediate):</label>
          <cf-input
            $value={content}
            type="text"
            timingStrategy="immediate"
            placeholder="Updates instantly..."
          />
          <label>Email:</label>
          <cf-input
            $value={content}
            type="email"
            placeholder="Enter something..."
          />
          <label>Password:</label>
          <cf-input
            $value={content}
            type="password"
            placeholder="Enter something..."
          />
          <label>Number:</label>
          <cf-input
            $value={content}
            type="number"
            placeholder="Enter something..."
          />
          <label>Search:</label>
          <cf-input
            $value={content}
            type="search"
            placeholder="Enter something..."
          />
          <label>Tel:</label>
          <cf-input
            $value={content}
            type="tel"
            placeholder="Enter something..."
          />
          <label>URL:</label>
          <cf-input
            $value={content}
            type="url"
            placeholder="Enter something..."
          />
          <label>Date:</label>
          <cf-input
            $value={content}
            type="date"
            placeholder="Enter something..."
          />
          <label>Time:</label>
          <cf-input
            $value={content}
            type="time"
            placeholder="Enter something..."
          />
          <label>DateTime Local:</label>
          <cf-input
            $value={content}
            type="datetime-local"
            placeholder="Enter something..."
          />
          <label>Month:</label>
          <cf-input
            $value={content}
            type="month"
            placeholder="Enter something..."
          />
          <label>Week:</label>
          <cf-input
            $value={content}
            type="week"
            placeholder="Enter something..."
          />
          <label>Color:</label>
          <cf-input
            $value={content}
            type="color"
            placeholder="Enter something..."
          />
          <label>File:</label>
          <cf-input
            $value={content}
            type="file"
            placeholder="Enter something..."
          />
          <label>Range:</label>
          <cf-input
            $value={content}
            type="range"
            placeholder="Enter something..."
          />
          <hr />
          <cf-code-editor
            $value={content}
            language="text/markdown"
            placeholder="Enter something..."
            style="height: 256px"
          />
        </div>
      ),
      content,
    };
  },
  InputSchema,
  OutputSchema,
);
