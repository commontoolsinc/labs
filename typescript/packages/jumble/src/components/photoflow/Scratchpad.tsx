import { useState, KeyboardEvent, useEffect, useRef } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { EditorView } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { javascript } from "@codemirror/lang-javascript";
import EmojiPicker, { EmojiClickData } from "emoji-picker-react";
import {
  LuPlay,
  LuPencil,
  LuMenu,
  LuSquare,
  LuWandSparkles,
  LuArrowRight,
  LuCheck,
  LuLoader,
} from "react-icons/lu";
import { HiSparkles } from "react-icons/hi2";
import ReactMarkdown from "react-markdown";

type ScratchpadStatus = "idle" | "thinking" | "casting";
type EditMode = "view" | "edit";

interface ScratchpadState {
  icon: React.ComponentType<{ size: number; strokeWidth?: number }>;
  label: string;
  onClick: (setStatus: (status: ScratchpadStatus) => void) => void;
}

const scratchpadStates: Record<ScratchpadStatus, ScratchpadState> = {
  idle: {
    icon: LuPlay,
    label: "Ready",
    onClick: (setStatus) => setStatus("thinking"),
  },
  thinking: {
    icon: LuSquare,
    label: "Thinking...",
    onClick: (setStatus) => setStatus("idle"),
  },
  casting: {
    icon: LuWandSparkles,
    label: "Casting...",
    onClick: (setStatus) => setStatus("idle"),
  },
};

interface ScratchpadProps {
  isOpen: boolean;
  onClose: () => void;
  photosetName: string;
  onViewChange?: (view: ViewType) => void;
  onUnlockTimelineView?: () => void;
}

interface CodePreview {
  code: string;
  language: string;
}

