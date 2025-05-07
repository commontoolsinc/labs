import { DitheredCube } from "./DitherCube.tsx";
import { type Property } from "csstype";

export const LoadingSpinner = ({
  visible = true,
  height = 512,
  width = 512,
  cameraZoom = 100,
  blendMode = "normal",
}: {
  visible?: boolean;
  height?: number;
  width?: number;
  cameraZoom?: number;
  blendMode?: Property.MixBlendMode;
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
      mixBlendMode: blendMode,
    }}
  >
    <DitheredCube height={height} width={width} cameraZoom={cameraZoom} />
  </div>
);
