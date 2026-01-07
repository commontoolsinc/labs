/**
 * ct-map - Interactive map component using Leaflet
 *
 * Displays markers, circles, and polylines with bidirectional Cell reactivity.
 * Uses OpenStreetMap tiles (no API key required).
 */

import { html, PropertyValues } from "lit";
import { BaseElement } from "../../core/base-element.ts";
import { styles } from "./styles.ts";
import * as L from "leaflet";
import { type Cell, isCell } from "@commontools/runner";
import { CellController } from "../../core/cell-controller.ts";
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
import "../ct-render/ct-render.ts";

// Default map configuration
const DEFAULT_CENTER: LatLng = { lat: 37.7749, lng: -122.4194 }; // San Francisco
const DEFAULT_ZOOM = 13;
const TILE_URL = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

/**
 * CTMap - Interactive map component with markers, circles, and polylines
 *
 * @element ct-map
 *
 * @attr {MapValue|Cell<MapValue>} value - Map data with markers, circles, polylines
 * @attr {LatLng|Cell<LatLng>} center - Map center coordinates (bidirectional)
 * @attr {number|Cell<number>} zoom - Map zoom level (bidirectional)
 * @attr {Bounds|Cell<Bounds>} bounds - Visible map bounds (bidirectional)
 * @attr {boolean} fitToBounds - Auto-fit to show all features
 * @attr {boolean} interactive - Enable pan/zoom (default: true)
 *
 * @fires ct-click - Map background click with { lat, lng }
 * @fires ct-bounds-change - Viewport change with { bounds, center, zoom }
 * @fires ct-marker-click - Marker click with { marker, index, lat, lng }
 * @fires ct-marker-drag-end - Marker drag end with { marker, index, position, oldPosition }
 * @fires ct-circle-click - Circle click with { circle, index, lat, lng }
 *
 * @example
 * <ct-map
 *   $value={mapDataCell}
 *   $center={centerCell}
 *   $zoom={zoomCell}
 *   fitToBounds
 *   @ct-marker-click={handleMarkerClick}
 * ></ct-map>
 */
export class CTMap extends BaseElement {
  static override styles = [BaseElement.baseStyles, styles];

  static override properties = {
    value: { attribute: false },
    center: { attribute: false },
    zoom: { attribute: false },
    bounds: { attribute: false },
    fitToBounds: { type: Boolean },
    interactive: { type: Boolean },
  };

  declare value: Cell<MapValue> | MapValue;
  declare center: Cell<LatLng> | LatLng;
  declare zoom: Cell<number> | number;
  declare bounds: Cell<Bounds> | Bounds;
  declare fitToBounds: boolean;
  declare interactive: boolean;

  // Leaflet map instance
  private _map: L.Map | null = null;

  // Layer groups for organized management
  private _markerLayer: L.LayerGroup | null = null;
  private _circleLayer: L.LayerGroup | null = null;
  private _polylineLayer: L.LayerGroup | null = null;

  // Track markers for drag events
  private _leafletMarkers: L.Marker[] = [];

  // Track circles for click events
  private _leafletCircles: L.Circle[] = [];

  // Change group for internal edits to avoid echo loops
  private _changeGroup = crypto.randomUUID();

  // Flag to prevent echo loops during programmatic updates
  private _isUpdatingFromCell = false;

  // Cell subscriptions for cleanup
  private _valueUnsubscribe: (() => void) | null = null;
  private _centerUnsubscribe: (() => void) | null = null;
  private _zoomUnsubscribe: (() => void) | null = null;
  private _boundsUnsubscribe: (() => void) | null = null;

  // Cell controllers for bidirectional bindings
  private _centerController = new CellController<LatLng>(this, {
    timing: { strategy: "immediate" },
    triggerUpdate: false,
    changeGroup: this._changeGroup,
  });

  private _zoomController = new CellController<number>(this, {
    timing: { strategy: "immediate" },
    triggerUpdate: false,
    changeGroup: this._changeGroup,
  });

  private _boundsController = new CellController<Bounds>(this, {
    timing: { strategy: "immediate" },
    triggerUpdate: false,
    changeGroup: this._changeGroup,
  });

  constructor() {
    super();
    this.fitToBounds = false;
    this.interactive = true;
  }

  override connectedCallback(): void {
    super.connectedCallback();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._cleanup();
  }

