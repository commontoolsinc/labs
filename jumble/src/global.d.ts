/// <reference types="vite/client" />

// Define CodeMirror component
declare module "@uiw/react-codemirror" {
  interface CodeMirrorProps {
    value: string;
    theme?: string;
    extensions?: any[];
    editable?: boolean;
    [key: string]: any;
  }
  const CodeMirror: React.FC<CodeMirrorProps>;
  export default CodeMirror;
}

// Define react-icons components
declare module "react-icons/lu" {
  import { ComponentType, SVGAttributes } from "react";
  export interface IconProps extends SVGAttributes<SVGElement> {
    size?: string | number;
    title?: string;
    color?: string;
  }
  export type IconType = ComponentType<IconProps>;

  export const LuArrowLeft: React.FC<IconProps>;
  export const LuBookOpen: React.FC<IconProps>;
  export const LuCheck: React.FC<IconProps>;
  export const LuChevronDown: React.FC<IconProps>;
  export const LuChevronRight: React.FC<IconProps>;
  export const LuCirclePlus: React.FC<IconProps>;
  export const LuCopy: React.FC<IconProps>;
  export const LuHeart: React.FC<IconProps>;
  export const LuKey: React.FC<IconProps>;
  export const LuKeyRound: React.FC<IconProps>;
  export const LuLock: React.FC<IconProps>;
  export const LuMessageSquare: React.FC<IconProps>;
  export const LuSend: React.FC<IconProps>;
  export const LuShare2: React.FC<IconProps>;
  export const LuTextCursorInput: React.FC<IconProps>;
  export const LuTrash2: React.FC<IconProps>;
  export const LuX: React.FC<IconProps>;
}

// Define react-icons/md module
declare module "react-icons/md" {
  import { ComponentType, SVGAttributes } from "react";
  export interface IconProps extends SVGAttributes<SVGElement> {
    size?: string | number;
    title?: string;
    color?: string;
  }
  export type IconType = ComponentType<IconProps>;

  export const MdEdit: React.FC<IconProps>;
  export const MdOutlineStar: React.FC<IconProps>;
  export const MdOutlineStarBorder: React.FC<IconProps>;
  export const MdShare: React.FC<IconProps>;
  export const MdSend: React.FC<IconProps>;
  export const MdThumbDownOffAlt: React.FC<IconProps>;
  export const MdThumbUpOffAlt: React.FC<IconProps>;
}
