import { useEffect, useRef, useState } from "react";
import { render } from "@commontools/html";
import { UI } from "@commontools/builder";

interface SpellPreviewProps {
  data: any;
  className?: string;
}

export function SpellPreview({ data, className = "" }: SpellPreviewProps) {
  const previewRef = useRef<HTMLDivElement | null>(null);
  const [isIntersecting, setIsIntersecting] = useState(false);

  useEffect(() => {
    if (!previewRef.current) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        setIsIntersecting(entry.isIntersecting);
      },
      { threshold: 0 },
    );

    observer.observe(previewRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!previewRef.current || !isIntersecting || !data) return;

    console.log("data", data);
    const preview = previewRef.current;
    const spellData = data.recipe.result[UI];
    if (!spellData) return;

    preview.innerHTML = ""; // Clear any existing rendered content
    const cancel = render(preview, spellData);
    return cancel;
  }, [data, isIntersecting]);

  return (
    <div ref={previewRef} className={`w-full bg-gray-50 rounded min-h-[192px] ${className}`} />
  );
}
