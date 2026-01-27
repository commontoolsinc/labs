/**
 * Google Docs to Markdown Conversion Utilities
 *
 * Converts Google Docs API JSON structure to well-formatted Markdown.
 *
 * Features:
 * - Headings (HEADING_1 through HEADING_6)
 * - Paragraphs with inline formatting (bold, italic, links, strikethrough)
 * - Ordered and unordered lists with nesting
 * - Tables
 * - Images (downloaded via auth token, embedded as base64)
 * - Comment interleaving (as blockquotes after their quoted text)
 *
 * Usage:
 * ```typescript
 * import { convertDocToMarkdown, downloadImageAsBase64 } from "./util/google-docs-markdown.ts";
 *
 * const markdown = await convertDocToMarkdown(docJson, comments, token);
 * ```
 */

// =============================================================================
// Types - Google Docs API
// =============================================================================

export interface GoogleDocsDocument {
  title?: string;
  body?: {
    content: StructuralElement[];
  };
  lists?: Record<string, ListProperties>;
  inlineObjects?: Record<string, InlineObject>;
}

export interface ListProperties {
  listProperties: {
    nestingLevels: NestingLevel[];
  };
}

export interface NestingLevel {
  bulletAlignment?: string;
  glyphType?: string; // "DECIMAL", "ALPHA", "ROMAN", etc.
  glyphFormat?: string;
  startNumber?: number;
}

export interface InlineObject {
  inlineObjectProperties?: {
    embeddedObject?: {
      imageProperties?: {
        contentUri?: string;
        sourceUri?: string;
      };
      title?: string;
      description?: string;
    };
  };
}

export interface StructuralElement {
  startIndex: number;
  endIndex: number;
  paragraph?: Paragraph;
  table?: Table;
  sectionBreak?: SectionBreak;
  tableOfContents?: TableOfContents;
}

export interface Paragraph {
  paragraphStyle?: {
    namedStyleType?: string; // "HEADING_1", "HEADING_2", ..., "NORMAL_TEXT", "TITLE", "SUBTITLE"
    alignment?: string;
  };
  elements: ParagraphElement[];
  bullet?: {
    listId: string;
    nestingLevel: number;
  };
}

export interface ParagraphElement {
  startIndex?: number;
  endIndex?: number;
  textRun?: TextRun;
  inlineObjectElement?: {
    inlineObjectId: string;
  };
  horizontalRule?: Record<string, unknown>;
}

export interface TextRun {
  content: string;
  textStyle?: TextStyle;
}

export interface TextStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  link?: {
    url?: string;
    headingId?: string;
    bookmarkId?: string;
  };
  baselineOffset?: string; // "SUPERSCRIPT", "SUBSCRIPT"
  fontSize?: { magnitude: number; unit: string };
  foregroundColor?: {
    color: { rgbColor?: { red?: number; green?: number; blue?: number } };
  };
}

export interface Table {
  rows: number;
  columns: number;
  tableRows: TableRow[];
}

export interface TableRow {
  tableCells: TableCell[];
}

export interface TableCell {
  content: StructuralElement[];
}

export interface SectionBreak {
  sectionStyle?: {
    sectionType?: string;
  };
}

export interface TableOfContents {
  content: StructuralElement[];
}

// =============================================================================
// Types - Google Drive Comments API
// =============================================================================

export interface GoogleComment {
  id: string;
  author: {
    displayName: string;
    photoLink?: string;
    emailAddress?: string;
  };
  content: string;
  htmlContent?: string;
  createdTime: string;
  modifiedTime?: string;
  resolved: boolean;
  quotedFileContent?: {
    value: string;
    mimeType?: string;
  };
  anchor?: string;
  replies?: GoogleCommentReply[];
}

export interface GoogleCommentReply {
  id: string;
  author: {
    displayName: string;
    photoLink?: string;
    emailAddress?: string;
  };
  content: string;
  htmlContent?: string;
  createdTime: string;
  modifiedTime?: string;
  action?: "resolve" | "reopen";
}

// =============================================================================
// Image Handling
// =============================================================================

/** Default max image size for base64 embedding: 5MB */
const DEFAULT_MAX_IMAGE_SIZE = 5 * 1024 * 1024;

/**
 * Download an image and convert to base64 data URL.
 * Images in Google Docs require authentication to access.
 *
 * @param url The image URL (from Google Docs)
 * @param token OAuth access token
 * @param maxSizeBytes Optional maximum image size in bytes (default: 5MB). Images larger than this will be skipped.
 * @returns Base64 data URL or null if download fails or image exceeds size limit
 */