  protected override firstUpdated(_changedProperties: PropertyValues): void {
    super.firstUpdated(_changedProperties);
    this._initializeMap();
    this._setupCellSubscriptions();
    this._renderFeatures();

    if (this.fitToBounds) {
      this._fitMapToBounds();
    }
  }

  protected override updated(changedProperties: PropertyValues): void {
    super.updated(changedProperties);

    // Handle value changes
    if (changedProperties.has("value")) {
      this._setupValueSubscription();
      this._renderFeatures();
      if (this.fitToBounds) {
        this._fitMapToBounds();
      }
    }

    // Handle center changes
    if (changedProperties.has("center")) {
      this._centerController.bind(this.center);
      this._setupCenterSubscription();
      this._updateMapCenter();
    }

    // Handle zoom changes
    if (changedProperties.has("zoom")) {
      this._zoomController.bind(this.zoom);
      this._setupZoomSubscription();
      this._updateMapZoom();
    }

    // Handle bounds changes
    if (changedProperties.has("bounds")) {
      this._boundsController.bind(this.bounds);
      this._setupBoundsSubscription();
    }

    // Handle interactive changes
    if (changedProperties.has("interactive") && this._map) {
      if (this.interactive) {
        this._map.dragging.enable();
        this._map.touchZoom.enable();
        this._map.doubleClickZoom.enable();
        this._map.scrollWheelZoom.enable();
        this._map.boxZoom.enable();
        this._map.keyboard.enable();
      } else {
        this._map.dragging.disable();
        this._map.touchZoom.disable();
        this._map.doubleClickZoom.disable();
        this._map.scrollWheelZoom.disable();
        this._map.boxZoom.disable();
        this._map.keyboard.disable();
      }
    }

    // Handle fitToBounds changes
    if (changedProperties.has("fitToBounds") && this.fitToBounds) {
      this._fitMapToBounds();
    }
  }

  override render() {
    return html`
      <div class="map-container"></div>
    `;
  }

  // === Map Initialization ===

  private _initializeMap(): void {
    const container = this.shadowRoot?.querySelector(
      ".map-container",
    ) as HTMLElement;
    if (!container) return;

    // Get initial center and zoom
    const initialCenter = this._getCenter();
    const initialZoom = this._getZoom();

    // Create map instance
    this._map = L.map(container, {
      center: [initialCenter.lat, initialCenter.lng],
      zoom: initialZoom,
      dragging: this.interactive,
      touchZoom: this.interactive,
      doubleClickZoom: this.interactive,
      scrollWheelZoom: this.interactive,
      boxZoom: this.interactive,
      keyboard: this.interactive,
      zoomControl: this.interactive,
    });

    // Add tile layer
    L.tileLayer(TILE_URL, {
      attribution: TILE_ATTRIBUTION,
    }).addTo(this._map);

    // Create layer groups
    this._markerLayer = L.layerGroup().addTo(this._map);
    this._circleLayer = L.layerGroup().addTo(this._map);
    this._polylineLayer = L.layerGroup().addTo(this._map);

    // Set up event handlers
    this._setupMapEventHandlers();
  }

  private _setupMapEventHandlers(): void {
    if (!this._map) return;

    // Map click event
    this._map.on("click", (e: L.LeafletMouseEvent) => {
      const detail: CtClickDetail = {
        lat: e.latlng.lat,
        lng: e.latlng.lng,
      };
      this.emit("ct-click", detail);
    });

    // Bounds change event (moveend covers both pan and zoom)
    this._map.on("moveend", () => {
      if (this._isUpdatingFromCell) return;

      const bounds = this._map!.getBounds();
      const center = this._map!.getCenter();
      const zoom = this._map!.getZoom();

      const boundsData: Bounds = {
        north: bounds.getNorth(),
        south: bounds.getSouth(),
        east: bounds.getEast(),
        west: bounds.getWest(),
      };

      const centerData: LatLng = {
        lat: center.lat,
        lng: center.lng,
      };

      // Emit bounds change event
      const detail: CtBoundsChangeDetail = {
        bounds: boundsData,
        center: centerData,
        zoom,
      };
      this.emit("ct-bounds-change", detail);

      // Update Cell values (bidirectional)
      this._updateCenterCell(centerData);
      this._updateZoomCell(zoom);
      this._updateBoundsCell(boundsData);
    });
  }

  // === Cell Subscriptions ===

  private _setupCellSubscriptions(): void {
    this._setupValueSubscription();
    this._setupCenterSubscription();
    this._setupZoomSubscription();
    this._setupBoundsSubscription();
  }

