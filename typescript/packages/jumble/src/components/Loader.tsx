import { DitheredCube } from "./DitherCube";
export const LoadingSpinner = ({
  visible = true,
  height = 512,
  width = 512,
  cameraZoom = 100,
}: {
  visible?: boolean;
  height?: number;
  width?: number;
  cameraZoom?: number;
}) => (
  <div
    style={{
      width: visible ? width : 0,
      height: visible ? height : 0,
      display: visible ? "flex" : "none",
      alignItems: "center",
      justifyContent: "center",
      opacity: visible ? 1 : 0,
      position: visible ? "relative" : "absolute",
    }}
  >
    <DitheredCube height={height} width={width} cameraZoom={cameraZoom} />
  </div>
);
