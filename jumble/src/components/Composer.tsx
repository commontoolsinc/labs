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

// Define our custom types
interface MentionElement extends BaseElement {
  type: "mention";
  character: string;
  children: { text: string; bold?: boolean; italic?: boolean }[];
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
    () => withMentions(withReact(withHistory(createEditor()))) as CustomEditor,
    [],
  );

  // Filter mentions based on search query
  const filteredMentions = useMemo(() =>
    mentions
      .filter((mention) =>
        mention.name.toLowerCase().includes(search.toLowerCase())
      )
      .slice(0, 10), [mentions, search]);

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
          case "Enter":
            event.preventDefault();
            Transforms.select(editor, target);
            insertMention(editor, filteredMentions[index].name);
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
          readOnly={readOnly}
          renderElement={renderElement}
          renderLeaf={renderLeaf}
          onKeyDown={handleKeyDown}
          placeholder={placeholder || "Enter some text..."}
          style={style}
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
              {filteredMentions.map((mention, i: number) => (
                <div
                  key={mention.id}
                  onClick={(e: ReactMouseEvent) => {
                    e.preventDefault();
                    e.stopPropagation();
                    Transforms.select(editor, target);
                    insertMention(editor, mention.name);
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

const insertMention = (editor: CustomEditor, character: string) => {
  const mention: MentionElement = {
    type: "mention",
    character,
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
    default:
      return <p {...attributes}>{children}</p>;
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
      style={{
        padding: "3px 3px 2px",
        margin: "0 1px",
        verticalAlign: "baseline",
        display: "inline-block",
        borderRadius: "4px",
        backgroundColor: "#eee",
        fontSize: "0.9em",
        boxShadow: selected && focused ? "0 0 0 2px #B4D5FF" : "none",
      }}
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
