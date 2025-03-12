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
import { CharmManager } from "../../../charm/src/index.ts";

// Function to parse Slate document and extract mention references
export async function parseMentionsInDocument(
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

    const processNode = async (node: any) => {
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

          // Insert reference number in text with mustache placeholders
          const refIndex = mentionIndices[node.id];
          fullText += `{{${node.id}}}`;
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
              bibliography[node.id] = {
                title: node.character || `Reference ${bibIndex}`,
                body: data,
              };

              mentionIndices[referenceId] = bibIndex;
            }

            const refIndex = mentionIndices[referenceId];
            fullText += `{{${referenceId}}}`;
          } else {
            fullText += `@${node.character}`;
          }
        }
      } else if (node.text !== undefined) {
        fullText += node.text;
      } else if (node.children) {
        for (const child of node.children) {
          await processNode(child);
        }
      }
    };

    // Process each node sequentially with await
    for (const node of document) {
      await processNode(node);
    }

    return {
      text: fullText,
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
