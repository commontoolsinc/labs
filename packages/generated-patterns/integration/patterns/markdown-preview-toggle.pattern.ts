/// <cts-enable />
import { type Cell, Default, handler, lift, recipe, str } from "commontools";

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

export const markdownPreviewToggle = recipe<MarkdownPreviewArgs>(
  "Markdown Preview Toggle",
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

    return {
      content,
      previewEnabled,
      previewText,
      activeView,
      summary,
      togglePreview: togglePreview({ preview }),
      updateContent: updateContent({ content: initialContent }),
    };
  },
);
