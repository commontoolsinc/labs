import { useEffect, useState } from "react";

interface ShareDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (
    data: { title: string; description: string; tags: string[] },
  ) => void;
  defaultTitle?: string;
  isPublishing?: boolean;
}

export function ShareDialog({
  isOpen,
  onClose,
  onSubmit,
  defaultTitle = "",
  isPublishing = false,
}: ShareDialogProps) {
  const [title, setTitle] = useState(defaultTitle);
  const [description, setDescription] = useState("");
  const [tagInput, setTagInput] = useState("");
  const [tags, setTags] = useState<string[]>([]);

  useEffect(() => {
    setTitle(defaultTitle);
  }, [defaultTitle]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return;

      if (e.key === "Escape") {
        onClose();
      } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        if (!isPublishing) {
          if (tagInput.trim()) {
            addTag(tagInput);
          }
          onSubmit({ title, description, tags });
        }
      }
    };

    globalThis.addEventListener("keydown", handleKeyDown);
    return () => globalThis.removeEventListener("keydown", handleKeyDown);
  }, [
    isOpen,
    onClose,
    onSubmit,
    tagInput,
    title,
    description,
    tags,
    isPublishing,
  ]);

  if (!isOpen) return null;

  const addTag = (tag: string) => {
    const cleanTag = tag.trim().toLowerCase();
    // If tag starts with #, keep it, otherwise add it
    const tagWithHash = cleanTag.startsWith("#") ? cleanTag : `#${cleanTag}`;
    // Remove any invalid characters after the #
    const finalTag = tagWithHash.replace(/#([^a-z0-9-]*)/, "#").replace(
      /[^#a-z0-9-]/g,
      "",
    );

    if (finalTag.length > 1 && !tags.includes(finalTag)) {
      setTags([...tags, finalTag]);
    }
  };

  const handleTagInput = (input: string) => {
    // Split on commas or spaces and handle each tag
    if (input.includes(",") || input.includes(" ")) {
      const newTags = input.split(/[,\s]+/);
      newTags.forEach((tag) => addTag(tag));
      setTagInput("");
      return;
    }
    setTagInput(input);
  };

  const handleTagKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (tagInput) {
        addTag(tagInput);
        setTagInput("");
      }
    } else if (e.key === "Backspace" && !tagInput && tags.length > 0) {
      e.preventDefault();
      setTags(tags.slice(0, -1));
    }
  };

  const handleTagPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const pastedText = e.clipboardData.getData("text");
    const pastedTags = pastedText.split(/[,\s\n]+/);
    pastedTags.forEach((tag) => addTag(tag));
  };

  const removeTag = (tagToRemove: string) => {
    setTags(tags.filter((tag) => tag !== tagToRemove));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // Add any remaining tag input before submitting
    if (tagInput.trim()) {
      addTag(tagInput);
    }
    onSubmit({ title, description, tags });
  };

  return (
    <div className="fixed inset-0 bg-[#00000080] flex items-center justify-center z-50">
      <div className="bg-white dark:bg-dark-bg-secondary border-2 border-black dark:border-gray-600 shadow-[2px_2px_0px_0px_rgba(0,0,0,0.5)] dark:shadow-[2px_2px_0px_0px_rgba(80,80,80,0.5)] p-6 max-w-lg w-full mx-4">
        <h2 className="text-2xl font-bold mb-4 dark:text-white">Share Spell</h2>
        <form onSubmit={handleSubmit}>
          <div className="mb-4">
            <label className="block text-sm font-medium mb-1 dark:text-dark-text-primary">
              Title
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full px-3 py-2 border-2 border-black dark:border-gray-600 dark:bg-dark-bg-tertiary dark:text-white"
              required
              disabled={isPublishing}
            />
          </div>

          <div className="mb-4">
            <label className="block text-sm font-medium mb-1 dark:text-dark-text-primary">
              Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full px-3 py-2 border-2 border-black dark:border-gray-600 dark:bg-dark-bg-tertiary dark:text-white"
              rows={3}
              disabled={isPublishing}
            />
          </div>

          <div className="mb-6">
            <label className="block text-sm font-medium mb-1 dark:text-dark-text-primary">
              Tags
            </label>
            <div className="border-2 border-black dark:border-gray-600 p-2 dark:bg-dark-bg-tertiary">
              <div className="flex flex-wrap gap-2 mb-2">
                {tags.map((tag) => (
                  <span
                    key={tag}
                    className="bg-gray-100 dark:bg-dark-bg-secondary px-2 py-1 text-sm border border-black dark:border-gray-600 flex items-center gap-1 dark:text-white"
                  >
                    {tag}
                    <button
                      type="button"
                      onClick={() => removeTag(tag)}
                      className="ml-1 text-black dark:text-white hover:text-gray-700 dark:hover:text-gray-300"
                      disabled={isPublishing}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
              <input
                type="text"
                value={tagInput}
                onChange={(e) => handleTagInput(e.target.value)}
                onKeyDown={handleTagKeyDown}
                onPaste={handleTagPaste}
                placeholder="Add tags (press Enter, space, or comma)"
                className="w-full px-2 py-1 border border-gray-300 dark:border-gray-600 focus:outline-none dark:bg-dark-bg-secondary dark:text-white dark:placeholder-gray-400"
                disabled={isPublishing}
              />
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 border-2 border-black dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-dark-bg-tertiary dark:text-white disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={isPublishing}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 bg-black dark:bg-gray-700 text-white border-2 border-black dark:border-gray-600 hover:bg-gray-800 dark:hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              disabled={isPublishing}
            >
              {isPublishing
                ? (
                  "Publishing..."
                )
                : (
                  <span>
                    Publish <span className="text-xs">cmd+enter</span>
                  </span>
                )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
