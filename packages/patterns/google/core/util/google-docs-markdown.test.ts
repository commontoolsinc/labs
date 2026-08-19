import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  convertDocToMarkdown,
  downloadImageAsBase64,
  extractDocText,
  extractDocTitle,
  type GoogleComment,
  type GoogleDocsDocument,
  type Paragraph,
  type ParagraphElement,
  type StructuralElement,
  type TableRow,
  type TextStyle,
} from "./google-docs-markdown.ts";

const text = (content: string, textStyle?: TextStyle): ParagraphElement => ({
  textRun: { content, textStyle },
});

const para = (
  elements: ParagraphElement[],
  rest: Omit<Paragraph, "elements"> = {},
): StructuralElement => ({
  startIndex: 0,
  endIndex: 0,
  paragraph: { elements, ...rest },
});

const heading = (content: string, namedStyleType: string): StructuralElement =>
  para([text(content)], { paragraphStyle: { namedStyleType } });

const bullet = (
  content: string,
  listId: string,
  nestingLevel = 0,
): StructuralElement =>
  para([text(content)], { bullet: { listId, nestingLevel } });

const row = (...cells: string[]): TableRow => ({
  tableCells: cells.map((cell) => ({
    content: [para([text(cell)])],
  })),
});

const docOf = (
  content: StructuralElement[],
  rest: Omit<GoogleDocsDocument, "body"> = {},
): GoogleDocsDocument => ({ body: { content }, ...rest });

const comment = (
  overrides: Partial<GoogleComment> & Pick<GoogleComment, "id" | "content">,
): GoogleComment => ({
  author: { displayName: "Alice" },
  createdTime: "2026-01-15T10:00:00Z",
  resolved: false,
  ...overrides,
});

const glyphs = (...glyphTypes: string[]) => ({
  listProperties: {
    nestingLevels: glyphTypes.map((glyphType) => ({ glyphType })),
  },
});

const imageDoc = (
  contentUri: string,
  title?: string,
): GoogleDocsDocument =>
  docOf([para([{ inlineObjectElement: { inlineObjectId: "img1" } }])], {
    inlineObjects: {
      img1: {
        inlineObjectProperties: {
          embeddedObject: { imageProperties: { contentUri }, title },
        },
      },
    },
  });

