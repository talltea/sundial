/* ================================================
   Sundial – radar.js
   ================================================ */

const Radar = {

  // ---- State ---------------------------------
  map: null,
  radarFrames: [],   // { time, url } for each frame
  activeLayer: null,
  currentFrame: 0,
  playing: false,
  playInterval: null,

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
      zip:       document.getElementById("radar-zip"),
      goBtn:     document.getElementById("radar-go-btn"),
      prevBtn:   document.getElementById("radar-prev"),
      playBtn:   document.getElementById("radar-play"),
      nextBtn:   document.getElementById("radar-next"),
      timestamp: document.getElementById("radar-timestamp"),
      error:     document.getElementById("radar-error"),
      errorText: document.getElementById("radar-error-text"),
    };
  },

  bind() {
    this.el.goBtn.addEventListener("click", () => this.goToZip());
    this.el.zip.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.goToZip();
    });
    this.el.prevBtn.addEventListener("click", () => this.stepFrame(-1));
    this.el.nextBtn.addEventListener("click", () => this.stepFrame(1));
    this.el.playBtn.addEventListener("click", () => this.togglePlay());
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

      // Clear existing layer
      if (this.activeLayer) {
        this.map.removeLayer(this.activeLayer);
        this.activeLayer = null;
      }
      this.radarFrames = [];

      // Past frames + nowcast
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

      // Show the last past frame by default
      const lastPastIdx = (data.radar?.past?.length || 1) - 1;
      this.currentFrame = Math.min(lastPastIdx, this.radarFrames.length - 1);
      this.showFrame(this.currentFrame);
    } catch (err) {
      this.el.timestamp.textContent = "Radar unavailable";
      console.warn("Radar load error:", err);
    }
  },

  showFrame(idx) {
    const frame = this.radarFrames[idx];
    if (!frame) return;

    const oldLayer = this.activeLayer;
    const newLayer = L.tileLayer(frame.url, {
      opacity: 0,
      zIndex: 5,
      maxNativeZoom: 7,
      maxZoom: 7,
    });
    newLayer.addTo(this.map);

    newLayer.once("load", () => {
      newLayer.setOpacity(0.6);
      if (oldLayer) this.map.removeLayer(oldLayer);
    });

    this.activeLayer = newLayer;
    this.currentFrame = idx;
    this.updateTimestamp();
  },

  updateTimestamp() {
    const frame = this.radarFrames[this.currentFrame];
    if (!frame) return;
    const d = new Date(frame.time * 1000);
    this.el.timestamp.textContent = d.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  },

  /* ==============================================
     Playback controls
     ============================================== */

  stepFrame(dir) {
    if (!this.radarFrames.length) return;
    let next = this.currentFrame + dir;
    if (next < 0) next = this.radarFrames.length - 1;
    if (next >= this.radarFrames.length) next = 0;
    this.showFrame(next);
  },

  togglePlay() {
    if (this.playing) {
      this.stopPlay();
    } else {
      this.playing = true;
      this.el.playBtn.textContent = "⏸";
      this.el.playBtn.classList.add("active");
      this.playInterval = setInterval(() => this.stepFrame(1), 800);
    }
  },

  stopPlay() {
    this.playing = false;
    this.el.playBtn.textContent = "▶";
    this.el.playBtn.classList.remove("active");
    clearInterval(this.playInterval);
    this.playInterval = null;
  },

  /* ==============================================
     UI helpers
     ============================================== */

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
