
// Tag management component
interface TagManagerProps {
  autoTags: string[];
  userTags: string[];
  onTagsChange: (tags: string[]) => void;
}

export function TagManager({ autoTags, userTags, onTagsChange }: TagManagerProps) {
  const handleTagInput = (input: string) => {
    const newTags = input.split(',').map(tag =>
      tag.trim().startsWith('#') ? tag.trim() : `#${tag.trim()}`
    );
    onTagsChange(newTags);
  };

  return (
    <div className="tag-manager">
      <div className="auto-tags">
        Auto Tags: {autoTags.map(tag => <span key={tag}>#{tag} </span>)}
      </div>
      <input
        type="text"
        placeholder="Add tags (comma-separated)"
        onChange={(e) => handleTagInput(e.target.value)}
      />
    </div>
  );
}
