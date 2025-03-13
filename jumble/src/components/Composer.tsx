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
// Function to parse Slate document and extract mention references
export async function parseComposerDocument(
  serializedDocument: string,
  charmManager: CharmManager,
): Promise<{
  text: string;
  mentions: string[];
  bibliography: { [id: string]: { title: string; body: any } };
}> {
  try {
    const document = JSON.parse(serializedDocument) as Descendant[];
    let fullText = "";
    const mentions: string[] = [];
    const bibliography: { [id: string]: { title: string; body: string } } = {};
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
            const bibIndex = Object.keys(bibliography).length + 1;
            const charm = await charmManager.get(node.id);
            const data = charm?.getSourceCell().get().argument;
            bibliography[node.id] = {
              title: node.character || `Reference ${bibIndex}`,
              body: data,
            };

            mentionIndices[node.id] = bibIndex;
          }

          // Add reference in markdown format
          fullText += `[${node.character}](charm://${node.id})`;
        } else {
          // Fallback for backward compatibility
          const match = node.character.match(/\(#([a-z0-9]+)\)$/);
          if (match && match[1]) {
            const referenceId = match[1];

            if (!mentionIndices[referenceId]) {
              mentions.push(referenceId);

              const bibIndex = Object.keys(bibliography).length + 1;
              const charm = await charmManager.get(referenceId);
              const data = charm?.getSourceCell().get().argument;
              bibliography[referenceId] = {
                title: node.character || `Reference ${bibIndex}`,
                body: data,
              };

              mentionIndices[referenceId] = bibIndex;
            }

            // Add reference in markdown format
            fullText += `[${node.character}](charm://${referenceId})`;
          } else {
            fullText += `@${node.character}`;
          }
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
      bibliography,
    };
  } catch (error) {
    console.error("Failed to parse document:", error);
    return { text: "", mentions: [], bibliography: {} };
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

// Define our custom types
interface MentionElement extends BaseElement {
  type: "mention";
  character: string;
  children: { text: string; bold?: boolean; italic?: boolean }[];
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

interface CustomEditor extends Editor {
  isInline: (element: SlateElement) => boolean;
  isVoid: (element: SlateElement) => boolean;
  markableVoid: (element: SlateElement) => boolean;
}

interface RenderElementPropsFor<T extends BaseElement>
  extends RenderElementProps {
  element: T;
}

const Portal = ({ children }: { children: React.ReactNode }) => {
  return createPortal(children, document.body);
};

const SHORTCUTS: Record<string, string> = {
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
} as const;

const withShortcuts = (editor: CustomEditor) => {
  const { deleteBackward, insertText } = editor;

  editor.insertText = (text) => {
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
      const type = SHORTCUTS[beforeText];

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

  editor.deleteBackward = (...args) => {
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
  onKeyDown: externalOnKeyDown,
  style,
  mentions = [],
}: {
  placeholder?: string;
  readOnly?: boolean;
  value: string;
  onValueChange: (value: string) => void;
  onKeyDown?: (e: React.KeyboardEvent) => void;
  style?: React.CSSProperties;
  mentions?: Array<{ id: string; name: string }>;
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
    (props: RenderElementProps) => <Element {...props} />,
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
      ed = withMentions(ed); // Apply mentions capabilities
      ed = withShortcuts(ed); // Apply markdown shortcuts

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
    (e: InputEvent) => {
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
            match: (n) => Editor.isBlock(editor, n),
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
      if (externalOnKeyDown) {
        externalOnKeyDown(event as any);
      }

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
            // case "Enter":
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
      }
    },
    [filteredMentions, editor, index, target, externalOnKeyDown],
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
  return (
    <>
      <Slate editor={editor} initialValue={currentValue} onChange={onChange}>
        <Editable
          className="border border-gray-400 p-2"
          readOnly={readOnly}
          renderElement={renderElement}
          renderLeaf={renderLeaf}
          onKeyDown={handleKeyDown}
          onDOMBeforeInput={handleDOMBeforeInput}
          placeholder={placeholder || "Enter some text..."}
          style={{
            ...style,
            overflowY: "auto",
          }}
        />
        {target && filteredMentions.length > 0 && (
          <Portal>
            <div
              ref={ref}
              style={{
                top: "-9999px",
                left: "-9999px",
                position: "absolute",
                zIndex: 9999,
                padding: "3px",
                background: "white",
                borderRadius: "4px",
                boxShadow: "0 1px 5px rgba(0,0,0,.2)",
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
                  style={{
                    padding: "1px 3px",
                    borderRadius: "3px",
                    cursor: "pointer",
                    background: i === index ? "#B4D5FF" : "transparent",
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

const withMentions = (editor: CustomEditor) => {
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
const Element = (props: RenderElementProps) => {
  const { attributes, children, element } = props;
  switch ((element as BaseElement & { type?: string }).type) {
    case "mention":
      return <Mention {...props as RenderElementPropsFor<MentionElement>} />;
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
