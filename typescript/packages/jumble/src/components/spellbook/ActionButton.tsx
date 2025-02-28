import { useState } from "react";

interface ActionButtonProps {
  icon: React.ReactNode;
  label: React.ReactNode;
  onClick: () => void;
  popoverMessage: string;
  className?: string;
}

export function ActionButton({
  icon,
  label,
  onClick,
  popoverMessage,
  className,
}: ActionButtonProps) {
  const [showPopover, setShowPopover] = useState(false);

  const handleClick = () => {
    onClick();
    setShowPopover(true);
    setTimeout(() => setShowPopover(false), 2000);
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={handleClick}
        className={`
          flex items-center gap-2 px-4 py-2 bg-white
          border-2 border-black
          shadow-[2px_2px_0px_0px_rgba(0,0,0,0.5)]
          hover:translate-y-[-2px] hover:shadow-[2px_4px_0px_0px_rgba(0,0,0,0.7)]
          transition-[transform,shadow] duration-100 ease-in-out cursor-pointer
          ${className}
        `}
      >
        {icon}
        <span>{label}</span>
      </button>
      {showPopover && (
        <div className="
          absolute -top-8 left-1/2 -translate-x-1/2 
          bg-black text-white px-2 py-1 text-sm
          border border-white
        ">
          {popoverMessage}
        </div>
      )}
    </div>
  );
}
