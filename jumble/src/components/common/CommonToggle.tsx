import React from "react";

type ToggleButtonOption = {
  value: string;
  label: string;
};

type ToggleButtonProps = {
  options: ToggleButtonOption[];
  value: string;
  onChange: (value: string) => void;
  size?: "small" | "medium" | "large";
  className?: string;
};

export function ToggleButton({
  options,
  value,
  onChange,
  size = "medium",
  className = "",
}: ToggleButtonProps) {
  const sizeClasses = {
    small: "px-2 py-1 text-xs",
    medium: "px-3 py-1 text-sm",
    large: "px-4 py-2 text-sm",
  };

  const containerClasses = `flex ${className}`;

  return (
    <div className={containerClasses}>
      {options.map((option, index) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={`
            ${sizeClasses[size]}
            flex-1 text-center border-2
            ${index > 0 ? "border-l-0" : ""}
            ${
              value === option.value
                ? "border-black bg-black text-white"
                : "border-gray-300 bg-white hover:border-gray-400"
            }
          `}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

type CheckboxToggleProps = {
  id: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  className?: string;
};

export function CheckboxToggle({
  id,
  label,
  checked,
  onChange,
  className = "",
}: CheckboxToggleProps) {
  return (
    <div className={`flex items-center ${className}`}>
      <input
        type="checkbox"
        id={id}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="border-2 border-black mr-2"
      />
      <label
        htmlFor={id}
        className="text-xs font-medium cursor-pointer"
      >
        {label}
      </label>
    </div>
  );
}

type CommonCheckboxProps = {
  id: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  className?: string;
  size?: "small" | "medium" | "large";
};

export function CommonCheckbox({
  id,
  label,
  checked,
  onChange,
  className = "",
  size = "medium",
}: CommonCheckboxProps) {
  const sizeClasses = {
    small: "px-2 py-1 text-xs",
    medium: "px-3 py-1 text-sm",
    large: "px-4 py-2 text-sm",
  };

  return (
    <div className={`flex items-center border-2 ${checked ? "border-black bg-black text-white" : "border-gray-300 bg-white hover:border-gray-400"} ${sizeClasses[size]} ${className}`}>
      <input
        type="checkbox"
        id={id}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mr-2"
      />
      <label
        htmlFor={id}
        className="font-medium cursor-pointer"
      >
        {label}
      </label>
    </div>
  );
}

type CommonLabelProps = {
  children: React.ReactNode;
  className?: string;
  size?: "small" | "medium" | "large";
};

export function CommonLabel({
  children,
  className = "",
  size = "medium",
}: CommonLabelProps) {
  const sizeClasses = {
    small: "px-2 py-1 text-xs",
    medium: "px-3 py-1 text-sm",
    large: "px-4 py-2 text-sm",
  };

  return (
    <span className={`inline-flex items-center border-2 border-gray-300 bg-white ${sizeClasses[size]} font-medium ${className}`}>
      {children}
    </span>
  );
}
