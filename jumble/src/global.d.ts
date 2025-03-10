// Allow any modules to be imported even if they don't have type definitions
declare module "*" {
  const content: any;
  export default content;
}

// Define specific types for react-router-dom components
declare module "react-router-dom" {
  export interface OutletProps {
    context?: unknown;
  }

  export interface NavLinkProps {
    to: string;
    className?: string | ((props: { isActive: boolean }) => string);
    key?: string | number;
    children?: React.ReactNode;
    [x: string]: any;
  }

  export interface RouteProps {
    path?: string;
    element: React.ReactNode;
    children?: React.ReactNode;
    index?: boolean;
    [x: string]: any;
  }

  // Define parameters by route
  export interface CharmRouteParams {
    charmId: string;
    replicaName?: string;
  }

  export interface StackedCharmsRouteParams {
    charmIds: string;
  }

  export const Outlet: React.FC<OutletProps>;
  export const Link: React.FC<NavLinkProps>;
  export const NavLink: React.FC<NavLinkProps>;
  export const Route: React.FC<RouteProps>;
  export const Routes: React.FC<{ children: React.ReactNode }>;
  export const BrowserRouter: React.FC<{ children: React.ReactNode }>;
  export const Navigate: React.FC<{ to: string, replace?: boolean }>;
  export type NavigateFunction = (path: string, options?: { replace?: boolean }) => void;
  export function useNavigate(): NavigateFunction;
  export function useParams<T = unknown>(): T;
  export function useLocation(): {
    pathname: string;
    search: string;
    hash: string;
    state: any;
  };
  export function generatePath(path: string, params?: Record<string, string>): string;
  export function matchPath(pattern: string, pathname: string): boolean;
}

// Define JsonView component
declare module "@uiw/react-json-view" {
  interface JsonViewProps {
    value: any;
    style?: React.CSSProperties;
    [key: string]: any;
  }
  const JsonView: React.FC<JsonViewProps>;
  export default JsonView;
}

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

// Update react-dom to include createRoot
declare module "react-dom" {
  export function createRoot(container: Element | Document | DocumentFragment): {
    render(element: React.ReactNode): void;
    unmount(): void;
  };
}
