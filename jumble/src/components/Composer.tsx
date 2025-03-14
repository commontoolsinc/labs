import React, {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  BaseEditor,
  BaseElement,
  BaseSelection,
  BaseText,
  createEditor,
  Descendant,
  Editor,
  Element as SlateElement,
  Point,
  Range,
  Transforms,
} from "slate";
import { withHistory } from "slate-history";
import {
  Editable,
  ReactEditor,
  RenderElementProps,
  RenderLeafProps,
  Slate,
  useFocused,
  useSelected,
  withReact,
} from "slate-react";
import { createPortal } from "react-dom";
import { CharmManager } from "../../../charm/src/index.ts";
import { Module, Recipe, TYPE } from "@commontools/builder";
import { Cell, getRecipe } from "@commontools/runner";

// First define a basic interface with the required ReactEditor methods plus our extensions
interface EditorWithExtensions extends BaseEditor, ReactEditor {
  isInline: (element: SlateElement) => boolean;
  isVoid: (element: SlateElement) => boolean;
  markableVoid: (element: SlateElement) => boolean;
  insertText: (text: string) => void;
  deleteBackward: (...args: any[]) => void;
}

// Update the module declaration without referring to Editor directly
declare module "slate" {
  interface CustomTypes {
    Editor: EditorWithExtensions;
    Element:
      | MentionElement
      | BulletedListElement
      | HeadingElement
      | BlockQuoteElement
      | ListItemElement
      | { type: "paragraph"; children: Descendant[] };
    Text: BaseText & {
      bold?: boolean;
      italic?: boolean;
    };
  }
}

// Define CustomEditor for local usage
type CustomEditor = Editor & EditorWithExtensions;

interface MentionElement extends BaseElement {
  type: "mention";
  character: string;
  id?: string; // Make sure id is included in the type
  children: { text: string; bold?: boolean; italic?: boolean }[];
}

// Function to parse Slate document and extract mention references
export async function parseComposerDocument(
  serializedDocument: string,
  charmManager: CharmManager,
): Promise<{
  text: string;
  mentions: string[];
  sources: {
    [id: string]: { name: string; cell: Cell<any>; recipe?: Recipe | Module };
  };
}> {
  try {
    const document = JSON.parse(serializedDocument) as Descendant[];
    let fullText = "";
    const mentions: string[] = [];
    const sources: {
      [id: string]: { name: string; cell: Cell<any> };
    } = {};
    const mentionIndices: Record<string, number> = {};

    // Helper to add markdown styling based on node type
    const processNode = async (
      node: any,
      currentList: { type: string | null; level: number } = {
        type: null,
        level: 0,
      },
    ) => {
      if (node.type === "mention") {
        if (node.id) {
          // Add to mentions list if not already present
          if (!mentionIndices[node.id]) {
            mentions.push(node.id);

            // Create bibliography entry
            const bibIndex = Object.keys(sources).length + 1;
            const charm = await charmManager.get(node.id);
            if (!charm) {
              throw new Error(`Charm not found for mention ${node.id}`);
            }

            sources[node.id] = {
              name: node.character || `Reference ${bibIndex}`,
              cell: charm,
            };

            mentionIndices[node.id] = bibIndex;
          }

          // Add reference in markdown format
          fullText += `[${node.character}](charm://${node.id})`;
        } else {
          // Handle mentions without explicit IDs (plain text mentions)
          fullText += `@${node.character}`;
        }
      } else if (node.text !== undefined) {
        // Handle text with formatting
        let textContent = node.text;
        if (node.bold) textContent = `**${textContent}**`;
        if (node.italic) textContent = `*${textContent}*`;
        fullText += textContent;
      } else if (node.children) {
        // Handle block elements with markdown syntax
        switch (node.type) {
          case "heading-one":
            fullText += "# ";
            break;
          case "heading-two":
            fullText += "## ";
            break;
          case "heading-three":
            fullText += "### ";
            break;
          case "heading-four":
            fullText += "#### ";
            break;
          case "heading-five":
            fullText += "##### ";
            break;
          case "heading-six":
            fullText += "###### ";
            break;
          case "block-quote":
            fullText += "> ";
            break;
          case "bulleted-list":
            // Just process children - the list items will add the markers
            for (const child of node.children) {
              await processNode(child, {
                type: "bulleted-list",
                level: currentList.level + 1,
              });
            }
            return; // Skip the default children processing below
          case "list-item":
            fullText += "* ";
            break;
        }

        // Process children
        for (const child of node.children) {
          await processNode(child, currentList);
        }

        // Add appropriate line breaks after block elements
        if (node.type && node.type !== "list-item") {
          fullText += "\n\n";
        } else if (node.type === "list-item") {
          fullText += "\n";
        }
      }
    };

    // Process each node sequentially with await
    for (const node of document) {
      await processNode(node);
    }

    return {
      text: fullText.trim(), // Remove extra whitespace
      mentions,
      sources,
    };
  } catch (error) {
    console.error("Failed to parse document:", error);
    return { text: "", mentions: [], sources: {} };
  }
}

