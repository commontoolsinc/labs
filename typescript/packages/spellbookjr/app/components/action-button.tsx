"use client";

import { ReactNode, useState } from "react";

interface ActionButtonProps {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  popoverMessage?: string;
}

export default function ActionButton({
  icon,
  label,
  onClick,
  popoverMessage,
}: ActionButtonProps) {
  const [showMessage, setShowMessage] = useState(false);

  const handleClick = () => {
    onClick();
    if (popoverMessage) {
      setShowMessage(true);
      setTimeout(() => setShowMessage(false), 2000);
    }
  };

  return (
    <div className="relative w-full">
      <button
        onClick={handleClick}
        className="w-full flex items-center justify-center gap-2 text-purple-600 hover:bg-purple-200 hover:text-purple-800 hover:-translate-y-0.5 hover:scale-105 active:translate-y-0 active:scale-95 p-4 rounded-2xl transition-all duration-150 ease-out"
      >
        {icon}
        <span>{label}</span>
      </button>

      {showMessage && (
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-4 py-2 bg-purple-500 text-white text-sm rounded-lg whitespace-nowrap animate-fade-in-down">
          {popoverMessage}
        </div>
      )}
    </div>
  );
}
