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
import { type CellHandle, type JSONSchema } from "@commontools/runtime-client";
import { createCellController } from "../../core/cell-controller.ts";
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

// Valid coordinate and zoom ranges
const MIN_ZOOM = 0;
const MAX_ZOOM = 18;
const MIN_LAT = -90;
const MAX_LAT = 90;
const MIN_LNG = -180;
const MAX_LNG = 180;

// Keyboard navigation constants
const PAN_AMOUNT = 100; // pixels to pan per arrow key press

// Cached emoji regex for performance (compiled once at module load)
const EMOJI_REGEX =
  /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{1F600}-\u{1F64F}]|[\u{1F680}-\u{1F6FF}]/u;

// ResizeObserver debounce delay in milliseconds
const RESIZE_DEBOUNCE_MS = 150;

// JSON Schemas for nested cell resolution via CellController.bind()
// These schemas enable automatic resolution of nested CellHandles
const latLngSchema: JSONSchema = {
  type: "object",
  properties: {
    lat: { type: "number" },
    lng: { type: "number" },
  },
};

const boundsSchema: JSONSchema = {
  type: "object",
  properties: {
    north: { type: "number" },
    south: { type: "number" },
    east: { type: "number" },
    west: { type: "number" },
  },
};

const mapValueSchema: JSONSchema = {
  type: "object",
  properties: {
    markers: {
      type: "array",
      items: {
        type: "object",
        properties: {
          position: latLngSchema,
          title: { type: "string" },
          description: { type: "string" },
          icon: { type: "string" },
          draggable: { type: "boolean" },
          // popup is OpaqueRef, left unspecified to preserve as-is
        },
      },
    },
    circles: {
      type: "array",
      items: {
        type: "object",
        properties: {
          center: latLngSchema,
          radius: { type: "number" },
          color: { type: "string" },
          fillOpacity: { type: "number" },
          strokeWidth: { type: "number" },
          title: { type: "string" },
          description: { type: "string" },
          // popup is OpaqueRef, left unspecified to preserve as-is
        },
      },
    },
    polylines: {
      type: "array",
      items: {
        type: "object",
        properties: {
          points: {
            type: "array",
            items: latLngSchema,
          },
          color: { type: "string" },
          strokeWidth: { type: "number" },
          dashArray: { type: "string" },
        },
      },
    },
  },
};

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
 * @note Polyline click events are not currently supported. Polylines are rendered
 * for display only (routes, paths). For clickable segments, use circles as waypoints.
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

  declare value: CellHandle<MapValue> | MapValue;
  declare center: CellHandle<LatLng> | LatLng;
  declare zoom: CellHandle<number> | number;
  declare bounds: CellHandle<Bounds> | Bounds;
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

  // Track polylines for cleanup
  private _leafletPolylines: L.Polyline[] = [];

  // RAF ID for map initialization (prevent race condition on disconnect)
  private _rafId: number | null = null;

  // ResizeObserver for automatic map resize when container changes
  private _resizeObserver: ResizeObserver | null = null;

  // Timeout ID for debounced resize handling
  private _resizeTimeoutId: ReturnType<typeof setTimeout> | null = null;

  // Flag to prevent echo loops during programmatic updates
  private _isUpdatingFromCell = false;

  // Flag to track pending click events deferred during animations
  private _pendingClickEvent: L.LeafletMouseEvent | null = null;

  // Pending updates deferred during animations
  // These are processed when the map stabilizes (on zoomend)
  private _pendingCenterUpdate: LatLng | null = null;
  private _pendingZoomUpdate: number | null = null;
  private _pendingBoundsUpdate: Bounds | null = null;
  private _pendingFitToBounds = false;

  // Cell controllers for reactive data binding
  // These manage subscriptions automatically via Lit's ReactiveController lifecycle
  // Note: Feature rendering is handled in updated() to catch both property changes
  // and cell subscription updates
  private _valueController = createCellController<MapValue>(this, {
    timing: { strategy: "immediate" },
  });

  private _centerController = createCellController<LatLng>(this, {
    timing: { strategy: "immediate" },
    triggerUpdate: false,
    onChange: () => {
      if (!this._isUpdatingFromCell) {
        this._updateMapCenter();
      }
    },
  });

  private _zoomController = createCellController<number>(this, {
    timing: { strategy: "immediate" },
    triggerUpdate: false,
    onChange: () => {
      if (!this._isUpdatingFromCell) {
        this._updateMapZoom();
      }
    },
  });

  private _boundsController = createCellController<Bounds>(this, {
    timing: { strategy: "immediate" },
    triggerUpdate: false,
    onChange: () => {
      if (!this._isUpdatingFromCell) {
        this._updateMapFromBounds();
      }
    },
  });

  // Bound event handler for cleanup
  private _boundHandleKeydown = this._handleKeydown.bind(this);

  constructor() {
    super();
    this.fitToBounds = false;
    this.interactive = true;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.addEventListener("keydown", this._boundHandleKeydown);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.removeEventListener("keydown", this._boundHandleKeydown);
    this._cleanup();
  }

  protected override firstUpdated(_changedProperties: PropertyValues): void {
    super.firstUpdated(_changedProperties);

    // Bind all controllers to their initial values with JSON schemas
    // Schema binding enables automatic resolution of nested CellHandles
    this._valueController.bind(this.value, mapValueSchema);
    this._centerController.bind(this.center, latLngSchema);
    this._zoomController.bind(this.zoom);
    this._boundsController.bind(this.bounds, boundsSchema);

    this._initializeMap();

    // Render features after map initialization
    this._renderFeatures();
  }

  protected override updated(changedProperties: PropertyValues): void {
    super.updated(changedProperties);

    // Handle value changes - rebind controller when property changes
    if (changedProperties.has("value")) {
      this._valueController.bind(this.value, mapValueSchema);
    }

    // Re-render features on every update when we have a Cell
    // Cell subscription updates trigger requestUpdate() but don't show in changedProperties
    if (this._valueController.hasCell() || changedProperties.has("value")) {
      this._renderFeatures();
    }

    // Handle center changes - rebind controller when property changes
    if (changedProperties.has("center")) {
      this._centerController.bind(this.center, latLngSchema);
      this._updateMapCenter();
    }

    // Handle zoom changes - rebind controller when property changes
    if (changedProperties.has("zoom")) {
      this._zoomController.bind(this.zoom);
      this._updateMapZoom();
    }

    // Handle bounds changes - rebind controller when property changes
    if (changedProperties.has("bounds")) {
      this._boundsController.bind(this.bounds, boundsSchema);
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
      <div
        class="map-container"
        role="application"
        aria-label="Interactive map"
        tabindex="0"
      >
      </div>
    `;
  }

  // === Keyboard Navigation ===

  private _handleKeydown(event: KeyboardEvent): void {
    // Only handle when interactive and map exists and is stable
    if (!this.interactive || !this._map || !this._isMapStable()) return;

    // Check that the event target is within the map container
    const mapContainer = this.shadowRoot?.querySelector(".map-container");
    if (!mapContainer) return;

    // Only handle events when focus is on the map container
    const target = event.target as Node;
    if (target !== mapContainer && !mapContainer.contains(target)) return;

    switch (event.key) {
      case "ArrowUp":
        event.preventDefault();
        this._map.panBy([0, -PAN_AMOUNT]);
        break;
      case "ArrowDown":
        event.preventDefault();
        this._map.panBy([0, PAN_AMOUNT]);
        break;
      case "ArrowLeft":
        event.preventDefault();
        this._map.panBy([-PAN_AMOUNT, 0]);
        break;
      case "ArrowRight":
        event.preventDefault();
        this._map.panBy([PAN_AMOUNT, 0]);
        break;
      case "+":
      case "=":
        event.preventDefault();
        this._map.zoomIn();
        break;
      case "-":
        event.preventDefault();
        this._map.zoomOut();
        break;
    }
  }

  // === Map State Helpers ===

  /**
   * Check if the map is in a stable state for operations.
   * Returns false during zoom animations or when the map pane is not ready.
   * This prevents the Leaflet race condition where _mapPane becomes undefined
   * during concurrent pan+click operations.
   */
  private _isMapStable(): boolean {
    if (!this._map) return false;

    // Check if map is during a zoom animation
    // Access internal Leaflet state - _animatingZoom is set during zoom transitions
    const map = this._map as L.Map & { _animatingZoom?: boolean };
    if (map._animatingZoom) return false;

    // Check if map pane exists and is ready
    // This is the element that causes the _leaflet_pos error when undefined
    try {
      const pane = this._map.getPane("mapPane");
      if (!pane) return false;
    } catch {
      return false;
    }

    return true;
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

    // Add tile layer with crossOrigin for CORS compatibility
    const tileLayer = L.tileLayer(TILE_URL, {
      attribution: TILE_ATTRIBUTION,
      crossOrigin: true,
    });

    // Handle tile loading errors gracefully
    tileLayer.on("tileerror", (event: L.TileErrorEvent) => {
      console.warn("ct-map: Tile loading error", {
        coords: event.coords,
        error: event.error,
      });
    });

    tileLayer.addTo(this._map);

    // Create layer groups
    this._markerLayer = L.layerGroup().addTo(this._map);
    this._circleLayer = L.layerGroup().addTo(this._map);
    this._polylineLayer = L.layerGroup().addTo(this._map);

    // Set up event handlers
    this._setupMapEventHandlers();

    // Invalidate size after initialization to ensure proper tile loading
    // This is necessary when the map is rendered in Shadow DOM
    this._rafId = requestAnimationFrame(() => {
      this._map?.invalidateSize();
      this._rafId = null;
    });

    // Set up ResizeObserver to handle container size changes
    // This handles responsive layouts, tab switching, accordion panels, etc.
    // Debounce to prevent excessive layout thrashing on every pixel change
    this._resizeObserver = new ResizeObserver(() => {
      if (this._resizeTimeoutId !== null) {
        clearTimeout(this._resizeTimeoutId);
      }
      this._resizeTimeoutId = setTimeout(() => {
        this._map?.invalidateSize();
        this._resizeTimeoutId = null;
      }, RESIZE_DEBOUNCE_MS);
    });
    this._resizeObserver.observe(container);
  }

  private _setupMapEventHandlers(): void {
    if (!this._map) return;

    // Map click event - guard against race condition during zoom animations
    this._map.on("click", (e: L.LeafletMouseEvent) => {
      // If map is not stable (e.g., during zoom animation), defer the click
      if (!this._isMapStable()) {
        this._pendingClickEvent = e;
        return;
      }

      this._emitClickEvent(e);
    });

    // Handle deferred updates after zoom animations complete
    this._map.on("zoomend", () => {
      if (!this._isMapStable()) return;

      // Process pending click event
      if (this._pendingClickEvent) {
        this._emitClickEvent(this._pendingClickEvent);
        this._pendingClickEvent = null;
      }

      // Process pending map updates (queued during animation)
      // Process in order: bounds first (most specific), then center, then zoom
      this._processPendingUpdates();
    });

    // Bounds change event (moveend covers both pan and zoom)
    this._map.on("moveend", () => {
      if (this._isUpdatingFromCell) return;

      // Guard against race condition - map pane may not be ready
      if (!this._isMapStable()) return;

      // Wrap in try-catch as additional safety for Leaflet internal state issues
      try {
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

        // Update Cell values (bidirectional) using controllers
        this._updateCenterCell(centerData);
        this._updateZoomCell(zoom);
        this._updateBoundsCell(boundsData);
      } catch {
        // Silently ignore errors from Leaflet internal state issues
        // This can happen during rapid pan+click operations
      }
    });
  }

  /**
   * Emit click event with coordinates.
   * Extracted to allow deferred clicks after animations.
   */
  private _emitClickEvent(e: L.LeafletMouseEvent): void {
    const detail: CtClickDetail = {
      lat: e.latlng.lat,
      lng: e.latlng.lng,
    };
    this.emit("ct-click", detail);
  }

  // === Value Getters (using CellControllers) ===

  private _getValue(): MapValue {
    return this._valueController.getValue() || {};
  }

  private _getCenter(): LatLng {
    const center = this._centerController.getValue() || DEFAULT_CENTER;
    return this._validateLatLng(center);
  }

  private _getZoom(): number {
    const zoom = this._zoomController.getValue() ?? DEFAULT_ZOOM;
    return this._clampZoom(zoom);
  }

  private _getBounds(): Bounds | null {
    return this._boundsController.getValue() || null;
  }

  // === Cell Updates (bidirectional, using CellControllers) ===

  private _updateCenterCell(center: LatLng): void {
    if (!this._centerController.hasCell()) return;

    this._isUpdatingFromCell = true;
    try {
      this._centerController.setValue(center);
    } finally {
      this._isUpdatingFromCell = false;
    }
  }

  private _updateZoomCell(zoom: number): void {
    if (!this._zoomController.hasCell()) return;

    this._isUpdatingFromCell = true;
    try {
      this._zoomController.setValue(zoom);
    } finally {
      this._isUpdatingFromCell = false;
    }
  }

  private _updateBoundsCell(bounds: Bounds): void {
    if (!this._boundsController.hasCell()) return;

    this._isUpdatingFromCell = true;
    try {
      this._boundsController.setValue(bounds);
    } finally {
      this._isUpdatingFromCell = false;
    }
  }

  // === Map Updates ===

  private _updateMapCenter(): void {
    if (!this._map) return;

    const center = this._getCenter(); // Already validated by _getCenter()

    // If map is not stable, queue the update for when it stabilizes
    if (!this._isMapStable()) {
      this._pendingCenterUpdate = center;
      return;
    }

    this._isUpdatingFromCell = true;
    try {
      this._map.setView([center.lat, center.lng], this._map.getZoom(), {
        animate: true,
      });
    } finally {
      this._isUpdatingFromCell = false;
    }
  }

  private _updateMapZoom(): void {
    if (!this._map) return;

    const zoom = this._getZoom(); // Already validated by _getZoom()

    // If map is not stable, queue the update for when it stabilizes
    if (!this._isMapStable()) {
      this._pendingZoomUpdate = zoom;
      return;
    }

    this._isUpdatingFromCell = true;
    try {
      this._map.setZoom(zoom, { animate: true });
    } finally {
      this._isUpdatingFromCell = false;
    }
  }

  private _updateMapFromBounds(): void {
    if (!this._map) return;

    const bounds = this._getBounds();
    if (!bounds) return;

    // Validate bounds before applying
    const validatedBounds = this._validateBounds(bounds);
    if (!validatedBounds) return;

    // If map is not stable, queue the update for when it stabilizes
    if (!this._isMapStable()) {
      this._pendingBoundsUpdate = validatedBounds;
      return;
    }

    this._isUpdatingFromCell = true;
    try {
      const leafletBounds = L.latLngBounds(
        [validatedBounds.south, validatedBounds.west],
        [validatedBounds.north, validatedBounds.east],
      );
      this._map.fitBounds(leafletBounds, { animate: true });
    } finally {
      this._isUpdatingFromCell = false;
    }
  }

  /**
   * Process any pending updates that were queued during animations.
   * Called from zoomend handler when map becomes stable.
   */
  private _processPendingUpdates(): void {
    if (!this._map) return;

    // Process bounds update (most specific - sets both center and zoom)
    if (this._pendingBoundsUpdate) {
      const bounds = this._pendingBoundsUpdate;
      this._pendingBoundsUpdate = null;
      // Clear other pending updates since bounds encompasses them
      this._pendingCenterUpdate = null;
      this._pendingZoomUpdate = null;

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
      return; // Let the next zoomend handle any remaining updates
    }

    // Process center update
    if (this._pendingCenterUpdate) {
      const center = this._pendingCenterUpdate;
      this._pendingCenterUpdate = null;

      this._isUpdatingFromCell = true;
      try {
        this._map.setView([center.lat, center.lng], this._map.getZoom(), {
          animate: true,
        });
      } finally {
        this._isUpdatingFromCell = false;
      }
      return; // Let the next zoomend handle zoom update if any
    }

    // Process zoom update
    if (this._pendingZoomUpdate !== null) {
      const zoom = this._pendingZoomUpdate;
      this._pendingZoomUpdate = null;

      this._isUpdatingFromCell = true;
      try {
        this._map.setZoom(zoom, { animate: true });
      } finally {
        this._isUpdatingFromCell = false;
      }
      return;
    }

    // Process fitToBounds
    if (this._pendingFitToBounds) {
      this._pendingFitToBounds = false;
      this._fitMapToBounds();
    }
  }

  // === Feature Rendering ===

  private _clearLayers(): void {
    // Remove event listeners from tracked markers before clearing to prevent memory leaks
    // Leaflet's clearLayers() removes DOM nodes but doesn't remove .on() listeners
    for (const marker of this._leafletMarkers) {
      marker.off();
    }
    for (const circle of this._leafletCircles) {
      circle.off();
    }
    for (const polyline of this._leafletPolylines) {
      polyline.off();
    }

    this._markerLayer?.clearLayers();
    this._circleLayer?.clearLayers();
    this._polylineLayer?.clearLayers();
    this._leafletMarkers = [];
    this._leafletCircles = [];
    this._leafletPolylines = [];
  }

  /**
   * Render all map features from the current value.
   * Schema binding via CellController.bind() automatically resolves nested CellHandles,
   * so we can read directly from _getValue() without manual cell traversal.
   */
  private _renderFeatures(): void {
    if (!this._map) return;

    const value = this._getValue();

    // Clear existing layers
    this._clearLayers();

    // Render features from resolved data
    if (value.markers && value.markers.length > 0) {
      this._renderMarkers(value.markers);
    }
    if (value.circles && value.circles.length > 0) {
      this._renderCircles(value.circles);
    }
    if (value.polylines && value.polylines.length > 0) {
      this._renderPolylines(value.polylines);
    }

    // Handle fitToBounds
    if (this.fitToBounds) {
      this._fitMapToBounds();
    }
  }

  private _renderMarkers(markers: readonly MapMarker[]): void {
    if (!this._markerLayer) return;

    // Access length inside try-catch since reactive proxies can throw on property access
    let length: number;
    try {
      length = markers.length;
    } catch {
      return;
    }
    for (let i = 0; i < length; i++) {
      const index = i;

      // Extract all marker properties within try-catch to handle reactive proxy edge cases
      // where accessing nested properties may throw during partial data loading
      let marker: MapMarker;
      let lat: number;
      let lng: number;
      let title: string | undefined;
      let description: string | undefined;
      let icon: string | undefined;
      let popup: unknown;
      let draggable: boolean | undefined;

      try {
        marker = markers[i];
        if (!marker) {
          continue;
        }

        // Marker is resolved by the effect system
        const position = marker.position;
        if (!position) {
          continue;
        }

        lat = position.lat;
        lng = position.lng;
        if (typeof lat !== "number" || typeof lng !== "number") {
          continue;
        }

        // Extract remaining properties
        title = marker.title;
        description = marker.description;
        icon = marker.icon;
        popup = marker.popup;
        draggable = marker.draggable;
      } catch {
        // Skip markers that throw during property access
        continue;
      }

      // Create marker icon - always use divIcon to avoid Leaflet default icon issues in Shadow DOM
      let markerIcon: L.DivIcon;
      if (icon && this._isEmoji(icon)) {
        // Create a span element safely to prevent XSS
        const span = document.createElement("span");
        span.className = "emoji-marker";
        span.textContent = icon; // Safe - escapes HTML

        markerIcon = L.divIcon({
          html: span.outerHTML,
          className: "ct-map-emoji-marker",
          iconSize: [32, 32],
          iconAnchor: [16, 32],
          popupAnchor: [0, -32],
        });
      } else {
        // Default marker icon - SVG pin that works in Shadow DOM
        // (Leaflet's default L.Icon.Default fails in Shadow DOM due to image path resolution)
        markerIcon = L.divIcon({
          html:
            `<svg width="25" height="41" viewBox="0 0 25 41" xmlns="http://www.w3.org/2000/svg">
            <path d="M12.5 0C5.6 0 0 5.6 0 12.5c0 2.4.7 4.6 1.9 6.5L12.5 41l10.6-22c1.2-1.9 1.9-4.1 1.9-6.5C25 5.6 19.4 0 12.5 0z" fill="#3b82f6"/>
            <circle cx="12.5" cy="12.5" r="5" fill="white"/>
          </svg>`,
          className: "ct-map-default-marker",
          iconSize: [25, 41],
          iconAnchor: [12, 41],
          popupAnchor: [0, -41],
        });
      }

      // Create Leaflet marker (use validated lat/lng from above)
      const leafletMarker = L.marker([lat, lng], {
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
        // Use validated lat/lng instead of spreading reactive proxy
        let oldPosition: LatLng = { lat, lng };

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
    }
  }

  private _renderCircles(circles: readonly MapCircle[]): void {
    if (!this._circleLayer) return;

    // Access length inside try-catch since reactive proxies can throw on property access
    let length: number;
    try {
      length = circles.length;
    } catch {
      return;
    }
    for (let i = 0; i < length; i++) {
      const index = i;

      // Extract all circle properties within try-catch
      let circle: MapCircle;
      let lat: number;
      let lng: number;
      let radius: number;
      let color: string | undefined;
      let fillOpacity: number | undefined;
      let strokeWidth: number | undefined;
      let popup: unknown;
      let title: string | undefined;

      try {
        circle = circles[i];
        if (!circle) {
          continue;
        }

        // Circle is resolved by the effect system
        const center = circle.center;
        if (!center) {
          continue;
        }

        lat = center.lat;
        lng = center.lng;
        if (typeof lat !== "number" || typeof lng !== "number") {
          continue;
        }

        // Extract remaining properties
        radius = circle.radius;
        color = circle.color;
        fillOpacity = circle.fillOpacity;
        strokeWidth = circle.strokeWidth;
        popup = circle.popup;
        title = circle.title;
      } catch {
        // Skip circles that throw during property access
        continue;
      }

      // Create Leaflet circle (use validated lat/lng from above)
      const leafletCircle = L.circle([lat, lng], {
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
    }
  }

  private _renderPolylines(polylines: readonly MapPolyline[]): void {
    if (!this._polylineLayer) return;

    // Access length inside try-catch since reactive proxies can throw on property access
    let length: number;
    try {
      length = polylines.length;
    } catch {
      return;
    }
    for (let i = 0; i < length; i++) {
      const polyline = polylines[i];

      // Skip polylines without valid points array
      if (!polyline) {
        continue;
      }

      // Polyline is resolved by the effect system
      const points = polyline.points;
      if (!points || !Array.isArray(points)) {
        continue;
      }

      // Extract style properties
      const color = polyline.color;
      const strokeWidth = polyline.strokeWidth;
      const dashArray = polyline.dashArray;

      // Convert to Leaflet format, filtering out invalid points
      const latLngs: L.LatLngExpression[] = [];
      const pointsLength = points.length;
      for (let j = 0; j < pointsLength; j++) {
        const p = points[j];
        if (p && typeof p.lat === "number" && typeof p.lng === "number") {
          latLngs.push([p.lat, p.lng]);
        }
      }

      // Skip if no valid points remain
      if (latLngs.length === 0) {
        continue;
      }

      // Create Leaflet polyline
      // Note: Polylines are display-only (no click events). Use circles as
      // waypoints if clickable segments are needed.
      const leafletPolyline = L.polyline(latLngs, {
        color: color || "#3b82f6",
        weight: strokeWidth ?? 3,
        dashArray: dashArray,
      });

      // Add to layer and track
      leafletPolyline.addTo(this._polylineLayer!);
      this._leafletPolylines.push(leafletPolyline);
    }
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

    // If map is not stable, queue the update for when it stabilizes
    if (!this._isMapStable()) {
      this._pendingFitToBounds = true;
      return;
    }

    const value = this._getValue();
    const allPoints: L.LatLng[] = [];

    // Collect all marker positions
    // Use traditional for loops with try-catch to avoid reactive proxy issues
    if (value.markers) {
      const markers = value.markers;
      const markersLength = markers.length;
      for (let i = 0; i < markersLength; i++) {
        try {
          const m = markers[i];
          if (m) {
            const position = m.position;
            if (position) {
              const lat = position.lat;
              const lng = position.lng;
              if (typeof lat === "number" && typeof lng === "number") {
                allPoints.push(L.latLng(lat, lng));
              }
            }
          }
        } catch {
          // Skip markers that throw during property access
        }
      }
    }

    // Collect all circle centers (could also use circle bounds)
    if (value.circles) {
      const circles = value.circles;
      const circlesLength = circles.length;
      for (let i = 0; i < circlesLength; i++) {
        try {
          const c = circles[i];
          if (c) {
            const center = c.center;
            if (center) {
              const lat = center.lat;
              const lng = center.lng;
              if (typeof lat === "number" && typeof lng === "number") {
                allPoints.push(L.latLng(lat, lng));
              }
            }
          }
        } catch {
          // Skip circles that throw during property access
        }
      }
    }

    // Collect all polyline points
    if (value.polylines) {
      const polylines = value.polylines;
      const polylinesLength = polylines.length;
      for (let i = 0; i < polylinesLength; i++) {
        try {
          const p = polylines[i];
          if (p) {
            const points = p.points;
            if (points) {
              const pointsLength = points.length;
              for (let j = 0; j < pointsLength; j++) {
                try {
                  const pt = points[j];
                  if (pt) {
                    const lat = pt.lat;
                    const lng = pt.lng;
                    if (typeof lat === "number" && typeof lng === "number") {
                      allPoints.push(L.latLng(lat, lng));
                    }
                  }
                } catch {
                  // Skip points that throw during property access
                }
              }
            }
          }
        } catch {
          // Skip polylines that throw during property access
        }
      }
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
    // Uses module-level cached regex for performance
    return EMOJI_REGEX.test(str);
  }

  // === Coordinate Validation ===

  /**
   * Clamp zoom level to valid range, handling NaN/Infinity
   */
  private _clampZoom(zoom: number): number {
    if (!Number.isFinite(zoom)) {
      return DEFAULT_ZOOM;
    }
    return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
  }

  /**
   * Clamp latitude to valid range, handling NaN/Infinity
   */
  private _clampLat(lat: number): number {
    if (!Number.isFinite(lat)) {
      return DEFAULT_CENTER.lat;
    }
    return Math.max(MIN_LAT, Math.min(MAX_LAT, lat));
  }

  /**
   * Clamp longitude to valid range, handling NaN/Infinity
   */
  private _clampLng(lng: number): number {
    if (!Number.isFinite(lng)) {
      return DEFAULT_CENTER.lng;
    }
    return Math.max(MIN_LNG, Math.min(MAX_LNG, lng));
  }

  /**
   * Validate and clamp a LatLng object
   */
  private _validateLatLng(latLng: LatLng): LatLng {
    return {
      lat: this._clampLat(latLng.lat),
      lng: this._clampLng(latLng.lng),
    };
  }

  /**
   * Validate bounds data
   * Returns null if bounds are invalid (non-finite numbers, out of range, or south > north)
   */
  private _validateBounds(bounds: Bounds): Bounds | null {
    const { north, south, east, west } = bounds;

    // Check that all values are finite numbers
    if (
      !Number.isFinite(north) ||
      !Number.isFinite(south) ||
      !Number.isFinite(east) ||
      !Number.isFinite(west)
    ) {
      return null;
    }

    // Check latitude range
    if (
      north < MIN_LAT ||
      north > MAX_LAT ||
      south < MIN_LAT ||
      south > MAX_LAT
    ) {
      return null;
    }

    // Check longitude range
    if (
      east < MIN_LNG ||
      east > MAX_LNG ||
      west < MIN_LNG ||
      west > MAX_LNG
    ) {
      return null;
    }

    // Check that south <= north
    if (south > north) {
      return null;
    }

    return bounds;
  }

  // === Cleanup ===

  private _cleanup(): void {
    // Cancel pending RAF to prevent race condition if component disconnects before it fires
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }

    // Clear pending resize debounce timeout
    if (this._resizeTimeoutId !== null) {
      clearTimeout(this._resizeTimeoutId);
      this._resizeTimeoutId = null;
    }

    // Disconnect ResizeObserver
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
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
    this._leafletPolylines = [];
    this._pendingClickEvent = null;
    this._pendingCenterUpdate = null;
    this._pendingZoomUpdate = null;
    this._pendingBoundsUpdate = null;
    this._pendingFitToBounds = false;

    // Note: CellControllers are automatically cleaned up by Lit's reactive
    // controller system. They implement ReactiveController with
    // hostDisconnected() callbacks that are automatically invoked when
    // the host element disconnects.
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
    if (!this._isMapStable()) return;
    this._map?.panTo([lat, lng]);
  }

  /**
   * Set the map view to a specific location and zoom
   */
  setView(lat: number, lng: number, zoom: number): void {
    if (!this._isMapStable()) return;
    this._map?.setView([lat, lng], zoom);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ct-map": CTMap;
  }
}