// Helper function to replace mentions with their actual content
export function replaceMentionsWithContent(
  parsedDocument: { text: string; mentions: string[] },
  mentionContent: Record<string, any>,
): string {
  let result = parsedDocument.text;

  // Replace each mention with its content
  for (const mentionId of parsedDocument.mentions) {
    const content = mentionContent[mentionId];
    if (content) {
      // Find the mention pattern in the text and replace it with content
      const mentionRegex = new RegExp(`@[^@]+(#${mentionId})\\)`, "g");
      result = result.replace(mentionRegex, content);
    }
  }

  return result;
}

interface BulletedListElement extends BaseElement {
  type: "bulleted-list";
  children: Descendant[];
}

interface HeadingElement extends BaseElement {
  type:
    | "heading-one"
    | "heading-two"
    | "heading-three"
    | "heading-four"
    | "heading-five"
    | "heading-six";
  children: Descendant[];
}

interface BlockQuoteElement extends BaseElement {
  type: "block-quote";
  children: Descendant[];
}

interface ListItemElement extends BaseElement {
  type: "list-item";
  children: Descendant[];
}

// Fix the RenderElementPropsFor interface
interface RenderElementPropsFor<T> extends Omit<RenderElementProps, "element"> {
  element: T;
}

const Portal = ({ children }: { children: React.ReactNode }) => {
  return createPortal(children, document.body);
};

const SHORTCUTS: Record<
  string,
  | "list-item"
  | "block-quote"
  | "heading-one"
  | "heading-two"
  | "heading-three"
  | "heading-four"
  | "heading-five"
  | "heading-six"
> = {
  "*": "list-item",
  "-": "list-item",
  "+": "list-item",
  ">": "block-quote",
  "#": "heading-one",
  "##": "heading-two",
  "###": "heading-three",
  "####": "heading-four",
  "#####": "heading-five",
  "######": "heading-six",
};

const withShortcuts = (editor: CustomEditor) => {
  const { deleteBackward, insertText } = editor;

  editor.insertText = (text: string) => {
    const { selection } = editor;

    if (text.endsWith(" ") && selection && Range.isCollapsed(selection)) {
      const { anchor } = selection;
      const block = Editor.above(editor, {
        match: (n) => SlateElement.isElement(n) && Editor.isBlock(editor, n),
      });
      const path = block ? block[1] : [];
      const start = Editor.start(editor, path);
      const range = { anchor, focus: start };
      const beforeText = Editor.string(editor, range) + text.slice(0, -1);
      const type = SHORTCUTS[beforeText as keyof typeof SHORTCUTS];

      if (type) {
        Transforms.select(editor, range);

        if (!Range.isCollapsed(range)) {
          Transforms.delete(editor);
        }

        const newProperties: Partial<SlateElement> = {
          type,
        };
        Transforms.setNodes<SlateElement>(editor, newProperties, {
          match: (n) => SlateElement.isElement(n) && Editor.isBlock(editor, n),
        });

        if (type === "list-item") {
          const list: BulletedListElement = {
            type: "bulleted-list",
            children: [],
          };
          Transforms.wrapNodes(editor, list, {
            match: (n) =>
              !Editor.isEditor(n) &&
              SlateElement.isElement(n) &&
              n.type === "list-item",
          });
        }

        return;
      }
    }

    insertText(text);
  };

  editor.deleteBackward = (...args: any[]) => {
    const { selection } = editor;

    if (selection && Range.isCollapsed(selection)) {
      const match = Editor.above(editor, {
        match: (n) => SlateElement.isElement(n) && Editor.isBlock(editor, n),
      });

      if (match) {
        const [block, path] = match;
        const start = Editor.start(editor, path);

        if (
          !Editor.isEditor(block) &&
          SlateElement.isElement(block) &&
          block.type !== "paragraph" &&
          Point.equals(selection.anchor, start)
        ) {
          const newProperties: Partial<SlateElement> = {
            type: "paragraph",
          };
          Transforms.setNodes(editor, newProperties);

          if (block.type === "list-item") {
            Transforms.unwrapNodes(editor, {
              match: (n) =>
                !Editor.isEditor(n) &&
                SlateElement.isElement(n) &&
                n.type === "bulleted-list",
              split: true,
            });
          }

          return;
        }
      }

      deleteBackward(...args);
    }
  };

  return editor;
};