describe("google-docs-markdown", () => {
  describe("extractDocTitle()", () => {
    it("returns the document's title", () => {
      expect(extractDocTitle({ title: "Quarterly Plan" })).toBe(
        "Quarterly Plan",
      );
    });

    it("returns 'Untitled Document' for a document with no title", () => {
      expect(extractDocTitle({})).toBe("Untitled Document");
    });
  });

  describe("extractDocText()", () => {
    it("concatenates the content of every text run", () => {
      const doc = docOf([
        para([text("Hello, "), text("world.\n")]),
        para([text("Second line.\n")]),
      ]);
      expect(extractDocText(doc)).toBe("Hello, world.\nSecond line.\n");
    });

    it("returns an empty string for a document with no body", () => {
      expect(extractDocText({})).toBe("");
    });

    it("skips an inline image, which carries no text run", () => {
      expect(extractDocText(imageDoc("https://example.test/a.png"))).toBe("");
    });
  });

  describe("convertDocToMarkdown()", () => {
    describe("headings", () => {
      it("renders HEADING_1 with one hash", async () => {
        expect(
          await convertDocToMarkdown(docOf([heading("Intro", "HEADING_1")])),
        )
          .toBe("# Intro");
      });

      it("renders HEADING_3 with three hashes", async () => {
        expect(
          await convertDocToMarkdown(docOf([heading("Detail", "HEADING_3")])),
        )
          .toBe("### Detail");
      });

      it("caps a heading deeper than six at six hashes", async () => {
        expect(
          await convertDocToMarkdown(docOf([heading("Deep", "HEADING_9")])),
        )
          .toBe("###### Deep");
      });

      it("renders TITLE as a top-level heading", async () => {
        expect(await convertDocToMarkdown(docOf([heading("Doc", "TITLE")])))
          .toBe("# Doc");
      });

      it("renders SUBTITLE as a second-level heading", async () => {
        expect(await convertDocToMarkdown(docOf([heading("Sub", "SUBTITLE")])))
          .toBe("## Sub");
      });

      it("renders an unstyled paragraph as plain text", async () => {
        expect(await convertDocToMarkdown(docOf([para([text("Just words.")])])))
          .toBe("Just words.");
      });
    });

    describe("inline formatting", () => {
      it("wraps bold text in two asterisks", async () => {
        const doc = docOf([para([text("loud", { bold: true })])]);
        expect(await convertDocToMarkdown(doc)).toBe("**loud**");
      });

      it("wraps italic text in one asterisk", async () => {
        const doc = docOf([para([text("soft", { italic: true })])]);
        expect(await convertDocToMarkdown(doc)).toBe("*soft*");
      });

      it("wraps text that is both bold and italic in three asterisks", async () => {
        const doc = docOf([
          para([text("both", { bold: true, italic: true })]),
        ]);
        expect(await convertDocToMarkdown(doc)).toBe("***both***");
      });

      it("wraps struck-through text in two tildes", async () => {
        const doc = docOf([para([text("gone", { strikethrough: true })])]);
        expect(await convertDocToMarkdown(doc)).toBe("~~gone~~");
      });

      it("renders a link as markdown link syntax", async () => {
        const doc = docOf([
          para([text("here", { link: { url: "https://example.test/" } })]),
        ]);
        expect(await convertDocToMarkdown(doc)).toBe(
          "[here](https://example.test/)",
        );
      });

      it("wraps a bold link so the emphasis is outside the link", async () => {
        const doc = docOf([
          para([
            text("here", {
              bold: true,
              link: { url: "https://example.test/" },
            }),
          ]),
        ]);
        expect(await convertDocToMarkdown(doc)).toBe(
          "**[here](https://example.test/)**",
        );
      });

      it("leaves whitespace-only content unformatted", async () => {
        const doc = docOf([
          para([text("kept", { bold: true }), text("   ", { bold: true })]),
        ]);
        expect(await convertDocToMarkdown(doc)).toBe("**kept**");
      });

      it("renders a horizontal rule element as a rule", async () => {
        const doc = docOf([para([{ horizontalRule: {} }])]);
        expect(await convertDocToMarkdown(doc)).toBe("---");
      });
    });

    describe("lists", () => {
      it("marks an item with a dash when the list has no ordered glyph", async () => {
        const doc = docOf([bullet("Milk", "l1"), bullet("Eggs", "l1")], {
          lists: { l1: glyphs("GLYPH_TYPE_UNSPECIFIED") },
        });
        expect(await convertDocToMarkdown(doc)).toBe("- Milk\n- Eggs");
      });

      it("marks an item with a dash when the list is unknown", async () => {
        const doc = docOf([bullet("Orphan", "missing")]);
        expect(await convertDocToMarkdown(doc)).toBe("- Orphan");
      });

      it("numbers the items of a decimal list from one", async () => {
        const doc = docOf([bullet("First", "l1"), bullet("Second", "l1")], {
          lists: { l1: glyphs("DECIMAL") },
        });
        expect(await convertDocToMarkdown(doc)).toBe("1. First\n2. Second");
      });

      it("indents a nested item by two spaces per level", async () => {
        const doc = docOf([
          bullet("Top", "l1", 0),
          bullet("Nested", "l1", 1),
        ], { lists: { l1: glyphs("DECIMAL", "DECIMAL") } });
        expect(await convertDocToMarkdown(doc)).toBe("1. Top\n  1. Nested");
      });

      it("restarts the nested counter when the outer level advances", async () => {
        const doc = docOf([
          bullet("One", "l1", 0),
          bullet("One-a", "l1", 1),
          bullet("Two", "l1", 0),
          bullet("Two-a", "l1", 1),
        ], { lists: { l1: glyphs("DECIMAL", "DECIMAL") } });
        expect(await convertDocToMarkdown(doc)).toBe(
          "1. One\n  1. One-a\n2. Two\n  1. Two-a",
        );
      });

      it("restarts numbering when a second list begins", async () => {
        const doc = docOf([
          bullet("A", "l1"),
          bullet("B", "l2"),
        ], { lists: { l1: glyphs("DECIMAL"), l2: glyphs("DECIMAL") } });
        expect(await convertDocToMarkdown(doc)).toBe("1. A\n1. B");
      });
    });

    describe("tables", () => {
      it("writes a separator row beneath the first row", async () => {
        const doc = docOf([{
          startIndex: 0,
          endIndex: 0,
          table: {
            rows: 2,
            columns: 2,
            tableRows: [row("A", "B"), row("1", "2")],
          },
        }]);
        expect(await convertDocToMarkdown(doc)).toBe(
          "| A | B |\n| --- | --- |\n| 1 | 2 |",
        );
      });

      it("escapes a pipe inside a cell", async () => {
        const doc = docOf([{
          startIndex: 0,
          endIndex: 0,
          table: { rows: 1, columns: 1, tableRows: [row("a|b")] },
        }]);
        expect(await convertDocToMarkdown(doc)).toBe("| a\\|b |\n| --- |");
      });

      it("skips a table with no rows", async () => {
        const doc = docOf([
          para([text("Before")]),
          {
            startIndex: 0,
            endIndex: 0,
            table: { rows: 0, columns: 0, tableRows: [] },
          },
        ]);
        expect(await convertDocToMarkdown(doc)).toBe("Before");
      });
    });

    describe("section breaks", () => {
      it("renders a section break as a horizontal rule", async () => {
        const doc = docOf([
          para([text("Above")]),
          { startIndex: 0, endIndex: 0, sectionBreak: {} },
          para([text("Below")]),
        ]);
        expect(await convertDocToMarkdown(doc)).toBe("Above\n\n---\n\nBelow");
      });
    });

    describe("images", () => {
      it("links an image and notes that Google gates it", async () => {
        const markdown = await convertDocToMarkdown(
          imageDoc("https://docs.test/image", "Chart"),
          [],
          { embedImages: false },
        );
        expect(markdown).toBe(
          "![Chart](https://docs.test/image)\n<!-- Note: Image requires Google authentication to view -->",
        );
      });

      it("calls an image with neither title nor description 'Image'", async () => {
        const markdown = await convertDocToMarkdown(
          imageDoc("https://docs.test/image"),
          [],
          { embedImages: false },
        );
        expect(markdown.startsWith("![Image](https://docs.test/image)")).toBe(
          true,
        );
      });

      it("skips an inline object that carries no embedded object", async () => {
        const doc = docOf(
          [para([
            text("Text "),
            { inlineObjectElement: { inlineObjectId: "missing" } },
          ])],
        );
        expect(await convertDocToMarkdown(doc)).toBe("Text");
      });
    });

    describe("comments", () => {
      it("places a comment as a blockquote after the paragraph it quotes", async () => {
        const doc = docOf([para([text("The quick brown fox")])]);
        const markdown = await convertDocToMarkdown(doc, [
          comment({
            id: "c1",
            content: "Nice phrase",
            quotedFileContent: { value: "quick brown" },
          }),
        ]);
        expect(markdown.startsWith("The quick brown fox\n\n> **Alice**")).toBe(
          true,
        );
        expect(markdown).toContain("> Nice phrase");
      });

      it("nests a reply one blockquote level deeper", async () => {
        const doc = docOf([para([text("Draft text")])]);
        const markdown = await convertDocToMarkdown(doc, [
          comment({
            id: "c1",
            content: "First",
            quotedFileContent: { value: "Draft" },
            replies: [{
              id: "r1",
              author: { displayName: "Bob" },
              content: "Agreed",
              createdTime: "2026-01-16T10:00:00Z",
            }],
          }),
        ]);
        expect(markdown).toContain("> > **Bob**");
        expect(markdown).toContain("> > Agreed");
      });

      it("omits a reply that only resolves the thread", async () => {
        const doc = docOf([para([text("Draft text")])]);
        const markdown = await convertDocToMarkdown(doc, [
          comment({
            id: "c1",
            content: "First",
            quotedFileContent: { value: "Draft" },
            replies: [{
              id: "r1",
              author: { displayName: "Bob" },
              content: "Closing this",
              createdTime: "2026-01-16T10:00:00Z",
              action: "resolve",
            }],
          }),
        ]);
        expect(markdown).not.toContain("Closing this");
      });

      it("omits a resolved comment altogether", async () => {
        const doc = docOf([para([text("The quick brown fox")])]);
        const markdown = await convertDocToMarkdown(doc, [
          comment({
            id: "c1",
            content: "Old note",
            resolved: true,
            quotedFileContent: { value: "quick brown" },
          }),
        ]);
        expect(markdown).toBe("The quick brown fox");
      });

      it("collects a comment whose quoted text is absent into a trailing section", async () => {
        const doc = docOf([para([text("Body text")])]);
        const markdown = await convertDocToMarkdown(doc, [
          comment({
            id: "c1",
            content: "Stray note",
            quotedFileContent: { value: "not in the document" },
          }),
        ]);
        expect(markdown).toContain("## Comments");
        expect(markdown).toContain('*On: "not in the document"*');
        expect(markdown).toContain("> Stray note");
      });

      it("quotes a comment against only the first paragraph that matches", async () => {
        const doc = docOf([
          para([text("shared phrase one")]),
          para([text("shared phrase two")]),
        ]);
        const markdown = await convertDocToMarkdown(doc, [
          comment({
            id: "c1",
            content: "Only once",
            quotedFileContent: { value: "shared phrase" },
          }),
        ]);
        expect(markdown.split("Only once").length - 1).toBe(1);
      });

      it("drops every comment when comments are switched off", async () => {
        const doc = docOf([para([text("The quick brown fox")])]);
        const markdown = await convertDocToMarkdown(doc, [
          comment({
            id: "c1",
            content: "Nice phrase",
            quotedFileContent: { value: "quick brown" },
          }),
        ], { includeComments: false });
        expect(markdown).toBe("The quick brown fox");
      });
    });

    describe("whitespace", () => {
      it("keeps one blank line between paragraphs separated by an empty one", async () => {
        const doc = docOf([
          para([text("First")]),
          para([text("   ")]),
          para([text("Last")]),
        ]);
        expect(await convertDocToMarkdown(doc)).toBe("First\n\nLast");
      });

      it("collapses a longer run of empty paragraphs to the same blank line", async () => {
        const doc = docOf([
          para([text("First")]),
          para([text("   ")]),
          para([text("   ")]),
          para([text("Last")]),
        ]);
        expect(await convertDocToMarkdown(doc)).toBe("First\n\nLast");
      });

      it("returns an empty string for a document with no content", async () => {
        expect(await convertDocToMarkdown({})).toBe("");
      });
    });
  });

  describe("downloadImageAsBase64()", () => {
    const realFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = realFetch;
    });

    const respondWith = (response: Response) => {
      globalThis.fetch = () => Promise.resolve(response);
    };

    it("returns a data URL carrying the image bytes", async () => {
      respondWith(
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "image/gif" },
        }),
      );
      expect(await downloadImageAsBase64("https://docs.test/i", "tok")).toBe(
        `data:image/gif;base64,${btoa("\x01\x02\x03")}`,
      );
    });

    it("defaults the media type to PNG when the response names none", async () => {
      const response = new Response(new Uint8Array([0]));
      response.headers.delete("content-type");
      respondWith(response);
      const url = await downloadImageAsBase64("https://docs.test/i", "tok");
      expect(url?.startsWith("data:image/png;base64,")).toBe(true);
    });

    it("sends the token as a bearer credential", async () => {
      let seen: Headers | undefined;
      globalThis.fetch = (_input, init) => {
        seen = new Headers(init?.headers);
        return Promise.resolve(new Response(new Uint8Array([0])));
      };
      await downloadImageAsBase64("https://docs.test/i", "tok");
      expect(seen?.get("Authorization")).toBe("Bearer tok");
    });

    it("returns null for a response that is not ok", async () => {
      respondWith(new Response("nope", { status: 403 }));
      expect(await downloadImageAsBase64("https://docs.test/i", "tok")).toBe(
        null,
      );
    });

    it("returns null when the declared length exceeds the ceiling", async () => {
      respondWith(
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-length": "9999" },
        }),
      );
      expect(await downloadImageAsBase64("https://docs.test/i", "tok", 10))
        .toBe(null);
    });

    it("returns null when the downloaded body exceeds the ceiling", async () => {
      respondWith(new Response(new Uint8Array([1, 2, 3, 4, 5])));
      expect(await downloadImageAsBase64("https://docs.test/i", "tok", 2))
        .toBe(null);
    });

    it("returns null when the request throws", async () => {
      globalThis.fetch = () => Promise.reject(new Error("offline"));
      expect(await downloadImageAsBase64("https://docs.test/i", "tok")).toBe(
        null,
      );
    });
  });
});