  private _setupValueSubscription(): void {
    if (this._valueUnsubscribe) {
      this._valueUnsubscribe();
      this._valueUnsubscribe = null;
    }

    if (isCell(this.value)) {
      this._valueUnsubscribe = this.value.sink(
        () => {
          this._renderFeatures();
          if (this.fitToBounds) {
            this._fitMapToBounds();
          }
        },
        { changeGroup: this._changeGroup },
      );
    }
  }

  private _setupCenterSubscription(): void {
    if (this._centerUnsubscribe) {
      this._centerUnsubscribe();
      this._centerUnsubscribe = null;
    }

    if (isCell(this.center)) {
      this._centerUnsubscribe = this.center.sink(
        () => {
          this._updateMapCenter();
        },
        { changeGroup: this._changeGroup },
      );
    }
  }

  private _setupZoomSubscription(): void {
    if (this._zoomUnsubscribe) {
      this._zoomUnsubscribe();
      this._zoomUnsubscribe = null;
    }

    if (isCell(this.zoom)) {
      this._zoomUnsubscribe = this.zoom.sink(
        () => {
          this._updateMapZoom();
        },
        { changeGroup: this._changeGroup },
      );
    }
  }

  private _setupBoundsSubscription(): void {
    if (this._boundsUnsubscribe) {
      this._boundsUnsubscribe();
      this._boundsUnsubscribe = null;
    }

    if (isCell(this.bounds)) {
      this._boundsUnsubscribe = this.bounds.sink(
        () => {
          this._updateMapFromBounds();
        },
        { changeGroup: this._changeGroup },
      );
    }
  }

  // === Value Getters ===

  private _getValue(): MapValue {
    if (isCell(this.value)) {
      return this.value.get() || {};
    }
    return this.value || {};
  }

  private _getCenter(): LatLng {
    if (isCell(this.center)) {
      return this.center.get() || DEFAULT_CENTER;
    }
    return this.center || DEFAULT_CENTER;
  }

  private _getZoom(): number {
    if (isCell(this.zoom)) {
      return this.zoom.get() || DEFAULT_ZOOM;
    }
    return this.zoom || DEFAULT_ZOOM;
  }

  private _getBounds(): Bounds | null {
    if (isCell(this.bounds)) {
      return this.bounds.get() || null;
    }
    return this.bounds || null;
  }

  // === Cell Updates (bidirectional) ===

  private _updateCenterCell(center: LatLng): void {
    if (!isCell(this.center)) return;

    const tx = this.center.runtime.edit({ changeGroup: this._changeGroup });
    this.center.withTx(tx).set(center);
    tx.commit();
  }

  private _updateZoomCell(zoom: number): void {
    if (!isCell(this.zoom)) return;

    const tx = this.zoom.runtime.edit({ changeGroup: this._changeGroup });
    this.zoom.withTx(tx).set(zoom);
    tx.commit();
  }

  private _updateBoundsCell(bounds: Bounds): void {
    if (!isCell(this.bounds)) return;

    const tx = this.bounds.runtime.edit({ changeGroup: this._changeGroup });
    this.bounds.withTx(tx).set(bounds);
    tx.commit();
  }

  // === Map Updates ===

  private _updateMapCenter(): void {
    if (!this._map) return;

    this._isUpdatingFromCell = true;
    try {
      const center = this._getCenter();
      this._map.setView([center.lat, center.lng], this._map.getZoom(), {
        animate: true,
      });
    } finally {
      this._isUpdatingFromCell = false;
    }
  }

  private _updateMapZoom(): void {
    if (!this._map) return;

    this._isUpdatingFromCell = true;
    try {
      const zoom = this._getZoom();
      this._map.setZoom(zoom, { animate: true });
    } finally {
      this._isUpdatingFromCell = false;
    }
  }

  private _updateMapFromBounds(): void {
    if (!this._map) return;

    const bounds = this._getBounds();
    if (!bounds) return;

    this._isUpdatingFromCell = true;
    try {
      const leafletBounds = L.latLngBounds(
        [bounds.south, bounds.west],
        [bounds.north, bounds.east],
      );
      this._map.fitBounds(leafletBounds, { animate: true });
    } finally {
      this._isUpdatingFromCell = false;
    }
  }

  // === Feature Rendering ===

