/**
 * CT Map Component Export and Registration
 */

import { CTMap } from "./ct-map.ts";
import type {
  Bounds,
  CtBoundsChangeDetail,
  CtCircleClickDetail,
  CtClickDetail,
  CtMarkerClickDetail,
  CtMarkerDragEndDetail,
  LatLng,
  MapCircle,
  MapMarker,
  MapPolyline,
  MapValue,
} from "./types.ts";

if (!customElements.get("ct-map")) {
  customElements.define("ct-map", CTMap);
}

export { CTMap };
export type {
  Bounds,
  CtBoundsChangeDetail,
  CtCircleClickDetail,
  CtClickDetail,
  CtMarkerClickDetail,
  CtMarkerDragEndDetail,
  LatLng,
  MapCircle,
  MapMarker,
  MapPolyline,
  MapValue,
};
