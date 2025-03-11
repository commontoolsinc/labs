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
          ? "border border-black shadow-[4px_4px_0px_0px_rgba(0,0,0,0.5)] rounded-[4px] hover:translate-y-[-2px] hover:shadow-[4px_4px_0px_0px_rgba(0,0,0,0.7)] transition-all"
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
