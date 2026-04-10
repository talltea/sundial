/* ================================================
   Sundial – radar.js
   ================================================ */

const Radar = {

  // ---- State ---------------------------------
  map: null,
  radarFrames: [],     // { time, url }
  layerCache: {},      // idx -> L.tileLayer (preloaded, not on map)
  activeLayer: null,
  activeIdx: -1,
  currentFrame: 0,
  playing: false,
  playInterval: null,
  dragging: false,
  dragDebounce: null,

  MAX_CACHED_LAYERS: 5,

  GEOCODE_URL: "https://nominatim.openstreetmap.org/search",
  RAINVIEWER_URL: "https://api.rainviewer.com/public/weather-maps.json",

  DEFAULT_LAT: 39.8283,
  DEFAULT_LON: -98.5795,
  DEFAULT_ZOOM: 5,
  LOCATION_ZOOM: 7,

  // ---- DOM refs ------------------------------
  el: {},

  /* ==============================================
     Lifecycle
     ============================================== */

  init() {
    this.cacheDOM();
    this.bind();
    this.initMap();
    this.loadRadarFrames();
    this.restoreLocation();
  },

  cacheDOM() {
    this.el = {
      zip:        document.getElementById("radar-zip"),
      goBtn:      document.getElementById("radar-go-btn"),
      playBtn:    document.getElementById("radar-play-btn"),
      slider:     document.getElementById("radar-slider"),
      timestamp:  document.getElementById("radar-timestamp"),
      timeStart:  document.getElementById("radar-time-start"),
      timeEnd:    document.getElementById("radar-time-end"),
      error:      document.getElementById("radar-error"),
      errorText:  document.getElementById("radar-error-text"),
    };
  },

  bind() {
    this.el.goBtn.addEventListener("click", () => this.goToZip());
    this.el.zip.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.goToZip();
    });
    this.el.playBtn.addEventListener("click", () => this.togglePlay());

    // Slider: debounce during drag to avoid flooding requests
    this.el.slider.addEventListener("input", () => {
      this.dragging = true;
      this.updateTimestamp(parseInt(this.el.slider.value));
      clearTimeout(this.dragDebounce);
      this.dragDebounce = setTimeout(() => {
        this.showFrame(parseInt(this.el.slider.value));
      }, 150);
    });

    this.el.slider.addEventListener("change", () => {
      this.dragging = false;
      clearTimeout(this.dragDebounce);
      this.showFrame(parseInt(this.el.slider.value));
    });
  },

  initMap() {
    this.map = L.map("radar-map", {
      center: [this.DEFAULT_LAT, this.DEFAULT_LON],
      zoom: this.DEFAULT_ZOOM,
      zoomControl: true,
      maxZoom: 7,
    });

    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
      subdomains: "abcd",
      maxZoom: 7,
    }).addTo(this.map);

    // Evict cached layers when zoom/pan changes (tiles no longer valid)
    this.map.on("zoomend moveend", () => this.evictAllCached());
  },

  restoreLocation() {
    const saved = localStorage.getItem("sundial_primary");
    if (!saved) return;
    try {
      const p = JSON.parse(saved);
      if (p.location?.lat && p.location?.lon) {
        this.map.setView([p.location.lat, p.location.lon], this.LOCATION_ZOOM);
        if (p.location.zip) this.el.zip.value = p.location.zip;
      }
    } catch (e) {
      // ignore
    }
  },

  /* ==============================================
     Geocoding
     ============================================== */

  async geocode(zip) {
    const url = `${this.GEOCODE_URL}?postalcode=${zip}&country=us&format=json&limit=1`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("Geocoding request failed");
    const data = await res.json();
    if (!data.length) throw new Error("ZIP code not found");
    return {
      lat: parseFloat(data[0].lat),
      lon: parseFloat(data[0].lon),
    };
  },

  async goToZip() {
    const zip = this.el.zip.value.trim();
    if (!/^\d{5}$/.test(zip)) {
      this.showError("Please enter a valid 5-digit ZIP code");
      return;
    }
    this.hideError();
    try {
      const loc = await this.geocode(zip);
      this.map.setView([loc.lat, loc.lon], this.LOCATION_ZOOM);
    } catch (err) {
      this.showError(err.message);
    }
  },

  /* ==============================================
     RainViewer radar frames
     ============================================== */

  async loadRadarFrames() {
    try {
      const res = await fetch(this.RAINVIEWER_URL);
      if (!res.ok) throw new Error("Failed to load radar data");
      const data = await res.json();

      // Clear existing
      if (this.activeLayer) {
        this.map.removeLayer(this.activeLayer);
        this.activeLayer = null;
        this.activeIdx = -1;
      }
      this.evictAllCached();
      this.radarFrames = [];

      const frames = [
        ...(data.radar?.past || []),
        ...(data.radar?.nowcast || []),
      ];

      if (!frames.length) {
        this.el.timestamp.textContent = "No radar data available";
        return;
      }

      this.radarFrames = frames.map((frame) => ({
        time: frame.time,
        url: `${data.host}${frame.path}/256/{z}/{x}/{y}/2/1_1.png`,
      }));

      // Configure slider
      const maxIdx = this.radarFrames.length - 1;
      this.el.slider.min = 0;
      this.el.slider.max = maxIdx;

      // Show range labels
      this.el.timeStart.textContent = this.formatTime(this.radarFrames[0].time);
      this.el.timeEnd.textContent = this.formatTime(this.radarFrames[maxIdx].time);

      // Default to last past frame
      const lastPastIdx = (data.radar?.past?.length || 1) - 1;
      const startIdx = Math.min(lastPastIdx, maxIdx);
      this.el.slider.value = startIdx;
      this.showFrame(startIdx);
    } catch (err) {
      this.el.timestamp.textContent = "Radar unavailable";
      console.warn("Radar load error:", err);
    }
  },

  /* ==============================================
     Frame display & caching
     ============================================== */

  makeLayer(idx) {
    const frame = this.radarFrames[idx];
    if (!frame) return null;
    return L.tileLayer(frame.url, {
      opacity: 0,
      zIndex: 5,
      maxNativeZoom: 7,
      maxZoom: 7,
    });
  },

  showFrame(idx) {
    if (idx === this.activeIdx) return;
    const frame = this.radarFrames[idx];
    if (!frame) return;

    const oldLayer = this.activeLayer;
    const oldIdx = this.activeIdx;

    // Use cached layer if available, otherwise create new
    let newLayer = this.layerCache[idx];
    let wasCached = !!newLayer;
    if (!newLayer) {
      newLayer = this.makeLayer(idx);
    } else {
      delete this.layerCache[idx]; // take ownership
    }

    newLayer.addTo(this.map);

    const reveal = () => {
      newLayer.setOpacity(0.6);
      if (oldLayer) this.map.removeLayer(oldLayer);
    };

    if (wasCached) {
      // Already has tiles loaded, show immediately
      reveal();
    } else {
      newLayer.once("load", reveal);
    }

    this.activeLayer = newLayer;
    this.activeIdx = idx;
    this.currentFrame = idx;
    this.el.slider.value = idx;
    this.updateTimestamp(idx);

    // Preload neighbors (1 ahead, 1 behind)
    this.preloadFrame(idx + 1);
    this.preloadFrame(idx - 1);

    // Trim cache
    this.trimCache(idx);
  },

  preloadFrame(idx) {
    if (idx < 0 || idx >= this.radarFrames.length) return;
    if (idx === this.activeIdx) return;
    if (this.layerCache[idx]) return; // already cached

    const layer = this.makeLayer(idx);
    // Add briefly to trigger tile loading, then remove from map
    // but keep the layer object so tiles stay in browser cache
    layer.addTo(this.map);
    layer.once("load", () => {
      this.map.removeLayer(layer);
    });
    this.layerCache[idx] = layer;
  },

  trimCache(currentIdx) {
    const keys = Object.keys(this.layerCache).map(Number);
    if (keys.length <= this.MAX_CACHED_LAYERS) return;

    // Evict farthest from current
    keys.sort((a, b) => Math.abs(a - currentIdx) - Math.abs(b - currentIdx));
    const toEvict = keys.slice(this.MAX_CACHED_LAYERS);
    toEvict.forEach((k) => {
      const layer = this.layerCache[k];
      if (layer) this.map.removeLayer(layer);
      delete this.layerCache[k];
    });
  },

  evictAllCached() {
    Object.keys(this.layerCache).forEach((k) => {
      const layer = this.layerCache[k];
      if (layer) this.map.removeLayer(layer);
      delete this.layerCache[k];
    });
  },

  /* ==============================================
     Playback
     ============================================== */

  togglePlay() {
    if (this.playing) {
      this.stopPlay();
    } else {
      this.playing = true;
      this.el.playBtn.innerHTML = "&#9646;&#9646;"; // pause icon
      this.el.playBtn.classList.add("active");
      this.playInterval = setInterval(() => {
        let next = this.currentFrame + 1;
        if (next >= this.radarFrames.length) next = 0;
        this.showFrame(next);
      }, 1000);
    }
  },

  stopPlay() {
    this.playing = false;
    this.el.playBtn.innerHTML = "&#9654;"; // play icon
    this.el.playBtn.classList.remove("active");
    clearInterval(this.playInterval);
    this.playInterval = null;
  },

  /* ==============================================
     UI helpers
     ============================================== */

  updateTimestamp(idx) {
    const frame = this.radarFrames[idx];
    if (!frame) return;
    this.el.timestamp.textContent = this.formatTime(frame.time);
  },

  formatTime(unix) {
    const d = new Date(unix * 1000);
    return d.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  },

  showError(msg) {
    this.el.error.classList.remove("hidden");
    this.el.errorText.textContent = msg;
  },

  hideError() {
    this.el.error.classList.add("hidden");
  },
};

/* ---- Boot ------------------------------------ */
document.addEventListener("DOMContentLoaded", () => Radar.init());