export async function downloadImageAsBase64(
  url: string,
  token: string,
  maxSizeBytes: number = DEFAULT_MAX_IMAGE_SIZE,
): Promise<string | null> {
  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      console.warn(
        `[downloadImageAsBase64] Failed to download image: ${response.status}`,
      );
      return null;
    }

    // Check content-length header first (if available) for early rejection
    const contentLength = response.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > maxSizeBytes) {
      console.warn(
        `[downloadImageAsBase64] Image too large (${contentLength} bytes > ${maxSizeBytes}), skipping`,
      );
      return null;
    }

    const contentType = response.headers.get("content-type") || "image/png";
    const blob = await response.blob();

    // Check actual size after download
    if (blob.size > maxSizeBytes) {
      console.warn(
        `[downloadImageAsBase64] Image too large (${blob.size} bytes > ${maxSizeBytes}), skipping`,
      );
      return null;
    }

    const arrayBuffer = await blob.arrayBuffer();
    const base64 = btoa(
      new Uint8Array(arrayBuffer).reduce(
        (data, byte) => data + String.fromCharCode(byte),
        "",
      ),
    );

    return `data:${contentType};base64,${base64}`;
  } catch (error) {
    console.warn(`[downloadImageAsBase64] Error downloading image:`, error);
    return null;
  }
}

// =============================================================================
// Comment Handling
// =============================================================================

/**
 * Build a map of quoted text to comments for interleaving.
 * Only includes unresolved comments.
 */
function buildCommentMap(
  comments: GoogleComment[],
): Map<string, GoogleComment[]> {
  const map = new Map<string, GoogleComment[]>();

  for (const comment of comments) {
    if (comment.resolved) continue;

    const quotedText = comment.quotedFileContent?.value;
    if (quotedText) {
      const existing = map.get(quotedText) || [];
      existing.push(comment);
      map.set(quotedText, existing);
    }
  }

  return map;
}

/**
 * Format a comment thread as a Markdown blockquote.
 */
function formatCommentAsBlockquote(comment: GoogleComment): string {
  const lines: string[] = [];

  // Format date
  const formatDate = (dateStr: string): string => {
    try {
      const date = new Date(dateStr);
      return date.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
    } catch {
      return dateStr;
    }
  };

  // Main comment
  lines.push(
    `> **${comment.author.displayName}** (${formatDate(comment.createdTime)}):`,
  );
  lines.push(`> ${comment.content.split("\n").join("\n> ")}`);

  // Replies (excluding resolve actions)
  if (comment.replies && comment.replies.length > 0) {
    for (const reply of comment.replies) {
      if (reply.action === "resolve") continue;
      lines.push(`>`);
      lines.push(
        `> > **${reply.author.displayName}** (${
          formatDate(reply.createdTime)
        }):`,
      );
      lines.push(`> > ${reply.content.split("\n").join("\n> > ")}`);
    }
  }

  return lines.join("\n");
}

// =============================================================================
// Text Formatting
// =============================================================================

/**
 * Apply inline text formatting (bold, italic, links, etc.)
 */
function formatTextRun(textRun: TextRun): string {
  let text = textRun.content;

  // Don't format whitespace-only or newline-only content
  if (!text || text === "\n" || text.trim() === "") {
    return text;
  }

  const style = textRun.textStyle;
  if (!style) return text;

  // Handle links first (they wrap the text)
  if (style.link?.url) {
    // Remove trailing newlines for link text
    const trimmedText = text.replace(/\n$/, "");
    const hadNewline = text.endsWith("\n");
    text = `[${trimmedText}](${style.link.url})${hadNewline ? "\n" : ""}`;
  }

  // Apply formatting markers
  // Note: Order matters - apply from inside out

  // Strikethrough
  if (style.strikethrough) {
    const trimmedText = text.replace(/\n$/, "");
    const hadNewline = text.endsWith("\n");
    text = `~~${trimmedText}~~${hadNewline ? "\n" : ""}`;
  }

  // Bold and italic
  if (style.bold && style.italic) {
    const trimmedText = text.replace(/\n$/, "");
    const hadNewline = text.endsWith("\n");
    text = `***${trimmedText}***${hadNewline ? "\n" : ""}`;
  } else if (style.bold) {
    const trimmedText = text.replace(/\n$/, "");
    const hadNewline = text.endsWith("\n");
    text = `**${trimmedText}**${hadNewline ? "\n" : ""}`;
  } else if (style.italic) {
    const trimmedText = text.replace(/\n$/, "");
    const hadNewline = text.endsWith("\n");
    text = `*${trimmedText}*${hadNewline ? "\n" : ""}`;
  }

  return text;
}

