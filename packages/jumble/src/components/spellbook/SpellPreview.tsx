import { useEffect, useRef, useState } from "react";
import { render } from "@commontools/html";

interface SpellPreviewProps {
  ui: any;
  className?: string;
}

export function SpellPreview({ ui, className = "" }: SpellPreviewProps) {
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
    if (!previewRef.current || !isIntersecting || !ui) return;

    const preview = previewRef.current;

    preview.innerHTML = ""; // Clear any existing rendered content
    const cancel = render(preview, ui);
    return cancel;
  }, [ui, isIntersecting]);

  return (
    <div
      ref={previewRef}
      className={`w-full bg-gray-50 rounded h-full pointer-events-none select-none ${className}`}
    />
  );
}