  private _renderFeatures(): void {
    if (!this._map) return;

    const value = this._getValue();

    // Clear existing layers
    this._clearLayers();

    // Render markers
    if (value.markers && value.markers.length > 0) {
      this._renderMarkers(value.markers);
    }

    // Render circles
    if (value.circles && value.circles.length > 0) {
      this._renderCircles(value.circles);
    }

    // Render polylines
    if (value.polylines && value.polylines.length > 0) {
      this._renderPolylines(value.polylines);
    }
  }

  private _clearLayers(): void {
    this._markerLayer?.clearLayers();
    this._circleLayer?.clearLayers();
    this._polylineLayer?.clearLayers();
    this._leafletMarkers = [];
    this._leafletCircles = [];
  }

  private _renderMarkers(markers: MapMarker[]): void {
    if (!this._markerLayer) return;

    markers.forEach((marker, index) => {
      const { position, title, description, icon, popup, draggable } = marker;

      // Create marker icon
      let markerIcon: L.Icon | L.DivIcon | undefined;
      if (icon) {
        // Check if it's an emoji (simple heuristic)
        if (this._isEmoji(icon)) {
          // Create a span element safely to prevent XSS
          const span = document.createElement('span');
          span.className = 'emoji-marker';
          span.textContent = icon; // Safe - escapes HTML

          markerIcon = L.divIcon({
            html: span.outerHTML,
            className: "ct-map-emoji-marker",
            iconSize: [32, 32],
            iconAnchor: [16, 32],
            popupAnchor: [0, -32],
          });
        }
        // TODO: Handle URL icons in V2
      }

      // Create Leaflet marker
      const leafletMarker = L.marker([position.lat, position.lng], {
        icon: markerIcon,
        draggable: draggable || false,
      });

      // Add popup if content is provided
      if (popup || title || description) {
        const popupContent = this._createPopupContent(marker, "marker", index);
        leafletMarker.bindPopup(popupContent);
      }

      // Click handler
      leafletMarker.on("click", (e: L.LeafletMouseEvent) => {
        const detail: CtMarkerClickDetail = {
          marker,
          index,
          lat: e.latlng.lat,
          lng: e.latlng.lng,
        };
        this.emit("ct-marker-click", detail);
      });

      // Drag handlers
      if (draggable) {
        let oldPosition: LatLng = { ...position };

        // Capture position at drag start (not creation time)
        leafletMarker.on("dragstart", () => {
          const pos = leafletMarker.getLatLng();
          oldPosition = { lat: pos.lat, lng: pos.lng };
        });

        leafletMarker.on("dragend", (e: L.DragEndEvent) => {
          const newLatLng = e.target.getLatLng();
          const newPosition: LatLng = {
            lat: newLatLng.lat,
            lng: newLatLng.lng,
          };
          const detail: CtMarkerDragEndDetail = {
            marker,
            index,
            position: newPosition,
            oldPosition,
          };
          this.emit("ct-marker-drag-end", detail);
        });
      }

      // Add to layer and track
      leafletMarker.addTo(this._markerLayer!);
      this._leafletMarkers.push(leafletMarker);
    });
  }

  private _renderCircles(circles: MapCircle[]): void {
    if (!this._circleLayer) return;

    circles.forEach((circle, index) => {
      const { center, radius, color, fillOpacity, strokeWidth, popup, title } =
        circle;

      // Create Leaflet circle
      const leafletCircle = L.circle([center.lat, center.lng], {
        radius,
        color: color || "#3b82f6",
        fillColor: color || "#3b82f6",
        fillOpacity: fillOpacity ?? 0.2,
        weight: strokeWidth ?? 2,
      });

      // Add popup if content is provided
      if (popup || title) {
        const popupContent = this._createPopupContent(circle, "circle", index);
        leafletCircle.bindPopup(popupContent);
      }

      // Click handler
      leafletCircle.on("click", (e: L.LeafletMouseEvent) => {
        const detail: CtCircleClickDetail = {
          circle,
          index,
          lat: e.latlng.lat,
          lng: e.latlng.lng,
        };
        this.emit("ct-circle-click", detail);
      });

      // Add to layer and track
      leafletCircle.addTo(this._circleLayer!);
      this._leafletCircles.push(leafletCircle);
    });
  }

  private _renderPolylines(polylines: MapPolyline[]): void {
    if (!this._polylineLayer) return;

    polylines.forEach((polyline) => {
      const { points, color, strokeWidth, dashArray } = polyline;

      // Convert to Leaflet format
      const latLngs: L.LatLngExpression[] = points.map((p) => [p.lat, p.lng]);

      // Create Leaflet polyline
      const leafletPolyline = L.polyline(latLngs, {
        color: color || "#3b82f6",
        weight: strokeWidth ?? 3,
        dashArray: dashArray,
      });

      // Add to layer
      leafletPolyline.addTo(this._polylineLayer!);
    });
  }

