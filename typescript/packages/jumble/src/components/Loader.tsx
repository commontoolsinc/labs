import { DitheredCube } from "./DitherCube";
export const LoadingSpinner = ({ visible = true }: { visible?: boolean }) => (
  <div
    style={{
      width: visible ? "100%" : 0,
      height: visible ? "100%" : 0,
      display: visible ? "flex" : "none",
      alignItems: "center",
      justifyContent: "center",
      opacity: visible ? 1 : 0,
      position: visible ? "relative" : "absolute",
    }}
  >
    <DitheredCube />
  </div>
);