export default function Scratchpad({
  isOpen,
  onClose,
  photosetName,
  onViewChange,
  onUnlockTimelineView,
}: ScratchpadProps) {
  const [status, setStatus] = useState<ScratchpadStatus>("idle");
  const [message, setMessage] = useState("");
  const [content, setContent] = useState(
    "A simple list view of a Set of images.\n\n- images are displayed in a grid view by default\n- toggle to show a table view ",
  );
  const [title, setTitle] = useState(`${photosetName}`);
  const [emoji, setEmoji] = useState("✨");
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [editMode, setEditMode] = useState<EditMode>("view");
  const [codePreview, setCodePreview] = useState<CodePreview | null>(null);
  const [showCodeEditor, setShowCodeEditor] = useState(false);
  const [isEditingCode, setIsEditingCode] = useState(false);
  const [editedCode, setEditedCode] = useState<string>("");

  const currentState = scratchpadStates[status];

  // Add ref for the input
  const inputRef = useRef<HTMLInputElement>(null);

  // Add effect to focus input when sidebar opens
  useEffect(() => {
    if (isOpen) {
      // Small delay to ensure DOM is ready
      setTimeout(() => {
        inputRef.current?.focus();
      }, 100);
    }
  }, [isOpen]);

  useEffect(() => {
    if (status === "thinking") {
      const timer = setTimeout(() => {
        setStatus("idle");
        const lines = content.split("\n");
        const lastLine = lines[lines.length - 1];
        if (lastLine.toLowerCase().includes("timeline")) {
          setCodePreview({
            language: "tsx",
            code: `export function TimelineView({ images }) {
  return (
    <div className="space-y-8">
      {images.map((image) => (
        <div key={image.id} className="flex gap-4">
          <div className="w-20 text-sm text-gray-500">
            {new Date(image.createdAt)
              .toLocaleDateString()}
          </div>
          <div className="flex-1">
            <div className="w-48 h-48 rounded-lg overflow-hidden">
              <img 
                src={image.dataUrl}
                alt=""
                className="w-full h-full object-cover"
              />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}`,
          });
        }
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [status, content]);

  const handleSubmit = () => {
    if (!message.trim()) return;
    console.log("Submitting message:", message);
    setContent(content + "\n" + "- " + message);
    setMessage("");
    setStatus("thinking");
  };

  const handleSaveEdit = () => {
    setEditMode("view");
    setStatus("thinking");
  };

  const handleCodePreviewClick = () => {
    if (onViewChange) {
      onViewChange("timeline");
      onUnlockTimelineView?.();
      onClose();
    }
  };

  const handleCodeEdit = () => {
    setIsEditingCode(true);
    setEditedCode(codePreview?.code || "");
  };

  const handleCodeSave = () => {
    if (codePreview) {
      setCodePreview({
        ...codePreview,
        code: editedCode,
      });
    }
    setIsEditingCode(false);
  };

  return (
    <div
      className={`fixed inset-y-0 right-0 w-96 bg-[#f5f5f5] shadow-xl transform transition-transform duration-300 flex flex-col z-50 ${
        isOpen ? "translate-x-0" : "translate-x-full"
      }`}
    >
      {/* Status Bar */}
      <div className="h-12 bg-[#d9d9d9] flex items-center px-4 justify-between rounded-lg m-2">
        <div className="flex items-center gap-4">
          <button
            className={`text-black ${status === "thinking" ? "status-thinking" : ""}`}
            onClick={() => currentState.onClick(setStatus)}
          >
            <currentState.icon size={18} strokeWidth={1.5} />
          </button>
          <span
            className={`text-black font-medium italic ${status === "thinking" ? "status-thinking" : ""}`}
          >
            {currentState.label}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={onClose} className="text-black ml-2 hover:text-gray-700">
            <LuMenu size={24} />
          </button>
        </div>
      </div>

      {/* Header */}
      <div className="bg-white flex items-center px-6 py-4 m-2 rounded-lg">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowEmojiPicker(!showEmojiPicker)}
            className="text-2xl hover:bg-gray-100 p-1 rounded"
          >
            {emoji}
          </button>
          {showEmojiPicker && (
            <div className="absolute top-16 left-4 z-50">
              <EmojiPicker
                onEmojiClick={(data) => {
                  setEmoji(data.emoji);
                  setShowEmojiPicker(false);
                }}
              />
            </div>
          )}
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="text-xl font-bold bg-transparent border-none focus:outline-none focus:ring-0 w-full"
          />
        </div>
      </div>

      {/* Content Area */}
      <div className="flex-1 overflow-auto m-2 rounded-lg bg-white p-4 relative">
        {editMode === "view" ? (
          <>
            <button
              onClick={() => setEditMode("edit")}
              className="absolute top-2 right-2 text-gray-400 hover:text-gray-600"
            >
              <LuPencil size={16} />
            </button>
            <div className="prose prose-sm max-w-none">
              <ReactMarkdown>{content}</ReactMarkdown>
            </div>

            {/* Thinking Indicator */}
            {status === "thinking" && (
              <div className="mt-6 flex flex-col items-center gap-3 text-gray-500">
                <LuLoader className="w-6 h-6 animate-spin" />
                <div className="text-sm status-thinking">Thinking...</div>
              </div>
            )}

            {/* Code Preview */}
            {codePreview && !showCodeEditor && (
              <div className="mt-4 w-full rounded-lg border border-gray-200 p-3 cursor-pointer hover:border-blue-500 transition-colors overflow-hidden bg-[#282c34]">
                <div className="text-xs text-gray-500 mb-2 flex justify-between items-center">
                  <span>TimelineSpell.tsx</span>
                  {!isEditingCode && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleCodeEdit();
                      }}
                      className="text-gray-400 hover:text-gray-200"
                    >
                      <LuPencil size={16} />
                    </button>
                  )}
                  {isEditingCode && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleCodeSave();
                      }}
                      className="text-gray-400 hover:text-gray-200"
                    >
                      <LuCheck size={16} />
                    </button>
                  )}
                </div>
                <div onClick={!isEditingCode ? handleCodePreviewClick : undefined}>
                  <CodeMirror
                    value={isEditingCode ? editedCode : codePreview.code}
                    height="192px"
                    theme="dark"
                    extensions={[javascript()]}
                    editable={isEditingCode}
                    onChange={(value) => isEditingCode && setEditedCode(value)}
                    basicSetup={{
                      lineNumbers: false,
                      foldGutter: false,
                      indentOnInput: true,
                    }}
                  />
                </div>
              </div>
            )}

            {/* Expanded Code Editor */}
            {showCodeEditor && (
              <div className="mt-4">
                <CodeMirror
                  value={codePreview?.code || ""}
                  height="400px"
                  theme="light"
                  extensions={[markdown(), EditorView.lineWrapping]}
                  editable={false}
                  basicSetup={{
                    lineNumbers: true,
                    foldGutter: false,
                    indentOnInput: true,
                  }}
                />
              </div>
            )}
          </>
        ) : (
          <div className="h-full flex flex-col">
            <CodeMirror
              value={content}
              height="100%"
              theme="light"
              extensions={[markdown(), EditorView.lineWrapping]}
              onChange={(value) => setContent(value)}
              basicSetup={{
                lineNumbers: false,
                foldGutter: false,
                indentOnInput: true,
              }}
            />
            <button
              onClick={handleSaveEdit}
              className="absolute top-2 right-2 text-gray-400 hover:text-gray-600"
            >
              <LuCheck size={16} />
            </button>
          </div>
        )}
      </div>

      {/* Chat Input */}
      <div className="p-2">
        <div
          className={`flex items-center gap-2 bg-white rounded-lg shadow-sm border border-gray-200 px-3 py-2 ${
            status === "thinking" ? "opacity-50" : ""
          }`}
        >
          {status === "thinking" ? (
            <LuLoader className="w-5 h-5 text-blue-500 animate-spin" />
          ) : (
            <HiSparkles className="text-gray-400 w-5 h-5" />
          )}
          <input
            ref={inputRef}
            type="text"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyPress={(e) => e.key === "Enter" && handleSubmit()}
            placeholder={status === "thinking" ? "Thinking..." : "Imagine..."}
            disabled={status === "thinking"}
            className="flex-1 outline-none border-none bg-transparent text-gray-800 placeholder-gray-400 disabled:cursor-not-allowed"
          />
          <button
            onClick={handleSubmit}
            disabled={!message.trim() || status === "thinking"}
            className="text-gray-400 hover:text-gray-600 disabled:opacity-50"
          >
            <LuArrowRight className="w-5 h-5" />
          </button>
        </div>
      </div>
    </div>
  );
}