  // === Popup Rendering ===

  private _createPopupContent(
    feature: MapMarker | MapCircle,
    _type: "marker" | "circle",
    _index: number,
  ): HTMLElement {
    const container = document.createElement("div");

    // Check if we have an OpaqueRef popup (advanced mode)
    if (feature.popup) {
      // Create a ct-render element for the popup content
      const ctRender = document.createElement("ct-render");
      (ctRender as any).cell = feature.popup;
      container.appendChild(ctRender);
    } else {
      // Simple popup content
      container.className = "popup-simple";

      if ("icon" in feature && feature.icon) {
        const iconEl = document.createElement("div");
        iconEl.className = "popup-icon";
        iconEl.textContent = feature.icon;
        container.appendChild(iconEl);
      }

      if (feature.title) {
        const titleEl = document.createElement("div");
        titleEl.className = "popup-title";
        titleEl.textContent = feature.title;
        container.appendChild(titleEl);
      }

      if (feature.description) {
        const descEl = document.createElement("p");
        descEl.className = "popup-description";
        descEl.textContent = feature.description;
        container.appendChild(descEl);
      }
    }

    return container;
  }

  // === Fit to Bounds ===

  private _fitMapToBounds(): void {
    if (!this._map) return;

    const value = this._getValue();
    const allPoints: L.LatLng[] = [];

    // Collect all marker positions
    if (value.markers) {
      value.markers.forEach((m) => {
        allPoints.push(L.latLng(m.position.lat, m.position.lng));
      });
    }

    // Collect all circle centers (could also use circle bounds)
    if (value.circles) {
      value.circles.forEach((c) => {
        allPoints.push(L.latLng(c.center.lat, c.center.lng));
      });
    }

    // Collect all polyline points
    if (value.polylines) {
      value.polylines.forEach((p) => {
        p.points.forEach((pt) => {
          allPoints.push(L.latLng(pt.lat, pt.lng));
        });
      });
    }

    // Fit bounds if we have points
    if (allPoints.length > 0) {
      const bounds = L.latLngBounds(allPoints);
      this._isUpdatingFromCell = true;
      try {
        this._map.fitBounds(bounds, {
          padding: [50, 50],
          maxZoom: 16,
        });
      } finally {
        this._isUpdatingFromCell = false;
      }
    }
  }

  // === Utilities ===

  private _isEmoji(str: string): boolean {
    // Simple emoji detection - checks for emoji unicode ranges
    const emojiRegex =
      /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{1F600}-\u{1F64F}]|[\u{1F680}-\u{1F6FF}]/u;
    return emojiRegex.test(str);
  }

  // === Cleanup ===

  private _cleanup(): void {
    // Unsubscribe from Cells
    if (this._valueUnsubscribe) {
      this._valueUnsubscribe();
      this._valueUnsubscribe = null;
    }
    if (this._centerUnsubscribe) {
      this._centerUnsubscribe();
      this._centerUnsubscribe = null;
    }
    if (this._zoomUnsubscribe) {
      this._zoomUnsubscribe();
      this._zoomUnsubscribe = null;
    }
    if (this._boundsUnsubscribe) {
      this._boundsUnsubscribe();
      this._boundsUnsubscribe = null;
    }

    // Destroy map
    if (this._map) {
      this._map.remove();
      this._map = null;
    }

    // Clear references
    this._markerLayer = null;
    this._circleLayer = null;
    this._polylineLayer = null;
    this._leafletMarkers = [];
    this._leafletCircles = [];
  }

  // === Public API ===

  /**
   * Get the underlying Leaflet map instance for advanced usage
   */
  get leafletMap(): L.Map | null {
    return this._map;
  }

  /**
   * Invalidate the map size (call after container resize)
   */
  invalidateSize(): void {
    this._map?.invalidateSize();
  }

  /**
   * Programmatically fit the map to show all features
   */
  fitBounds(): void {
    this._fitMapToBounds();
  }

  /**
   * Pan to a specific location
   */
  panTo(lat: number, lng: number): void {
    this._map?.panTo([lat, lng]);
  }

  /**
   * Set the map view to a specific location and zoom
   */
  setView(lat: number, lng: number, zoom: number): void {
    this._map?.setView([lat, lng], zoom);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ct-map": CTMap;
  }
}
