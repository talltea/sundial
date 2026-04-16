/* ================================================
   Sundial – tides.js
   ================================================ */

const Tides = {

  // ---- Config ----------------------------------
  GEOCODE_URL: "https://nominatim.openstreetmap.org/search",
  STATIONS_URL: "https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=tidepredictions&units=english",
  PREDICTIONS_URL: "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter",
  MAX_STATION_DISTANCE_MI: 50,

  // ---- State -----------------------------------
  stations: null,
  currentStation: null,
  currentLocation: null,
  days: 2,
  chart: null,

  el: {},

  /* ==============================================
     Lifecycle
     ============================================== */

  init() {
    this.configChartDefaults();
    this.cacheDOM();
    this.bind();
    this.restoreSession();
  },

  configChartDefaults() {
    Chart.defaults.color = "#9fa8c7";
    Chart.defaults.borderColor = "rgba(42, 58, 92, 0.4)";
    Chart.defaults.font.family =
      "'Segoe UI', system-ui, -apple-system, sans-serif";
    Chart.defaults.font.size = 12;
  },

  cacheDOM() {
    this.el = {
      form:         document.getElementById("tides-form"),
      zip:          document.getElementById("tides-zip"),
      stationInfo:  document.getElementById("tides-station-info"),
      stationName:  document.getElementById("tides-station-name"),
      stationDist:  document.getElementById("tides-station-distance"),
      pills:        document.getElementById("tides-pills"),
      error:        document.getElementById("tides-error"),
      errorText:    document.getElementById("tides-error-text"),
      loading:      document.getElementById("tides-loading"),
      charts:       document.getElementById("tides-charts"),
      hiloBody:     document.getElementById("hilo-body"),
    };
  },

  bind() {
    this.el.form.addEventListener("submit", (e) => {
      e.preventDefault();
      this.search();
    });

    this.el.pills.querySelectorAll(".pill").forEach((pill) =>
      pill.addEventListener("click", () => this.pickDays(pill))
    );
  },

  restoreSession() {
    const saved = localStorage.getItem("sundial_tides");
    if (!saved) return;
    try {
      const data = JSON.parse(saved);
      this.el.zip.value = data.zip || "";
      if (data.zip) this.search();
    } catch (e) {
      console.warn("Failed to restore tides session:", e);
    }
  },

  /* ==============================================
     Geocoding
     ============================================== */

  async geocode(zip) {
    const url =
      `${this.GEOCODE_URL}?postalcode=${zip}&country=us&format=json&limit=1`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("Geocoding request failed");
    const data = await res.json();
    if (!data.length) throw new Error("ZIP code not found");
    const place = data[0];
    return {
      lat: parseFloat(place.lat),
      lon: parseFloat(place.lon),
      name: place.display_name.split(",").slice(0, 3).join(",").trim(),
      zip,
    };
  },

  /* ==============================================
     Station finding
     ============================================== */

  async loadStations() {
    if (this.stations) return this.stations;
    const res = await fetch(this.STATIONS_URL);
    if (!res.ok) throw new Error("Failed to load tide stations");
    const data = await res.json();
    this.stations = data.stations;
    return this.stations;
  },

  findNearestStation(lat, lon) {
    let best = null;
    let bestDist = Infinity;

    for (const s of this.stations) {
      const d = this.haversine(lat, lon, s.lat, s.lng);
      if (d < bestDist) {
        bestDist = d;
        best = s;
      }
    }

    return { station: best, distanceMi: bestDist };
  },

  haversine(lat1, lon1, lat2, lon2) {
    const R = 3958.8; // Earth radius in miles
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  },

  /* ==============================================
     NOAA predictions
     ============================================== */

  dateStr(d) {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}${mm}${dd}`;
  },

  async fetchPredictions(stationId, days) {
    const begin = new Date();
    const end = new Date();
    end.setDate(end.getDate() + days);

    const base = this.PREDICTIONS_URL;
    const params = new URLSearchParams({
      begin_date: this.dateStr(begin),
      end_date: this.dateStr(end),
      station: stationId,
      product: "predictions",
      datum: "MLLW",
      time_zone: "lst_ldt",
      units: "english",
      format: "json",
      interval: "6",
    });

    const res = await fetch(`${base}?${params}`);
    if (!res.ok) throw new Error("Failed to fetch tide predictions");
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || "NOAA API error");
    return data.predictions || [];
  },

  async fetchHiLo(stationId, days) {
    const begin = new Date();
    const end = new Date();
    end.setDate(end.getDate() + days);

    const params = new URLSearchParams({
      begin_date: this.dateStr(begin),
      end_date: this.dateStr(end),
      station: stationId,
      product: "predictions",
      datum: "MLLW",
      time_zone: "lst_ldt",
      units: "english",
      format: "json",
      interval: "hilo",
    });

    const res = await fetch(`${this.PREDICTIONS_URL}?${params}`);
    if (!res.ok) throw new Error("Failed to fetch hi/lo data");
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || "NOAA API error");
    return data.predictions || [];
  },

  /* ==============================================
     Main flow
     ============================================== */

  async search() {
    const zip = this.el.zip.value.trim();
    if (!/^\d{5}$/.test(zip)) {
      this.showError("Please enter a valid 5-digit ZIP code");
      return;
    }

    this.hideError();
    this.showLoading();

    try {
      const [location, _] = await Promise.all([
        this.geocode(zip),
        this.loadStations(),
      ]);

      this.currentLocation = location;

      const { station, distanceMi } = this.findNearestStation(
        location.lat,
        location.lon
      );

      if (!station || distanceMi > this.MAX_STATION_DISTANCE_MI) {
        this.hideLoading();
        this.showError(
          `No tide station found within ${this.MAX_STATION_DISTANCE_MI} miles of this ZIP code. ` +
          `Tide data is only available for coastal locations.`
        );
        this.el.stationInfo.classList.add("hidden");
        this.el.pills.classList.add("hidden");
        this.el.charts.classList.add("hidden");
        return;
      }

      this.currentStation = station;

      this.el.stationName.textContent = `${station.name}`;
      this.el.stationDist.textContent =
        `Station ${station.id} · ${distanceMi.toFixed(1)} mi from ${location.name.split(",")[0]}`;
      this.el.stationInfo.classList.remove("hidden");
      this.el.pills.classList.remove("hidden");

      localStorage.setItem("sundial_tides", JSON.stringify({ zip }));

      await this.loadTides();
    } catch (err) {
      this.hideLoading();
      this.showError(err.message);
    }
  },

  pickDays(pill) {
    this.el.pills.querySelectorAll(".pill").forEach((p) =>
      p.classList.remove("active")
    );
    pill.classList.add("active");
    this.days = parseInt(pill.dataset.days);
    this.loadTides();
  },

  async loadTides() {
    this.hideError();
    this.showLoading();

    try {
      const [predictions, hilo] = await Promise.all([
        this.fetchPredictions(this.currentStation.id, this.days),
        this.fetchHiLo(this.currentStation.id, this.days),
      ]);

      this.renderChart(predictions, hilo);
      this.renderTable(hilo);

      this.hideLoading();
      this.el.charts.classList.remove("hidden");
    } catch (err) {
      this.hideLoading();
      this.showError(err.message);
    }
  },

  /* ==============================================
     Rendering
     ============================================== */

  renderChart(predictions, hilo) {
    if (this.chart) {
      this.chart.destroy();
      this.chart = null;
    }

    const labels = predictions.map((p) => p.t);
    const values = predictions.map((p) => parseFloat(p.v));

    const hiloMap = new Map(hilo.map((h) => [h.t, h]));

    const datasets = [
      {
        label: "Water Level",
        data: values,
        borderColor: "#64b5f6",
        backgroundColor: "rgba(100, 181, 246, 0.08)",
        fill: true,
        tension: 0.4,
        pointRadius: 0,
      },
    ];

    const self = this;
    this.chart = new Chart(document.getElementById("chart-tides"), {
      type: "line",
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title(items) {
                const raw = items[0]?.label;
                if (!raw) return "";
                const d = new Date(raw);
                return d.toLocaleString("en-US", {
                  weekday: "short",
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                });
              },
              label(ctx) {
                const ft = ctx.parsed.y;
                const label = ft != null ? `${ft.toFixed(2)} ft` : "--";
                const raw = ctx.label;
                const h = hiloMap.get(raw);
                if (h) {
                  const tag = h.type === "H" ? "High" : "Low";
                  return `${tag} Tide: ${label}`;
                }
                return `Water Level: ${label}`;
              },
            },
          },
        },
        scales: {
          x: {
            ticks: {
              maxRotation: 0,
              autoSkip: true,
              maxTicksLimit: 8,
              callback(val) {
                const raw = this.getLabelForValue(val);
                const d = new Date(raw);
                const h = d.getHours();
                if (h === 0) {
                  return d.toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                  });
                }
                return d.toLocaleTimeString("en-US", {
                  hour: "numeric",
                  minute: "2-digit",
                });
              },
            },
            grid: { display: false },
          },
          y: {
            ticks: {
              callback: (v) => `${v} ft`,
            },
          },
        },
      },
    });
  },

  renderTable(hilo) {
    const tbody = this.el.hiloBody;
    tbody.innerHTML = "";

    hilo.forEach((h) => {
      const d = new Date(h.t);
      const dateStr = d.toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
      });
      const timeStr = d.toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
      });
      const isHigh = h.type === "H";

      const tr = document.createElement("tr");
      tr.innerHTML =
        `<td>${dateStr}</td>` +
        `<td>${timeStr}</td>` +
        `<td class="${isHigh ? "type-high" : "type-low"}">${isHigh ? "High" : "Low"}</td>` +
        `<td>${parseFloat(h.v).toFixed(2)}</td>`;
      tbody.appendChild(tr);
    });
  },

  /* ==============================================
     UI helpers
     ============================================== */

  showLoading() {
    this.el.charts.classList.add("hidden");
    this.el.loading.classList.remove("hidden");
  },

  hideLoading() {
    this.el.loading.classList.add("hidden");
  },

  showError(msg) {
    this.el.error.classList.remove("hidden");
    this.el.errorText.textContent = msg;
    this.hideLoading();
  },

  hideError() {
    this.el.error.classList.add("hidden");
  },
};

/* ---- Boot ------------------------------------ */
document.addEventListener("DOMContentLoaded", () => Tides.init());
