import React from "react";

type ToggleButtonOption = {
  value: string;
  label: string;
};

type ToggleButtonProps<T extends readonly { value: string; label: string }[]> =
  {
    options: T;
    value: T[number]["value"];
    onChange: (value: T[number]["value"]) => void;
    size?: "small" | "medium" | "large";
    className?: string;
  };

export function ToggleButton<
  T extends readonly { value: string; label: string }[],
>({
  options,
  value,
  onChange,
  size = "medium",
  className = "",
}: ToggleButtonProps<T>) {
  const sizeClasses = {
    small: "px-2 py-1 text-xs",
    medium: "px-3 py-1 text-sm",
    large: "px-4 py-2 text-sm",
  };

  const containerClasses = `flex ${className}`;

  return (
    <div className={containerClasses}>
      {options.map(
        (option: { value: string; label: string }, index: number) => {
          const isSelected = value === option.value;
          const isFirstItem = index === 0;
          const isNextItemSelected = index < options.length - 1 &&
            value === options[index + 1].value;

          return (
            <button
              key={option.value}
              type="button"
              onClick={() => onChange(option.value)}
              className={`
              ${sizeClasses[size as keyof typeof sizeClasses]}
              flex-1 text-center border-2
              ${index > 0 ? "border-l-0" : ""}
              ${
                isSelected
                  ? "border-black bg-black text-white"
                  : `border-gray-300 bg-white hover:border-gray-400 ${
                    isFirstItem && isNextItemSelected ? "border-r-0" : ""
                  }`
              }
            `}
            >
              {option.label}
            </button>
          );
        },
      )}
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
    <div
      className={`flex items-center border-2 ${
        checked
          ? "border-black bg-black text-white"
          : "border-gray-300 bg-white hover:border-gray-400"
      } ${sizeClasses[size as keyof typeof sizeClasses]} ${className}`}
    >
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
    <span
      className={`inline-flex items-center border-2 border-gray-300 bg-white ${
        sizeClasses[size as keyof typeof sizeClasses]
      } font-medium ${className}`}
    >
      {children}
    </span>
  );
}
