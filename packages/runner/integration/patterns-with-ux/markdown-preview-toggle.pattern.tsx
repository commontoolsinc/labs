/// <cts-enable />
// @ts-nocheck
import {
  type Cell,
  cell,
  compute,
  Default,
  h,
  handler,
  lift,
  NAME,
  recipe,
  str,
  UI,
} from "commontools";

interface MarkdownPreviewArgs {
  initialContent: Default<string, "# Welcome">;
  preview: Default<boolean, true>;
}

type UpdateContentEvent = {
  text?: unknown;
};

const sanitizeContent = (value: unknown): string => {
  return typeof value === "string" ? value : "";
};

const sanitizePreview = (value: unknown): boolean => {
  return value === true;
};

const formatMarkdown = (raw: string): string => {
  const lines = raw.split(/\r?\n/);
  return lines
    .map((line) => {
      if (line.startsWith("### ")) {
        return `<h3>${line.slice(4).trim()}</h3>`;
      }
      if (line.startsWith("## ")) {
        return `<h2>${line.slice(3).trim()}</h2>`;
      }
      if (line.startsWith("# ")) {
        return `<h1>${line.slice(2).trim()}</h1>`;
      }

      const formattedBold = line.replaceAll(
        /\*\*(.+?)\*\*/g,
        (_match, content: string) => `<strong>${content}</strong>`,
      );

      const formattedItalic = formattedBold.replaceAll(
        /_(.+?)_/g,
        (_match, content: string) => `<em>${content}</em>`,
      );

      return formattedItalic;
    })
    .join("\n");
};

const updateContent = handler(
  (
    event: UpdateContentEvent | undefined,
    context: { content: Cell<string> },
  ) => {
    const next = sanitizeContent(event?.text);
    context.content.set(next);
  },
);

const togglePreview = handler(
  (_event: unknown, context: { preview: Cell<boolean> }) => {
    const current = sanitizePreview(context.preview.get());
    context.preview.set(!current);
  },
);

