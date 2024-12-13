import { ClipFormat } from "../model.js";

// Action bar component
interface ActionBarProps {
  selectedFormat: ClipFormat;
  onFormatChange: (format: ClipFormat) => void;
  onClip: () => void;
}

export function ActionBar({ selectedFormat, onFormatChange, onClip }: ActionBarProps) {
  return (
    <div className="action-bar">
      <select
        value={selectedFormat}
        onChange={(e) => onFormatChange(e.target.value as ClipFormat)}
      >
        <option value="link">Link</option>
        <option value="article">Article</option>
        <option value="social-post">Social Post</option>
        <option value="media">Media</option>
        <option value="code-repo">Code Repository</option>
        <option value="person">Person Profile</option>
      </select>
      <button onClick={onClip}>Clip Content</button>
    </div>
  );
}
