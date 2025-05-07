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
import { LuSend } from "react-icons/lu";
import { DitheredCube } from "@/components/DitherCube.tsx";

export function ComposerSubmitBar(
  { loading, onSubmit, operation = "Go", children }: {
    loading: boolean;
    onSubmit: () => void;
    operation?: string;
    children?: React.ReactNode;
  },
): JSX.Element {
  return (
    <div className="flex justify-between items-top w-full">
      <label className="text-[10px] text-gray-400">
        Shift+Enter for new line<br />
        Type <code>@</code> to mention a charm
      </label>

      <div className="flex flex-row gap-2">
        {children}

        <button
          type="button"
          onClick={onSubmit}
          disabled={loading}
          className="px-4 py-2 text-sm bg-black text-white flex items-center gap-2 disabled:opacity-50"
        >
          {loading
            ? (
              <span className="text-xs flex items-center gap-2">
                <DitheredCube
                  animationSpeed={2}
                  width={16}
                  height={16}
                  animate
                  cameraZoom={12}
                />
                <span>Working...</span>
              </span>
            )
            : (
              <span className="text-xs flex items-center gap-2">
                <span className="text-xs flex items-center gap-1">
                  <LuSend />
                  <span>{operation}</span>
                </span>
                <span className="hidden md:inline text-gray-400 font-bold italic">
                  (Enter)
                </span>
              </span>
            )}
        </button>
      </div>
    </div>
  );
}

/** WISHLIST
- inline code blocks for specifying keys / fields
*/

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

      if (block) {
        const [blockNode, path] = block;
        const start = Editor.start(editor, path);
        const range = { anchor, focus: start };
        const beforeText = Editor.string(editor, range) + text.slice(0, -1);

        // Check if the string before the cursor is a valid shortcut
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
            match: (n) =>
              SlateElement.isElement(n) && Editor.isBlock(editor, n),
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
  disabled = false,
}: {
  placeholder?: string;
  readOnly?: boolean;
  value: string;
  onValueChange: (value: string) => void;
  style?: React.CSSProperties;
  mentions?: Array<{ id: string; name: string }>;
  autoFocus?: boolean;
  onSubmit?: () => void;
  disabled?: boolean;
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
      // Don't process input when disabled
      if (disabled) return;

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
    [editor, disabled],
  );

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      // Don't process key events when disabled
      if (disabled) {
        event.preventDefault();
        return;
      }

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
      } else if (event.key === "Enter") {
        if (event.shiftKey) {
          // Manually insert a soft break/line break
          event.preventDefault();
          editor.insertText("\n");
          return;
        } else if (onSubmit) {
          // Only trigger onSubmit when:
          // 1. Enter is pressed (without Shift)
          // 2. The mention menu is closed
          // 3. There's an onSubmit handler
          event.preventDefault();
          onSubmit();
        }
      } else if (
        event.key === "ArrowUp" || event.key === "ArrowDown" ||
        event.key === "ArrowLeft" || event.key === "ArrowRight"
      ) {
        // For arrow key events in the main composer, ensure they don't
        // get captured by parent components (like CommandCenter)
        event.stopPropagation();
      }
    },
    [filteredMentions, editor, index, target, onSubmit, disabled],
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
    // Don't process changes when disabled
    if (disabled) return;

    const { selection } = editor;

    if (selection && Range.isCollapsed(selection)) {
      const [start] = Range.edges(selection);
      const wordBefore = Editor.before(editor, start, { unit: "word" });
      const before = wordBefore && Editor.before(editor, wordBefore);
      const beforeRange = before && Editor.range(editor, before, start);
      const beforeText = beforeRange && Editor.string(editor, beforeRange);

      const beforeMatch = beforeText && beforeText.match(/^@(\w+)$/);

      // If we detect exactly "@" at the end of the text, mock a match object
      const isJustAtSymbol = beforeText && beforeText.endsWith("@") &&
        beforeText.length > 0 && beforeText[beforeText.length - 1] === "@";

      // Use either the regex match or our mock match for a single "@"
      const finalBeforeMatch = isJustAtSymbol
        ? { 0: "@", 1: "" } // Mock match result for just "@"
        : beforeMatch;

      const after = Editor.after(editor, start);
      const afterRange = Editor.range(editor, start, after);
      const afterText = Editor.string(editor, afterRange);
      const afterMatch = afterText.match(/^(\s|$)/);

      if ((finalBeforeMatch || beforeMatch) && afterMatch && beforeRange) {
        setTarget(beforeRange);
        setSearch(
          finalBeforeMatch
            ? finalBeforeMatch[1]
            : (beforeMatch ? beforeMatch[1] : ""),
        );
        setIndex(0);
        return;
      }
    }

    setTarget(null);

    // Update the current value
    setCurrentValue(editor.children);
  }, [editor, disabled]);

  useEffect(() => {
    if (autoFocus && editor && !disabled) {
      // Small delay to ensure the editor is fully mounted
      setTimeout(() => {
        try {
          ReactEditor.focus(editor);
        } catch (error) {
          console.warn("Failed to focus editor:", error);
        }
      }, 100);
    }
  }, [autoFocus, editor, disabled]);

  return (
    <>
      <Slate editor={editor} initialValue={currentValue} onChange={onChange}>
        <Editable
          id="composer"
          className={`p-2 ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
          readOnly={readOnly || disabled}
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
            minHeight: "100px", // Changed from 36px to 100px to accommodate ~4 lines
            maxHeight: "200px",
            height: "auto",
            resize: "none",
          }}
        />
        {!disabled && target && filteredMentions.length > 0 && (
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
