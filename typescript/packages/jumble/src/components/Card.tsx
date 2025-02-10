import { animated } from "@react-spring/web";

interface CardProps {
  details?: boolean;
  children: React.ReactNode;
}
export function Card({ details = false, children }: CardProps) {
  return (
    <animated.div
      className={`
        ${details ? "border border-black shadow-[4px_4px_0px_0px_rgba(0,0,0,0.5)] rounded-[4px] p-4" : ""}
        transition-[border,box-shadow] duration-100 ease-in-out
      `}
    >
      {children}
    </animated.div>
  );
}
