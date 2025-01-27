import { useState, KeyboardEvent } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { EditorView } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import EmojiPicker, { EmojiClickData } from "emoji-picker-react";
import { LuPlay, LuCode, LuMenu, LuSquare, LuWandSparkles, LuArrowRight } from "react-icons/lu";
import { HiSparkles } from "react-icons/hi2";

type ScratchpadStatus = "idle" | "thinking" | "casting";

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
}

export default function Scratchpad({ isOpen, onClose, photosetName }: ScratchpadProps) {
  const [status, setStatus] = useState<ScratchpadStatus>("idle");
  const [message, setMessage] = useState("");
  const [content, setContent] = useState("- ");
  const [title, setTitle] = useState(`${photosetName} Spell`);
  const [emoji, setEmoji] = useState("✨");
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);

  const currentState = scratchpadStates[status];

  const onEmojiClick = (emojiData: EmojiClickData) => {
    setEmoji(emojiData.emoji);
    setShowEmojiPicker(false);
  };

  const handleSubmit = () => {
    if (!message.trim()) return;
    setStatus("thinking");
    // Additional logic here
  };

  const handleKeyPress = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      handleSubmit();
    }
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
              <EmojiPicker onEmojiClick={onEmojiClick} />
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

      {/* Editor Area */}
      <div className="flex-1 overflow-hidden m-2 rounded-lg">
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
          className="h-full [&_.cm-editor]:bg-[#f5f5f5]"
        />
      </div>

      {/* Chat Input */}
      <div className="p-4">
        <div className="flex items-center gap-2 bg-white rounded-lg shadow-sm border border-gray-200 px-3 py-2">
          <HiSparkles className="text-gray-400 w-5 h-5" />
          <input
            type="text"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder="Imagine..."
            className="flex-1 outline-none border-none bg-transparent text-gray-800 placeholder-gray-400"
          />
          <button
            onClick={handleSubmit}
            disabled={!message.trim()}
            className="text-gray-400 hover:text-gray-600 disabled:opacity-50"
          >
            <LuArrowRight className="w-5 h-5" />
          </button>
        </div>
      </div>
    </div>
  );
}
