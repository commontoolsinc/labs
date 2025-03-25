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
          flex items-center gap-2 px-4 py-2 bg-white dark:bg-dark-bg-secondary
          border-2 border-black dark:border-gray-600 dark:text-white
          shadow-[2px_2px_0px_0px_rgba(0,0,0,0.5)] dark:shadow-[2px_2px_0px_0px_rgba(80,80,80,0.5)]
          hover:translate-y-[-2px] hover:shadow-[2px_4px_0px_0px_rgba(0,0,0,0.7)] dark:hover:shadow-[2px_4px_0px_0px_rgba(100,100,100,0.6)]
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
          bg-black dark:bg-dark-bg-tertiary text-white px-2 py-1 text-sm
          border border-white dark:border-gray-600
        ">
          {popoverMessage}
        </div>
      )}
    </div>
  );
}
