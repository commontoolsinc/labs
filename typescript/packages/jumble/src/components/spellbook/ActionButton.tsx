import { useState } from "react";

interface ActionButtonProps {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  popoverMessage: string;
}

export function ActionButton({ icon, label, onClick, popoverMessage }: ActionButtonProps) {
  const [showPopover, setShowPopover] = useState(false);

  const handleClick = () => {
    onClick();
    setShowPopover(true);
    setTimeout(() => setShowPopover(false), 2000);
  };

  return (
    <div className="relative">
      <button
        onClick={handleClick}
        className="flex items-center gap-2 rounded-lg bg-purple-200 px-4 py-2 text-purple-900 hover:bg-purple-300"
      >
        {icon}
        <span>{label}</span>
      </button>
      {showPopover && (
        <div className="absolute -top-8 left-1/2 -translate-x-1/2 rounded bg-black px-2 py-1 text-sm text-white">
          {popoverMessage}
        </div>
      )}
    </div>
  );
}
