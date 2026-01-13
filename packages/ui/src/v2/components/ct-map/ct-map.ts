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
import { type CellHandle, isCellHandle } from "@commontools/runtime-client";
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

// Set to true to enable debug logging
const DEBUG_LOGGING = false;

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

  // RAF ID for map initialization (prevent race condition on disconnect)
  private _rafId: number | null = null;

  // ResizeObserver for automatic map resize when container changes
  private _resizeObserver: ResizeObserver | null = null;

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
  });

  private _zoomController = new CellController<number>(this, {
    timing: { strategy: "immediate" },
    triggerUpdate: false,
  });

  private _boundsController = new CellController<Bounds>(this, {
    timing: { strategy: "immediate" },
    triggerUpdate: false,
  });

  // Bound event handler for cleanup
  private _boundHandleKeydown = this._handleKeydown.bind(this);

  // Debug helper - only logs when DEBUG_LOGGING is true
  private _logWarn(...args: unknown[]): void {
    if (DEBUG_LOGGING) {
      console.warn("[ct-map]", ...args);
    }
  }

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
    // Only handle when interactive and map exists
    if (!this.interactive || !this._map) return;

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
    L.tileLayer(TILE_URL, {
      attribution: TILE_ATTRIBUTION,
      crossOrigin: true,
    }).addTo(this._map);

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
    this._resizeObserver = new ResizeObserver(() => {
      this._map?.invalidateSize();
    });
    this._resizeObserver.observe(container);
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

    if (isCellHandle(this.value)) {
      this._valueUnsubscribe = (this.value as CellHandle<MapValue>).subscribe(
        () => {
          this._renderFeatures();
          if (this.fitToBounds) {
            this._fitMapToBounds();
          }
        },
      );
    }
  }

  private _setupCenterSubscription(): void {
    if (this._centerUnsubscribe) {
      this._centerUnsubscribe();
      this._centerUnsubscribe = null;
    }

    if (isCellHandle(this.center)) {
      this._centerUnsubscribe = (this.center as CellHandle<LatLng>).subscribe(
        () => {
          if (!this._isUpdatingFromCell) {
            this._updateMapCenter();
          }
        },
      );
    }
  }

  private _setupZoomSubscription(): void {
    if (this._zoomUnsubscribe) {
      this._zoomUnsubscribe();
      this._zoomUnsubscribe = null;
    }

    if (isCellHandle(this.zoom)) {
      this._zoomUnsubscribe = (this.zoom as CellHandle<number>).subscribe(
        () => {
          if (!this._isUpdatingFromCell) {
            this._updateMapZoom();
          }
        },
      );
    }
  }

  private _setupBoundsSubscription(): void {
    if (this._boundsUnsubscribe) {
      this._boundsUnsubscribe();
      this._boundsUnsubscribe = null;
    }

    if (isCellHandle(this.bounds)) {
      this._boundsUnsubscribe = (this.bounds as CellHandle<Bounds>).subscribe(
        () => {
          if (!this._isUpdatingFromCell) {
            this._updateMapFromBounds();
          }
        },
      );
    }
  }

  // === Value Getters ===

  private _getValue(): MapValue {
    if (isCellHandle(this.value)) {
      return (this.value as CellHandle<MapValue>).get() || {};
    }
    return (this.value as MapValue) || {};
  }

  private _getCenter(): LatLng {
    let center: LatLng;
    if (isCellHandle(this.center)) {
      center = (this.center as CellHandle<LatLng>).get() || DEFAULT_CENTER;
    } else {
      center = (this.center as LatLng) || DEFAULT_CENTER;
    }
    return this._validateLatLng(center);
  }

  private _getZoom(): number {
    let zoom: number;
    if (isCellHandle(this.zoom)) {
      zoom = (this.zoom as CellHandle<number>).get() ?? DEFAULT_ZOOM;
    } else {
      zoom = (this.zoom as number) ?? DEFAULT_ZOOM;
    }
    return this._clampZoom(zoom);
  }

  private _getBounds(): Bounds | null {
    if (isCellHandle(this.bounds)) {
      return (this.bounds as CellHandle<Bounds>).get() || null;
    }
    return (this.bounds as Bounds) || null;
  }

  // === Cell Updates (bidirectional) ===

  private _updateCenterCell(center: LatLng): void {
    if (!isCellHandle(this.center)) return;

    this._isUpdatingFromCell = true;
    try {
      (this.center as CellHandle<LatLng>).set(center);
    } finally {
      this._isUpdatingFromCell = false;
    }
  }

  private _updateZoomCell(zoom: number): void {
    if (!isCellHandle(this.zoom)) return;

    this._isUpdatingFromCell = true;
    try {
      (this.zoom as CellHandle<number>).set(zoom);
    } finally {
      this._isUpdatingFromCell = false;
    }
  }

  private _updateBoundsCell(bounds: Bounds): void {
    if (!isCellHandle(this.bounds)) return;

    this._isUpdatingFromCell = true;
    try {
      (this.bounds as CellHandle<Bounds>).set(bounds);
    } finally {
      this._isUpdatingFromCell = false;
    }
  }

  // === Map Updates ===

  private _updateMapCenter(): void {
    if (!this._map) return;

    this._isUpdatingFromCell = true;
    try {
      const center = this._getCenter(); // Already validated by _getCenter()
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
      const zoom = this._getZoom(); // Already validated by _getZoom()
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

  // === Feature Rendering ===

  private _renderFeatures(): void {
    if (!this._map) return;

    const value = this._getValue();

    // Clear existing layers
    this._clearLayers();

    // Render markers - iterate directly to avoid reactive proxy deep-access issues
    // (spread operator [...arr] triggers proxy copy which accesses all properties)
    if (value.markers && value.markers.length > 0) {
      this._renderMarkers(value.markers);
    }

    // Render circles - iterate directly to avoid reactive proxy deep-access issues
    if (value.circles && value.circles.length > 0) {
      this._renderCircles(value.circles);
    }

    // Render polylines - iterate directly to avoid reactive proxy deep-access issues
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

    // Use traditional for loop to avoid reactive proxy forEach issues
    // (reactive proxies can throw when iterating over partially loaded data)
    const length = markers.length;
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

        const position = marker.position;
        if (!position) {
          this._logWarn(
            `Skipping marker at index ${index} - missing position`,
          );
          continue;
        }

        lat = position.lat;
        lng = position.lng;
        if (typeof lat !== "number" || typeof lng !== "number") {
          this._logWarn(
            `Skipping marker at index ${index} - invalid position:`,
            { lat, lng },
          );
          continue;
        }

        // Extract remaining properties
        title = marker.title;
        description = marker.description;
        icon = marker.icon;
        popup = marker.popup;
        draggable = marker.draggable;
      } catch (e) {
        // Reactive proxy threw during property access - skip this marker
        this._logWarn(
          `Skipping marker at index ${index} - error accessing properties:`,
          e,
        );
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

  private _renderCircles(circles: MapCircle[]): void {
    if (!this._circleLayer) return;

    // Use traditional for loop to avoid reactive proxy forEach issues
    const length = circles.length;
    for (let i = 0; i < length; i++) {
      const index = i;

      // Extract all circle properties within try-catch to handle reactive proxy edge cases
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

        const center = circle.center;
        if (!center) {
          this._logWarn(
            `Skipping circle at index ${index} - missing center`,
          );
          continue;
        }

        lat = center.lat;
        lng = center.lng;
        if (typeof lat !== "number" || typeof lng !== "number") {
          this._logWarn(
            `Skipping circle at index ${index} - invalid center:`,
            { lat, lng },
          );
          continue;
        }

        // Extract remaining properties
        radius = circle.radius;
        color = circle.color;
        fillOpacity = circle.fillOpacity;
        strokeWidth = circle.strokeWidth;
        popup = circle.popup;
        title = circle.title;
      } catch (e) {
        // Reactive proxy threw during property access - skip this circle
        this._logWarn(
          `Skipping circle at index ${index} - error accessing properties:`,
          e,
        );
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

  private _renderPolylines(polylines: MapPolyline[]): void {
    if (!this._polylineLayer) return;

    // Use traditional for loop to avoid reactive proxy forEach issues
    const length = polylines.length;
    for (let i = 0; i < length; i++) {
      const polyline = polylines[i];
      const index = i;

      // Skip polylines without valid points array
      if (!polyline) {
        continue;
      }

      const points = polyline.points;
      if (!points || !Array.isArray(points)) {
        this._logWarn(
          `Skipping polyline at index ${index} - invalid points:`,
          points,
        );
        continue;
      }

      const { color, strokeWidth, dashArray } = polyline;

      // Convert to Leaflet format, filtering out invalid points
      // Use traditional for loop to avoid reactive proxy issues
      const latLngs: L.LatLngExpression[] = [];
      const pointsLength = points.length;
      for (let j = 0; j < pointsLength; j++) {
        const p = points[j];
        if (p) {
          const pLat = p.lat;
          const pLng = p.lng;
          if (typeof pLat === "number" && typeof pLng === "number") {
            latLngs.push([pLat, pLng]);
          }
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

      // Add to layer
      leafletPolyline.addTo(this._polylineLayer!);
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
    const emojiRegex =
      /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{1F600}-\u{1F64F}]|[\u{1F680}-\u{1F6FF}]/u;
    return emojiRegex.test(str);
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
      this._logWarn("Invalid bounds - values must be finite numbers:", bounds);
      return null;
    }

    // Check latitude range
    if (
      north < MIN_LAT ||
      north > MAX_LAT ||
      south < MIN_LAT ||
      south > MAX_LAT
    ) {
      this._logWarn("Invalid bounds - latitude must be in [-90, 90]:", bounds);
      return null;
    }

    // Check longitude range
    if (
      east < MIN_LNG ||
      east > MAX_LNG ||
      west < MIN_LNG ||
      west > MAX_LNG
    ) {
      this._logWarn(
        "Invalid bounds - longitude must be in [-180, 180]:",
        bounds,
      );
      return null;
    }

    // Check that south <= north
    if (south > north) {
      this._logWarn("Invalid bounds - south must be <= north:", bounds);
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

    // Disconnect ResizeObserver
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }

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

    // Note: CellControllers (_centerController, _zoomController, _boundsController)
    // are automatically cleaned up by Lit's reactive controller system.
    // They implement ReactiveController with hostDisconnected() callbacks that
    // are automatically invoked when the host element disconnects.
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

globalThis.customElements.define("ct-map", CTMap);

declare global {
  interface HTMLElementTagNameMap {
    "ct-map": CTMap;
  }
}
