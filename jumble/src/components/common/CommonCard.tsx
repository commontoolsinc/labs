type CardProps = {
  details?: boolean;
  children: React.ReactNode;
  className?: string;
};
export function CommonCard(
  { details = false, children, className }: CardProps,
) {
  return (
    <div
      className={`
      ${
        details
          ? "border rounded-[4px] transition-all hover:translate-y-[-2px] border-black dark:border-gray-600 shadow-[4px_4px_0px_0px_rgba(0,0,0,0.5)] dark:shadow-[4px_4px_0px_0px_rgba(80,80,80,0.5)] hover:shadow-[4px_4px_0px_0px_rgba(0,0,0,0.7)] dark:hover:shadow-[4px_4px_0px_0px_rgba(100,100,100,0.6)] dark:bg-dark-bg-secondary"
          : ""
      }
      transition-[border,box-shadow,transform] duration-100 ease-in-out
      ${className || ""}
    `}
    >
      {children}
    </div>
  );
}