// =============================================================================
// List Handling
// =============================================================================

interface ListState {
  listId: string;
  counters: number[]; // Counter for each nesting level
}

/**
 * Determine if a list is ordered based on its properties.
 */
function isOrderedList(
  doc: GoogleDocsDocument,
  listId: string,
  nestingLevel: number,
): boolean {
  const listProps = doc.lists?.[listId];
  if (!listProps) return false;

  const nesting = listProps.listProperties?.nestingLevels?.[nestingLevel];
  if (!nesting) return false;

  // Check glyph type - DECIMAL, ALPHA, ROMAN indicate ordered
  const glyphType = nesting.glyphType;
  if (!glyphType) return false;

  return ["DECIMAL", "ALPHA", "UPPER_ALPHA", "ROMAN", "UPPER_ROMAN"].includes(
    glyphType,
  );
}

/**
 * Generate list marker for a given nesting level.
 */
function getListMarker(
  doc: GoogleDocsDocument,
  listId: string,
  nestingLevel: number,
  listState: ListState,
): string {
  const indent = "  ".repeat(nestingLevel);

  if (isOrderedList(doc, listId, nestingLevel)) {
    // Ensure counter array is long enough
    while (listState.counters.length <= nestingLevel) {
      listState.counters.push(0);
    }
    // Increment counter for this level
    listState.counters[nestingLevel]++;
    // Reset deeper levels
    for (let i = nestingLevel + 1; i < listState.counters.length; i++) {
      listState.counters[i] = 0;
    }
    return `${indent}${listState.counters[nestingLevel]}. `;
  } else {
    return `${indent}- `;
  }
}

// =============================================================================
// Main Conversion
// =============================================================================

export interface ConversionOptions {
  /** Include comments as blockquotes (default: true) */
  includeComments?: boolean;
  /** Download and embed images as base64 (default: true) */
  embedImages?: boolean;
  /** OAuth token for image downloads */
  token?: string;
}

/**
 * Convert a Google Docs document to Markdown.
 *
 * @param doc Google Docs API document JSON
 * @param comments Array of comments (only unresolved will be included)
 * @param options Conversion options
 * @returns Markdown string
 */
