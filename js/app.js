/* ================================================
   Sundial – app.js
   ================================================ */

const Sundial = {

  // ---- State ---------------------------------
  location: null,
  currentDays: 7,
  charts: [],

  // ---- API URLs ------------------------------
  GEOCODE_URL: "https://nominatim.openstreetmap.org/search",
  FORECAST_URL: "https://api.open-meteo.com/v1/forecast",
  ARCHIVE_URL: "https://archive-api.open-meteo.com/v1/archive",

  // ---- Shared query fragments ----------------
  DAILY_PARAMS: [
    "weather_code",
    "temperature_2m_max",
    "temperature_2m_min",
    "apparent_temperature_max",
    "apparent_temperature_min",
    "precipitation_sum",
    "wind_speed_10m_max",
    "wind_gusts_10m_max",
    "wind_direction_10m_dominant",
    "uv_index_max",
    "sunrise",
    "sunset",
  ].join(","),

  HOURLY_PARAMS: "pressure_msl,relative_humidity_2m,cloud_cover",

  UNIT_PARAMS:
    "temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch",

  // ---- DOM refs (filled in init) -------------
  el: {},

  /* ==============================================
     Lifecycle
     ============================================== */

  init() {
    this.configChartDefaults();
    this.cacheDOM();
    this.bind();
    this.registerSW();
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
      form:            document.getElementById("search-form"),
      zip:             document.getElementById("zipcode"),
      searchBtn:       document.getElementById("search-btn"),
      btnText:         document.querySelector(".btn-text"),
      btnLoading:      document.querySelector(".btn-loading"),
      locationInfo:    document.getElementById("location-info"),
      locationName:    document.getElementById("location-name"),
      pills:           document.querySelectorAll(".pill"),
      customRange:     document.getElementById("custom-range"),
      startDate:       document.getElementById("start-date"),
      endDate:         document.getElementById("end-date"),
      customSearchBtn: document.getElementById("custom-search-btn"),
      error:           document.getElementById("error-message"),
      errorText:       document.getElementById("error-text"),
      charts:          document.getElementById("charts"),
      loading:         document.getElementById("loading"),
    };
  },

  bind() {
    this.el.form.addEventListener("submit", (e) => {
      e.preventDefault();
      this.search();
    });

    this.el.pills.forEach((pill) =>
      pill.addEventListener("click", () => this.pickRange(pill))
    );

    this.el.customSearchBtn.addEventListener("click", () =>
      this.searchCustomRange()
    );
  },

  async registerSW() {
    if ("serviceWorker" in navigator) {
      try {
        await navigator.serviceWorker.register("./sw.js");
      } catch (e) {
        console.warn("SW registration failed:", e);
      }
    }
  },

  restoreSession() {
    const saved = localStorage.getItem("sundial_location");
    if (!saved) return;
    this.location = JSON.parse(saved);
    this.el.zip.value = this.location.zip || "";
    this.showLocation();
    this.fetchWeather(this.currentDays);
  },

  /* ==============================================
     Geocoding  (Nominatim)
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
      lat:  parseFloat(place.lat),
      lon:  parseFloat(place.lon),
      name: place.display_name.split(",").slice(0, 3).join(",").trim(),
      zip,
    };
  },

  /* ==============================================
     Weather data  (Open-Meteo)
     ============================================== */

  buildURL(startDate, endDate) {
    const { lat, lon } = this.location;
    const msPerDay = 86_400_000;
    const daysAgo = Math.ceil(
      (Date.now() - new Date(startDate).getTime()) / msPerDay
    );

    const base =
      daysAgo <= 90 ? this.FORECAST_URL : this.ARCHIVE_URL;

    return (
      `${base}?latitude=${lat}&longitude=${lon}` +
      `&start_date=${startDate}&end_date=${endDate}` +
      `&daily=${this.DAILY_PARAMS}&hourly=${this.HOURLY_PARAMS}` +
      `&${this.UNIT_PARAMS}&timezone=auto`
    );
  },

  async fetchWeather(days) {
    if (!this.location) return;

    this.hideError();
    this.showLoading();

    try {
      const end = new Date();
      end.setDate(end.getDate() - 1);
      const start = new Date(end);
      start.setDate(start.getDate() - (days - 1));

      const url = this.buildURL(this.dateStr(start), this.dateStr(end));
      const data = await this.fetchJSON(url);
      this.render(data);
    } catch (err) {
      this.hideLoading();
      this.showError(err.message);
    }
  },

  async fetchRange(startDate, endDate) {
    if (!this.location) return;

    this.hideError();
    this.showLoading();

    try {
      const url = this.buildURL(startDate, endDate);
      const data = await this.fetchJSON(url);
      this.render(data);
    } catch (err) {
      this.hideLoading();
      this.showError(err.message);
    }
  },

  async fetchJSON(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error("Weather request failed");
    const data = await res.json();
    if (data.error) throw new Error(data.reason || "API error");
    return data;
  },

  /* ==============================================
     Rendering (Charts)
     ============================================== */

  render(data) {
    const { daily, hourly } = data;
    if (!daily?.time?.length) {
      this.hideLoading();
      this.showError("No weather data for this period");
      return;
    }

    // Tear down old charts
    this.charts.forEach((c) => c.destroy());
    this.charts = [];

    // Hourly → daily averages
    const pressure = this.dailyAverages(
      daily.time, hourly?.time, hourly?.pressure_msl
    );
    const humidity = this.dailyAverages(
      daily.time, hourly?.time, hourly?.relative_humidity_2m
    );
    const clouds = this.dailyAverages(
      daily.time, hourly?.time, hourly?.cloud_cover
    );

    // X-axis labels
    const labels = daily.time.map((d) => {
      const date = new Date(d + "T12:00:00");
      const md = `${date.getMonth() + 1}/${date.getDate()}`;
      if (daily.time.length <= 10) {
        const day = date.toLocaleDateString("en-US", { weekday: "short" });
        return `${day} ${md}`;
      }
      return md;
    });

    // ---- Temperature ----------------------------
    this.charts.push(
      this.makeChart("chart-temp", "line", labels, [
        {
          label: "High",
          data: daily.temperature_2m_max,
          borderColor: "#f0a848",
          backgroundColor: "rgba(240, 168, 72, 0.12)",
          fill: "+1",
          tension: 0.35,
          pointRadius: 3,
        },
        {
          label: "Low",
          data: daily.temperature_2m_min,
          borderColor: "#64b5f6",
          fill: false,
          tension: 0.35,
          pointRadius: 3,
        },
      ], this.chartOpts({ ySuffix: "°", legend: true }))
    );

    // ---- UV Index --------------------------------
    this.charts.push(
      this.makeChart("chart-uv", "bar", labels, [
        {
          label: "UV Index",
          data: daily.uv_index_max,
          backgroundColor: daily.uv_index_max.map((v) => this.uvColor(v)),
          borderRadius: 4,
        },
      ], this.chartOpts({ yMin: 0 }))
    );

    // ---- Pressure --------------------------------
    this.charts.push(
      this.makeChart("chart-pressure", "line", labels, [
        {
          label: "Pressure",
          data: pressure,
          borderColor: "#ab94e4",
          backgroundColor: "rgba(171, 148, 228, 0.1)",
          fill: true,
          tension: 0.35,
          pointRadius: 3,
        },
      ], this.chartOpts({ ySuffix: " hPa" }))
    );

    // ---- Precipitation ---------------------------
    this.charts.push(
      this.makeChart("chart-precip", "bar", labels, [
        {
          label: "Precipitation",
          data: daily.precipitation_sum,
          backgroundColor: "rgba(100, 181, 246, 0.6)",
          borderRadius: 4,
        },
      ], this.chartOpts({ ySuffix: '"', yMin: 0 }))
    );

    // ---- Humidity & Cloud Cover ------------------
    this.charts.push(
      this.makeChart("chart-humidity", "line", labels, [
        {
          label: "Humidity",
          data: humidity,
          borderColor: "#4fc3f7",
          tension: 0.35,
          pointRadius: 2,
        },
        {
          label: "Cloud Cover",
          data: clouds,
          borderColor: "#78909c",
          borderDash: [4, 4],
          tension: 0.35,
          pointRadius: 2,
        },
      ], this.chartOpts({ ySuffix: "%", yMin: 0, yMax: 100, legend: true }))
    );

    // ---- Wind ------------------------------------
    this.charts.push(
      this.makeChart("chart-wind", "line", labels, [
        {
          label: "Speed",
          data: daily.wind_speed_10m_max,
          borderColor: "#81c784",
          tension: 0.35,
          pointRadius: 3,
        },
        {
          label: "Gusts",
          data: daily.wind_gusts_10m_max,
          borderColor: "rgba(129, 199, 132, 0.4)",
          borderDash: [4, 4],
          tension: 0.35,
          pointRadius: 2,
        },
      ], this.chartOpts({ ySuffix: " mph", yMin: 0, legend: true }))
    );

    // Show
    this.hideLoading();
    this.el.charts.classList.remove("hidden");
  },

  /* ==============================================
     Chart helpers
     ============================================== */

  makeChart(canvasId, type, labels, datasets, options) {
    return new Chart(document.getElementById(canvasId), {
      type,
      data: { labels, datasets },
      options,
    });
  },

  chartOpts({ ySuffix = "", yMin, yMax, legend = false } = {}) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          display: legend,
          labels: { boxWidth: 12, usePointStyle: true },
        },
        tooltip: {
          callbacks: {
            label(ctx) {
              const v = ctx.parsed.y;
              return `${ctx.dataset.label}: ${
                v != null ? v.toFixed(1) : "--"
              }${ySuffix}`;
            },
          },
        },
      },
      scales: {
        x: {
          ticks: { maxRotation: 0 },
          grid: { display: false },
        },
        y: {
          min: yMin,
          max: yMax,
          ticks: {
            callback: (v) => `${v}${ySuffix}`,
          },
        },
      },
    };
  },

  uvColor(v) {
    if (v == null) return "#5c6788";
    if (v < 3)    return "#4caf50";
    if (v < 6)    return "#f0d94e";
    if (v < 8)    return "#ff9800";
    if (v < 11)   return "#f44336";
    return "#9c27b0";
  },

  /* ==============================================
     Event handlers
     ============================================== */

  async search() {
    const zip = this.el.zip.value.trim();
    if (!/^\d{5}$/.test(zip)) {
      this.showError("Please enter a valid 5-digit ZIP code");
      return;
    }

    this.setLoading(true);
    this.hideError();

    try {
      this.location = await this.geocode(zip);
      localStorage.setItem(
        "sundial_location",
        JSON.stringify(this.location)
      );
      this.showLocation();
      await this.fetchWeather(this.currentDays);
    } catch (err) {
      this.showError(err.message);
    } finally {
      this.setLoading(false);
    }
  },

  pickRange(pill) {
    this.el.pills.forEach((p) => p.classList.remove("active"));
    pill.classList.add("active");

    const val = pill.dataset.days;

    if (val === "custom") {
      this.el.customRange.classList.remove("hidden");
      const today = new Date();
      const weekAgo = new Date();
      weekAgo.setDate(today.getDate() - 7);
      this.el.endDate.value = this.dateStr(today);
      this.el.endDate.max = this.dateStr(today);
      this.el.startDate.value = this.dateStr(weekAgo);
      return;
    }

    this.el.customRange.classList.add("hidden");
    this.currentDays = parseInt(val);
    this.fetchWeather(this.currentDays);
  },

  searchCustomRange() {
    const s = this.el.startDate.value;
    const e = this.el.endDate.value;
    if (!s || !e) return this.showError("Please pick both dates");
    if (s > e)    return this.showError("Start date must be before end date");
    this.fetchRange(s, e);
  },

  /* ==============================================
     UI helpers
     ============================================== */

  setLoading(on) {
    this.el.searchBtn.disabled = on;
    this.el.btnText.classList.toggle("hidden", on);
    this.el.btnLoading.classList.toggle("hidden", !on);
  },

  showLocation() {
    this.el.locationInfo.classList.remove("hidden");
    this.el.locationName.textContent = `📍 ${this.location.name}`;
  },

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
    this.el.charts.classList.add("hidden");
  },

  hideError() {
    this.el.error.classList.add("hidden");
  },

  /* ==============================================
     Pure helpers
     ============================================== */

  dailyAverages(dailyDates, hourlyTimes, hourlyVals) {
    if (!hourlyTimes || !hourlyVals) return dailyDates.map(() => null);

    return dailyDates.map((date) => {
      let sum = 0;
      let n = 0;
      for (let i = 0; i < hourlyTimes.length; i++) {
        if (hourlyTimes[i].startsWith(date) && hourlyVals[i] != null) {
          sum += hourlyVals[i];
          n++;
        }
      }
      return n ? sum / n : null;
    });
  },

  dateStr(d) {
    return d.toISOString().split("T")[0];
  },

  compass(deg) {
    if (deg == null) return "";
    const dirs = [
      "N","NNE","NE","ENE","E","ESE","SE","SSE",
      "S","SSW","SW","WSW","W","WNW","NW","NNW",
    ];
    return dirs[Math.round(deg / 22.5) % 16];
  },
};

/* ---- Boot ------------------------------------ */
document.addEventListener("DOMContentLoaded", () => Sundial.init());