export function Composer({
  placeholder,
  readOnly,
  value,
  onValueChange,
  style,
  mentions = [],
  autoFocus = false,
  onSubmit,
}: {
  placeholder?: string;
  readOnly?: boolean;
  value: string;
  onValueChange: (value: string) => void;
  style?: React.CSSProperties;
  mentions?: Array<{ id: string; name: string }>;
  autoFocus?: boolean;
  onSubmit?: () => void;
}) {
  // Convert string value to Slate value format if needed
  const initialValue: Descendant[] = useMemo(() => {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : defaultInitialValue;
    } catch {
      return value
        ? [{ type: "paragraph", children: [{ text: value }] }]
        : defaultInitialValue;
    }
  }, [value]);

  const ref = useRef<HTMLDivElement | null>(null);
  const [target, setTarget] = useState<Range | null>(null);
  const [index, setIndex] = useState(0);
  const [search, setSearch] = useState("");
  const [currentValue, setCurrentValue] = useState<Descendant[]>(initialValue);

  const renderElement = useCallback(
    (props: RenderElementProps) => <ElementComponent {...props} />,
    [],
  );

  const renderLeaf = useCallback(
    (props: RenderLeafProps) => <Leaf {...props} />,
    [],
  );

  const editor = useMemo(
    () => {
      // Start with the base editor
      let ed = createEditor();

      // Apply plugins in the correct order
      ed = withHistory(ed);
      ed = withReact(ed);
      ed = withMentions(ed as CustomEditor); // Apply mentions capabilities
      ed = withShortcuts(ed as CustomEditor); // Apply markdown shortcuts

      return ed as CustomEditor;
    },
    [],
  );

  // Filter mentions based on search query
  const filteredMentions = useMemo(() =>
    mentions
      .filter((mention) =>
        mention.name.toLowerCase().includes(search.toLowerCase())
      )
      .slice(0, 10), [mentions, search]);

  const handleDOMBeforeInput = useCallback(
    (_: InputEvent) => {
      queueMicrotask(() => {
        const pendingDiffs = ReactEditor.androidPendingDiffs(editor);

        const scheduleFlush = pendingDiffs?.some(({ diff, path }) => {
          if (!diff.text.endsWith(" ")) {
            return false;
          }

          const { text } = Editor.node(editor, path)[0] as any;
          const beforeText = text.slice(0, diff.start) + diff.text.slice(0, -1);
          if (!(beforeText in SHORTCUTS)) {
            return;
          }

          const blockEntry = Editor.above(editor, {
            at: path,
            match: (n) =>
              SlateElement.isElement(n) && Editor.isBlock(editor, n),
          });
          if (!blockEntry) {
            return false;
          }

          const [, blockPath] = blockEntry;
          return Editor.isStart(editor, Editor.start(editor, path), blockPath);
        });

        if (scheduleFlush) {
          ReactEditor.androidScheduleFlush(editor);
        }
      });
    },
    [editor],
  );

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      // Handle mention selection navigation
      if (target && filteredMentions.length > 0) {
        switch (event.key) {
          case "ArrowDown": {
            event.preventDefault();
            const prevIndex = index >= filteredMentions.length - 1
              ? 0
              : index + 1;
            setIndex(prevIndex);
            break;
          }
          case "ArrowUp": {
            event.preventDefault();
            const nextIndex = index <= 0
              ? filteredMentions.length - 1
              : index - 1;
            setIndex(nextIndex);
            break;
          }
          case "Tab":
          case "Enter": // Allow Enter to select a mention when the mention menu is open
            event.preventDefault();
            Transforms.select(editor, target);
            insertMention(
              editor,
              filteredMentions[index].id,
              filteredMentions[index].name,
            );
            setTarget(null);
            break;
          case "Escape":
            event.preventDefault();
            setTarget(null);
            break;
        }
      } else if (event.key === "Enter" && !event.shiftKey && onSubmit) {
        // Only trigger onSubmit when:
        // 1. Enter is pressed
        // 2. Shift isn't pressed (to allow line breaks)
        // 3. The mention menu is closed
        // 4. There's an onSubmit handler
        event.preventDefault();
        onSubmit();
      }
    },
    [filteredMentions, editor, index, target, onSubmit],
  );

  useEffect(() => {
    if (target && filteredMentions.length > 0 && ref.current) {
      try {
        const el = ref.current;
        // Check if the editor has content before attempting to create a DOM range
        if (editor.children.length > 0) {
          const domRange = ReactEditor.toDOMRange(editor, target);
          const rect = domRange.getBoundingClientRect();
          el.style.top = `${rect.top + globalThis.scrollY + 24}px`;
          el.style.left = `${rect.left + globalThis.scrollX}px`;
        }
      } catch (error) {
        // Safely handle errors that might occur after hot module reload
        console.error("Error positioning mention dropdown:", error);
        setTarget(null); // Clear the target to prevent further errors
      }
    }
  }, [filteredMentions.length, editor, index, search, target]);

  // Update parent component's value when editor content changes
  useEffect(() => {
    const stringValue = JSON.stringify(currentValue);
    if (stringValue !== value) {
      onValueChange(stringValue);
    }
  }, [currentValue, onValueChange, value]);

  // Handle editor changes including mention detection
  const onChange = useCallback(() => {
    const { selection } = editor;

    if (selection && Range.isCollapsed(selection)) {
      const [start] = Range.edges(selection);
      const wordBefore = Editor.before(editor, start, { unit: "word" });
      const before = wordBefore && Editor.before(editor, wordBefore);
      const beforeRange = before && Editor.range(editor, before, start);
      const beforeText = beforeRange && Editor.string(editor, beforeRange);
      const beforeMatch = beforeText && beforeText.match(/^@(\w+)$/);
      const after = Editor.after(editor, start);
      const afterRange = Editor.range(editor, start, after);
      const afterText = Editor.string(editor, afterRange);
      const afterMatch = afterText.match(/^(\s|$)/);

      if (beforeMatch && afterMatch) {
        setTarget(beforeRange);
        setSearch(beforeMatch[1]);
        setIndex(0);
        return;
      }
    }

    setTarget(null);

    // Update the current value
    setCurrentValue(editor.children);
  }, [editor]);

  useEffect(() => {
    if (autoFocus && editor) {
      // Small delay to ensure the editor is fully mounted
      setTimeout(() => {
        ReactEditor.focus(editor);
      }, 0);
    }
  }, [autoFocus, editor]);

  return (
    <>
      <Slate editor={editor} initialValue={currentValue} onChange={onChange}>
        <Editable
          id="composer"
          className="p-2"
          readOnly={readOnly}
          renderElement={renderElement}
          renderLeaf={renderLeaf}
          onKeyDown={handleKeyDown}
          onDOMBeforeInput={handleDOMBeforeInput}
          placeholder={placeholder || "Enter some text..."}
          renderPlaceholder={({
            children,
            attributes,
          }) => (
            <span {...attributes} className="p-2 inline-block text-gray-400">
              {children}
            </span>
          )}
          style={{
            ...style,
            overflowY: "auto",
            minHeight: "36px",
            maxHeight: "200px",
            height: "auto",
            resize: "none",
          }}
        />
        {target && filteredMentions.length > 0 && (
          <Portal>
            <div
              ref={ref}
              className="absolute z-[9999] bg-white rounded-md shadow-md p-1 max-h-[200px] overflow-y-auto"
              style={{
                top: "-9999px",
                left: "-9999px",
                position: "absolute",
                maxHeight: "200px",
                pointerEvents: "auto",
              }}
            >
              {filteredMentions.map((
                mention: { id: string; name: string },
                i: number,
              ) => (
                <div
                  key={mention.id}
                  onClick={(e: ReactMouseEvent) => {
                    e.preventDefault();
                    e.stopPropagation();
                    Transforms.select(editor, target);
                    insertMention(editor, mention.id, mention.name);
                    setTarget(null);
                  }}
                  className={`px-3 py-1.5 rounded-sm cursor-pointer transition-colors duration-150
                    ${i === index ? "bg-blue-100" : "hover:bg-gray-100"}`}
                  onMouseDown={(e) => {
                    // Prevent the click from dismissing the command palette
                    e.stopPropagation();
                  }}
                >
                  {mention.name}
                </div>
              ))}
            </div>
          </Portal>
        )}
      </Slate>
    </>
  );
}