export const markdownPreviewToggleUx = recipe<MarkdownPreviewArgs>(
  "Markdown Preview Toggle (UX)",
  ({ initialContent, preview }) => {
    const content = lift(sanitizeContent)(initialContent);
    const previewEnabled = lift(sanitizePreview)(preview);

    const previewText = lift((value: string) => formatMarkdown(value))(
      content,
    );

    const modeLabel = lift((enabled: boolean) => enabled ? "Preview" : "Raw")(
      previewEnabled,
    );

    const activeView = lift(
      ({ enabled, raw, formatted }: {
        enabled: boolean;
        raw: string;
        formatted: string;
      }) => (enabled ? formatted : raw),
    )({
      enabled: previewEnabled,
      raw: content,
      formatted: previewText,
    });

    const summary = str`${modeLabel} view — ${activeView}`;

    // UI state management
    const contentField = cell<string>("");

    const syncContentField = compute(() => {
      const text = content.get();
      if (contentField.get() !== text) {
        contentField.set(text);
      }
    });

    const applyUpdate = handler<
      unknown,
      { field: Cell<string>; content: Cell<string> }
    >((_event, { field, content }) => {
      const text = sanitizeContent(field.get());
      content.set(text);
    })({ field: contentField, content: initialContent });

    const applyToggle = handler<unknown, { preview: Cell<boolean> }>(
      (_event, { preview }) => {
        const current = sanitizePreview(preview.get());
        preview.set(!current);
      },
    )({ preview });

    const name = str`Markdown Preview (${modeLabel})`;

    const previewStyle = lift((enabled: boolean) =>
      enabled
        ? "background: linear-gradient(135deg, #6366f1, #8b5cf6); color: white; border: 2px solid #6366f1;"
        : "background: #f1f5f9; color: #475569; border: 2px solid #cbd5e1;"
    )(
      previewEnabled,
    );

    const rawStyle = lift((enabled: boolean) =>
      enabled
        ? "background: #f1f5f9; color: #475569; border: 2px solid #cbd5e1;"
        : "background: linear-gradient(135deg, #6366f1, #8b5cf6); color: white; border: 2px solid #6366f1;"
    )(
      previewEnabled,
    );

    const editorStyle = lift((enabled: boolean) =>
      enabled ? "display: none;" : "display: flex;"
    )(previewEnabled);

    const previewPaneStyle = lift((enabled: boolean) =>
      enabled ? "display: block;" : "display: none;"
    )(previewEnabled);

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
                  Markdown Editor
                </span>
                <h2 style="
                    margin: 0;
                    font-size: 1.3rem;
                    color: #0f172a;
                  ">
                  Toggle between raw and formatted views
                </h2>
              </div>

              <div style="
                  display: flex;
                  gap: 0.5rem;
                  padding: 0.5rem;
                  background: #f8fafc;
                  border-radius: 0.5rem;
                ">
                <ct-button
                  onClick={applyToggle}
                  style={rawStyle}
                  aria-label="Switch to raw view"
                >
                  <span style="
                      display: flex;
                      align-items: center;
                      gap: 0.5rem;
                    ">
                    <span style="
                        display: inline-block;
                        width: 0.5rem;
                        height: 0.5rem;
                        border-radius: 50%;
                        background: currentColor;
                      ">
                    </span>
                    Raw
                  </span>
                </ct-button>
                <ct-button
                  onClick={applyToggle}
                  style={previewStyle}
                  aria-label="Switch to preview"
                >
                  <span style="
                      display: flex;
                      align-items: center;
                      gap: 0.5rem;
                    ">
                    <span style="
                        display: inline-block;
                        width: 0.5rem;
                        height: 0.5rem;
                        border-radius: 50%;
                        background: currentColor;
                      ">
                    </span>
                    Preview
                  </span>
                </ct-button>
              </div>

              <div
                style={editorStyle}
                class="editor-section"
              >
                <div style="
                    display: flex;
                    flex-direction: column;
                    gap: 0.75rem;
                    flex: 1;
                  ">
                  <label
                    for="content-field"
                    style="
                      font-size: 0.85rem;
                      font-weight: 500;
                      color: #334155;
                    "
                  >
                    Markdown content
                  </label>
                  <textarea
                    id="content-field"
                    style="
                      width: 100%;
                      min-height: 12rem;
                      padding: 0.75rem;
                      font-family: 'Monaco', 'Menlo', monospace;
                      font-size: 0.9rem;
                      line-height: 1.5;
                      border: 2px solid #cbd5e1;
                      border-radius: 0.5rem;
                      resize: vertical;
                      background: #ffffff;
                    "
                    oninput={(e: any) => {
                      contentField.set(e.target.value);
                    }}
                    aria-label="Enter markdown content"
                  >
                    {contentField}
                  </textarea>
                  <ct-button
                    onClick={applyUpdate}
                    aria-label="Update content"
                  >
                    Update content
                  </ct-button>
                </div>
              </div>

              <div
                style={previewPaneStyle}
                class="preview-section"
              >
                <div style="
                    background: #ffffff;
                    border: 2px solid #cbd5e1;
                    border-radius: 0.5rem;
                    padding: 1.5rem;
                    min-height: 12rem;
                  ">
                  <div style="
                      font-size: 0.85rem;
                      font-weight: 500;
                      color: #334155;
                      margin-bottom: 0.75rem;
                    ">
                    Preview
                  </div>
                  <div
                    style="
                      line-height: 1.6;
                      color: #1e293b;
                    "
                    innerHTML={previewText}
                  >
                  </div>
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
                Formatting guide
              </h3>
            </div>
            <div
              slot="content"
              style="
                display: grid;
                grid-template-columns: repeat(2, minmax(0, 1fr));
                gap: 1rem;
                font-size: 0.85rem;
              "
            >
              <div style="
                  background: #f8fafc;
                  padding: 0.75rem;
                  border-radius: 0.375rem;
                ">
                <div style="
                    font-weight: 600;
                    color: #475569;
                    margin-bottom: 0.5rem;
                  ">
                  Headers
                </div>
                <code style="
                    display: block;
                    font-family: monospace;
                    color: #334155;
                    line-height: 1.6;
                  ">
                  # Heading 1<br />
                  ## Heading 2<br />
                  ### Heading 3
                </code>
              </div>
              <div style="
                  background: #f8fafc;
                  padding: 0.75rem;
                  border-radius: 0.375rem;
                ">
                <div style="
                    font-weight: 600;
                    color: #475569;
                    margin-bottom: 0.5rem;
                  ">
                  Emphasis
                </div>
                <code style="
                    display: block;
                    font-family: monospace;
                    color: #334155;
                    line-height: 1.6;
                  ">
                  **bold text**<br />
                  _italic text_
                </code>
              </div>
            </div>
          </ct-card>

          <div
            role="status"
            aria-live="polite"
            data-testid="status"
            style="font-size: 0.85rem; color: #475569;"
          >
            {summary}
          </div>
        </div>
      ),
      content,
      previewEnabled,
      previewText,
      activeView,
      summary,
      togglePreview: togglePreview({ preview }),
      updateContent: updateContent({ content: initialContent }),
      contentField,
      modeLabel,
      effects: {
        syncContentField,
      },
      controls: {
        applyUpdate,
        applyToggle,
      },
    };
  },
);

export default markdownPreviewToggleUx;
