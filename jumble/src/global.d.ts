/// <reference types="vite/client" />

// Allow any modules to be imported even if they don't have type definitions
declare module "*" {
  const content: any;
  export default content;
}

// // Define specific types for react-router-dom components
// declare module "react-router-dom" {
//   export interface OutletProps {
//     context?: unknown;
//   }

//   export interface NavLinkProps {
//     to: string;
//     className?: string | ((props: { isActive: boolean }) => string);
//     key?: string | number;
//     children?: React.ReactNode;
//     [x: string]: any;
//   }

//   export interface RouteProps {
//     path?: string;
//     element: React.ReactNode;
//     children?: React.ReactNode;
//     index?: boolean;
//     [x: string]: any;
//   }

//   // Define parameters by route
//   export interface CharmRouteParams {
//     charmId: string;
//     replicaName?: string;
//   }

//   export interface StackedCharmsRouteParams {
//     charmIds: string;
//   }

//   export const Outlet: React.FC<OutletProps>;
//   export const Link: React.FC<NavLinkProps>;
//   export const NavLink: React.FC<NavLinkProps>;
//   export const Route: React.FC<RouteProps>;
//   export const Routes: React.FC<{ children: React.ReactNode }>;
//   export const BrowserRouter: React.FC<{ children: React.ReactNode }>;
//   export const Navigate: React.FC<{ to: string; replace?: boolean }>;
//   export type NavigateFunction = (
//     path: string,
//     options?: { replace?: boolean },
//   ) => void;
//   export function useNavigate(): NavigateFunction;
//   export function useParams<T = unknown>(): T;
//   export function useLocation(): {
//     pathname: string;
//     search: string;
//     hash: string;
//     state: any;
//   };
//   export function generatePath(
//     path: string,
//     params?: Record<string, string>,
//   ): string;
//   export function matchPath(pattern: string, pathname: string): boolean;
//   export function useMatch(pattern: string): {
//     params: Record<string, string>;
//     pathname: string;
//     pattern: string;
//     isExact: boolean;
//   } | null;
// }

// // Define JsonView component
// declare module "@uiw/react-json-view" {
//   interface JsonViewProps {
//     value: any;
//     style?: React.CSSProperties;
//     [key: string]: any;
//   }
//   const JsonView: React.FC<JsonViewProps>;
//   export default JsonView;
// }

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
}

// // Update react-dom to include createRoot
// declare module "react-dom" {
//   export function createRoot(
//     container: Element | Document | DocumentFragment,
//   ): {
//     render(element: React.ReactNode): void;
//     unmount(): void;
//   };
// }

// // Add type declarations for @react-three components
// declare module "@react-three/fiber" {
//   import * as React from "react";

//   export interface CanvasProps {
//     children?: React.ReactNode;
//     gl?: {
//       antialias?: boolean;
//       alpha?: boolean;
//       [key: string]: any;
//     };
//     [key: string]: any;
//   }

//   export const Canvas: React.FC<CanvasProps>;
//   export function extend(objects: Record<string, any>): void;
//   export function useFrame(callback: (state: any) => void): void;
// }

// declare module "@react-three/drei" {
//   import * as React from "react";

//   export interface OrthographicCameraProps {
//     makeDefault?: boolean;
//     position?: [number, number, number];
//     zoom?: number;
//     near?: number;
//     far?: number;
//     [key: string]: any;
//   }

//   export interface OrbitControlsProps {
//     enableZoom?: boolean;
//     [key: string]: any;
//   }

//   export interface EffectsProps {
//     children?: React.ReactNode;
//     [key: string]: any;
//   }

//   export const OrthographicCamera: React.FC<OrthographicCameraProps>;
//   export const OrbitControls: React.FC<OrbitControlsProps>;
//   export const Effects: React.FC<EffectsProps>;
// }

// // Add type declarations for cmdk package
// declare module "cmdk" {
//   import * as React from "react";

//   export interface CommandProps {
//     children: React.ReactNode;
//     label?: string;
//     filter?: (value: string, search: string) => number;
//     loop?: boolean;
//     value?: string;
//     onValueChange?: (value: string) => void;
//     shouldFilter?: boolean;
//     className?: string;
//   }

//   export interface CommandInputProps {
//     value?: string;
//     onValueChange?: (value: string) => void;
//     placeholder?: string;
//     className?: string;
//     readOnly?: boolean;
//     onKeyDown?: (e: React.KeyboardEvent) => void;
//     style?: React.CSSProperties;
//   }

//   export interface CommandItemProps {
//     value?: string;
//     disabled?: boolean;
//     onSelect?: (value: string) => void;
//     className?: string;
//     key?: React.Key;
//     children?: React.ReactNode;
//   }

//   export interface CommandGroupProps {
//     heading?: React.ReactNode;
//     className?: string;
//     value?: string;
//     forceMount?: boolean;
//     children?: React.ReactNode;
//   }

//   export interface CommandListProps {
//     children?: React.ReactNode;
//     className?: string;
//   }

//   export interface CommandEmptyProps {
//     children?: React.ReactNode;
//     className?: string;
//   }

//   export interface CommandLoadingProps {
//     children?: React.ReactNode;
//     className?: string;
//   }

//   export interface CommandSeparatorProps {
//     className?: string;
//     alwaysRender?: boolean;
//   }

//   export interface CommandDialogProps {
//     open?: boolean;
//     onOpenChange?: (open: boolean) => void;
//     container?: HTMLElement | null;
//     className?: string;
//     children?: React.ReactNode;
//     title?: string;
//     label?: string;
//   }

//   export const Command: React.FC<CommandProps> & {
//     Input: React.FC<CommandInputProps>;
//     List: React.FC<CommandListProps>;
//     Empty: React.FC<CommandEmptyProps>;
//     Group: React.FC<CommandGroupProps>;
//     Item: React.FC<CommandItemProps>;
//     Separator: React.FC<CommandSeparatorProps>;
//     Dialog: React.FC<CommandDialogProps>;
//     Loading: React.FC<CommandLoadingProps>;
//   };
// }