const withMentions = (editor: CustomEditor): CustomEditor => {
  const { isInline, isVoid, markableVoid } = editor;

  editor.isInline = (element: SlateElement) => {
    return element.type === "mention" ? true : isInline(element);
  };

  editor.isVoid = (element: SlateElement) => {
    return element.type === "mention" ? true : isVoid(element);
  };

  editor.markableVoid = (element: SlateElement) => {
    return element.type === "mention" || markableVoid(element);
  };

  return editor;
};

const insertMention = (editor: CustomEditor, id: string, character: string) => {
  const mention: MentionElement & { id: string } = {
    type: "mention",
    character,
    id,
    children: [{ text: "" }],
  };
  Transforms.insertNodes(editor, mention);
  Transforms.move(editor);
};

// Basic Leaf renderer
const Leaf = ({ attributes, children, leaf }: RenderLeafProps) => {
  if ((leaf as BaseText & { bold?: boolean }).bold) {
    children = <strong>{children}</strong>;
  }

  if ((leaf as BaseText & { italic?: boolean }).italic) {
    children = <em>{children}</em>;
  }

  return <span {...attributes}>{children}</span>;
};

// Element renderer
const ElementComponent = (props: RenderElementProps) => {
  const { attributes, children, element } = props;
  const elementType = element.type;

  switch (elementType) {
    case "mention":
      return (
        <Mention {...props as RenderElementPropsFor<MentionElement>}>
          {children}
        </Mention>
      );
    case "block-quote":
      return (
        <blockquote
          {...attributes}
          className="border-l-4 border-gray-300 pl-4 italic text-gray-700 my-2"
        >
          {children}
        </blockquote>
      );
    case "bulleted-list":
      return (
        <ul
          {...attributes}
          className="list-disc pl-5 "
        >
          {children}
        </ul>
      );
    case "heading-one":
      return (
        <h1
          {...attributes}
          className="text-3xl font-bold leading-tight"
        >
          {children}
        </h1>
      );
    case "heading-two":
      return (
        <h2
          {...attributes}
          className="text-2xl font-bold leading-tight"
        >
          {children}
        </h2>
      );
    case "heading-three":
      return (
        <h3
          {...attributes}
          className="text-xl font-bold leading-snug"
        >
          {children}
        </h3>
      );
    case "heading-four":
      return (
        <h4
          {...attributes}
          className="text-lg font-bold leading-snug"
        >
          {children}
        </h4>
      );
    case "heading-five":
      return (
        <h5
          {...attributes}
          className="text-base font-bold leading-normal"
        >
          {children}
        </h5>
      );
    case "heading-six":
      return (
        <h6
          {...attributes}
          className="text-sm font-bold leading-normal"
        >
          {children}
        </h6>
      );
    case "list-item":
      return (
        <li
          {...attributes}
          className="mb-1.5 leading-relaxed"
        >
          {children}
        </li>
      );
    default:
      return (
        <p
          {...attributes}
          className="leading-relaxed"
        >
          {children}
        </p>
      );
  }
};

// Mention component
const Mention = ({
  attributes,
  children,
  element,
}: RenderElementPropsFor<MentionElement>) => {
  const selected = useSelected();
  const focused = useFocused();

  return (
    <span
      {...attributes}
      contentEditable={false}
      className={`px-1.5 py-1 mx-0.5 inline-block rounded bg-gray-200 text-sm ${
        selected && focused ? "ring-2 ring-blue-300" : ""
      }`}
    >
      <span contentEditable={false}>
        @{element.character}
        {children}
      </span>
    </span>
  );
};

// Default initial value if nothing is provided
const defaultInitialValue: Descendant[] = [
  {
    type: "paragraph",
    children: [{ text: "" }],
  },
];