export async function convertDocToMarkdown(
  doc: GoogleDocsDocument,
  comments: GoogleComment[] = [],
  options: ConversionOptions = {},
): Promise<string> {
  const { includeComments = true, embedImages = true, token } = options;

  const parts: string[] = [];
  const commentMap = includeComments ? buildCommentMap(comments) : new Map();
  const usedComments = new Set<string>();

  // Track list state
  let currentListState: ListState | null = null;

  // Process each structural element
  const content = doc.body?.content || [];

  for (const element of content) {
    // Handle paragraphs
    if (element.paragraph) {
      const para = element.paragraph;
      const styleType = para.paragraphStyle?.namedStyleType || "NORMAL_TEXT";

      // Build paragraph text
      let paragraphText = "";
      const paragraphElements = para.elements || [];

      for (const elem of paragraphElements) {
        if (elem.textRun) {
          paragraphText += formatTextRun(elem.textRun);
        } else if (elem.inlineObjectElement) {
          // Handle inline image
          const objectId = elem.inlineObjectElement.inlineObjectId;
          const inlineObj = doc.inlineObjects?.[objectId];
          const embeddedObj = inlineObj?.inlineObjectProperties?.embeddedObject;

          if (embeddedObj) {
            const imageUrl = embeddedObj.imageProperties?.contentUri ||
              embeddedObj.imageProperties?.sourceUri;
            const altText = embeddedObj.title || embeddedObj.description ||
              "Image";

            if (imageUrl && embedImages && token) {
              // Download and embed as base64
              const base64Url = await downloadImageAsBase64(imageUrl, token);
              if (base64Url) {
                paragraphText += `![${altText}](${base64Url})`;
              } else {
                // Fallback to URL with auth note (image too large or download failed)
                paragraphText +=
                  `![${altText}](${imageUrl})\n<!-- Note: Image requires Google authentication to view -->`;
              }
            } else if (imageUrl) {
              // Not embedding images - include URL with note about authentication
              paragraphText +=
                `![${altText}](${imageUrl})\n<!-- Note: Image requires Google authentication to view -->`;
            }
          }
        } else if (elem.horizontalRule) {
          paragraphText += "---";
        }
      }

      // Remove trailing newline for processing
      paragraphText = paragraphText.replace(/\n$/, "");

      // Skip empty paragraphs
      if (!paragraphText.trim()) {
        parts.push("");
        continue;
      }

      // Handle lists
      if (para.bullet) {
        const { listId, nestingLevel } = para.bullet;

        // Initialize or switch list state
        if (!currentListState || currentListState.listId !== listId) {
          currentListState = { listId, counters: [] };
        }

        const marker = getListMarker(
          doc,
          listId,
          nestingLevel,
          currentListState,
        );
        parts.push(`${marker}${paragraphText}`);
      } else {
        // End any current list
        currentListState = null;

        // Handle headings
        if (styleType.startsWith("HEADING_")) {
          const level = parseInt(styleType.replace("HEADING_", ""), 10);
          const prefix = "#".repeat(Math.min(level, 6));
          parts.push(`${prefix} ${paragraphText}`);
        } else if (styleType === "TITLE") {
          parts.push(`# ${paragraphText}`);
        } else if (styleType === "SUBTITLE") {
          parts.push(`## ${paragraphText}`);
        } else {
          // Normal paragraph
          parts.push(paragraphText);
        }
      }

      // Check for comments that match text in this paragraph
      if (includeComments) {
        for (const [quotedText, commentList] of commentMap) {
          if (
            paragraphText.includes(quotedText) &&
            !usedComments.has(quotedText)
          ) {
            usedComments.add(quotedText);
            for (const comment of commentList) {
              parts.push("");
              parts.push(formatCommentAsBlockquote(comment));
            }
          }
        }
      }
    } // Handle tables
    else if (element.table) {
      currentListState = null; // End any current list

      const table = element.table;
      const tableRows = table.tableRows || [];

      if (tableRows.length === 0) continue;

      const markdownRows: string[] = [];

      for (let rowIndex = 0; rowIndex < tableRows.length; rowIndex++) {
        const row = tableRows[rowIndex];
        const cells = row.tableCells || [];
        const cellTexts: string[] = [];

        for (const cell of cells) {
          // Recursively process cell content (simplified - just extract text)
          let cellText = "";
          for (const cellElement of cell.content || []) {
            if (cellElement.paragraph) {
              for (const elem of cellElement.paragraph.elements || []) {
                if (elem.textRun) {
                  cellText += formatTextRun(elem.textRun);
                }
              }
            }
          }
          // Clean up cell text (remove newlines, escape pipes)
          cellText = cellText.replace(/\n/g, " ").replace(/\|/g, "\\|").trim();
          cellTexts.push(cellText);
        }

        markdownRows.push(`| ${cellTexts.join(" | ")} |`);

        // Add separator row after header
        if (rowIndex === 0) {
          const separators = cellTexts.map(() => "---");
          markdownRows.push(`| ${separators.join(" | ")} |`);
        }
      }

      parts.push("");
      parts.push(...markdownRows);
      parts.push("");
    } // Handle section breaks
    else if (element.sectionBreak) {
      currentListState = null; // End any current list
      // Add a horizontal rule for section breaks
      parts.push("");
      parts.push("---");
      parts.push("");
    }
  }

  // Add orphan comments (comments without matching quoted text) at the end
  if (includeComments) {
    const orphanComments: GoogleComment[] = [];
    for (const [quotedText, commentList] of commentMap) {
      if (!usedComments.has(quotedText)) {
        orphanComments.push(...commentList);
      }
    }

    if (orphanComments.length > 0) {
      parts.push("");
      parts.push("---");
      parts.push("");
      parts.push("## Comments");
      parts.push("");

      for (const comment of orphanComments) {
        if (comment.quotedFileContent?.value) {
          parts.push(`*On: "${comment.quotedFileContent.value}"*`);
        }
        parts.push(formatCommentAsBlockquote(comment));
        parts.push("");
      }
    }
  }

  // Clean up output - remove excessive blank lines
  return parts
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Extract document title from Google Docs JSON.
 */
export function extractDocTitle(doc: GoogleDocsDocument): string {
  return doc.title || "Untitled Document";
}

/**
 * Extract plain text from Google Docs document JSON (simpler version).
 * Useful for quick text extraction without markdown formatting.
 */
export function extractDocText(doc: GoogleDocsDocument): string {
  const parts: string[] = [];

  if (doc.body?.content) {
    for (const element of doc.body.content) {
      if (element.paragraph?.elements) {
        for (const elem of element.paragraph.elements) {
          if (elem.textRun?.content) {
            parts.push(elem.textRun.content);
          }
        }
      }
    }
  }

  return parts.join("");
}
