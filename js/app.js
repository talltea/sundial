/* ================================================
   Sundial – app.js
   ================================================ */

const Sundial = {

  // ---- State ---------------------------------
  series: [],        // list of series (primary + comparisons)
  nextId: 1,
  charts: [],

  MAX_SERIES: 4,

  // Color palette for series (index 0 = primary)
  SERIES_COLORS: [
    { line: "#f0a848", fill: "rgba(240, 168, 72, 0.15)" }, // amber
    { line: "#64b5f6", fill: "rgba(100, 181, 246, 0.15)" },// blue
    { line: "#81c784", fill: "rgba(129, 199, 132, 0.15)" },// green
    { line: "#ba68c8", fill: "rgba(186, 104, 200, 0.15)" },// purple
  ],

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
      comparison:      document.getElementById("comparison-section"),
      seriesChips:     document.getElementById("series-chips"),
      toggleAddBtn:    document.getElementById("toggle-add-btn"),
      addForm:         document.getElementById("add-comparison-form"),
      cmpZip:          document.getElementById("cmp-zip"),
      cmpStart:        document.getElementById("cmp-start"),
      cmpEnd:          document.getElementById("cmp-end"),
      cmpAddBtn:       document.getElementById("cmp-add-btn"),
      cmpCancelBtn:    document.getElementById("cmp-cancel-btn"),
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

    this.el.toggleAddBtn.addEventListener("click", () =>
      this.toggleAddForm(true)
    );
    this.el.cmpCancelBtn.addEventListener("click", () =>
      this.toggleAddForm(false)
    );
    this.el.cmpAddBtn.addEventListener("click", () => this.addComparison());
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
    const saved = localStorage.getItem("sundial_primary");
    if (saved) {
      try {
        const p = JSON.parse(saved);
        this.series = [this.newSeries({
          isPrimary: true,
          location: p.location,
          days: p.days ?? 7,
          start: p.start,
          end: p.end,
        })];
        this.el.zip.value = p.location.zip || "";
        this.activatePillForDays(p.days);
        this.showLocation();
        this.el.comparison.classList.remove("hidden");
        this.renderChips();
        this.fetchSeriesData(this.series[0])
          .then(() => this.renderCharts())
          .catch((err) => this.showError(err.message));
        return;
      } catch (e) {
        console.warn("Failed to restore session:", e);
      }
    }

    // Legacy format: just {location}
    const legacy = localStorage.getItem("sundial_location");
    if (!legacy) return;
    try {
      const location = JSON.parse(legacy);
      const { start, end } = this.daysToRange(7);
      this.series = [this.newSeries({
        isPrimary: true,
        location,
        days: 7,
        start,
        end,
      })];
      this.el.zip.value = location.zip || "";
      this.showLocation();
      this.el.comparison.classList.remove("hidden");
      this.renderChips();
      this.fetchSeriesData(this.series[0])
        .then(() => this.renderCharts())
        .catch((err) => this.showError(err.message));
    } catch (e) {
      console.warn("Failed to restore legacy session:", e);
    }
  },

  /* ==============================================
     Series management
     ============================================== */

  newSeries({ isPrimary, location, days, start, end }) {
    return {
      id: isPrimary ? 0 : this.nextId++,
      isPrimary: !!isPrimary,
      location,
      days: days ?? null,
      start,
      end,
      color: this.SERIES_COLORS[0],
      data: null,
    };
  },

  persistPrimary() {
    const s = this.series[0];
    if (!s) return;
    localStorage.setItem("sundial_primary", JSON.stringify({
      location: s.location,
      days: s.days,
      start: s.start,
      end: s.end,
    }));
  },

  assignColors() {
    // Primary always gets color 0; comparisons get next available
    this.series.forEach((s, i) => {
      s.color = this.SERIES_COLORS[i % this.SERIES_COLORS.length];
    });
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

  buildURL(location, startDate, endDate) {
    const { lat, lon } = location;
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

  async fetchSeriesData(series) {
    const url = this.buildURL(series.location, series.start, series.end);
    series.data = await this.fetchJSON(url);
    return series.data;
  },

  async fetchJSON(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error("Weather request failed");
    const data = await res.json();
    if (data.error) throw new Error(data.reason || "API error");
    return data;
  },

  daysToRange(days) {
    const end = new Date();
    end.setDate(end.getDate() - 1);
    const start = new Date(end);
    start.setDate(start.getDate() - (days - 1));
    return { start: this.dateStr(start), end: this.dateStr(end) };
  },

  /* ==============================================
     Event handlers – Primary series
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
      const location = await this.geocode(zip);

      // Preserve current primary range if it exists, otherwise default to 7d
      const prev = this.series[0];
      const days = prev?.days ?? 7;
      const range = prev && prev.days == null
        ? { start: prev.start, end: prev.end }
        : this.daysToRange(days);

      const comparisons = this.series.slice(1); // keep comparisons
      const primary = this.newSeries({
        isPrimary: true,
        location,
        days: prev && prev.days == null ? null : days,
        start: range.start,
        end: range.end,
      });

      this.series = [primary, ...comparisons];
      this.assignColors();
      this.persistPrimary();

      this.showLocation();
      this.el.comparison.classList.remove("hidden");

      await this.fetchSeriesData(primary);
      this.renderChips();
      this.renderCharts();
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
    const days = parseInt(val);
    const { start, end } = this.daysToRange(days);
    this.updatePrimary({ days, start, end });
  },

  searchCustomRange() {
    const s = this.el.startDate.value;
    const e = this.el.endDate.value;
    if (!s || !e) return this.showError("Please pick both dates");
    if (s > e)    return this.showError("Start date must be before end date");
    this.updatePrimary({ days: null, start: s, end: e });
  },

  async updatePrimary(changes) {
    const primary = this.series[0];
    if (!primary) return;

    Object.assign(primary, changes);
    this.persistPrimary();

    this.hideError();
    this.showLoading();
    try {
      await this.fetchSeriesData(primary);
      this.renderChips();
      this.renderCharts();
    } catch (err) {
      this.hideLoading();
      this.showError(err.message);
    }
  },

  activatePillForDays(days) {
    this.el.pills.forEach((p) => p.classList.remove("active"));
    const match = Array.from(this.el.pills).find(
      (p) => p.dataset.days === String(days)
    );
    if (match) match.classList.add("active");
    else {
      // Fall back to marking "custom" if days is null
      const custom = Array.from(this.el.pills).find(
        (p) => p.dataset.days === "custom"
      );
      if (custom) custom.classList.add("active");
    }
  },

  /* ==============================================
     Event handlers – Comparison series
     ============================================== */

  toggleAddForm(show) {
    if (show) {
      this.el.addForm.classList.remove("hidden");
      this.el.toggleAddBtn.classList.add("hidden");
      this.el.cmpZip.value = "";
      // Default dates to primary's current range
      const primary = this.series[0];
      if (primary) {
        this.el.cmpStart.value = primary.start;
        this.el.cmpEnd.value = primary.end;
      }
      this.el.cmpEnd.max = this.dateStr(new Date());
      this.el.cmpZip.focus();
    } else {
      this.el.addForm.classList.add("hidden");
      if (this.series.length < this.MAX_SERIES) {
        this.el.toggleAddBtn.classList.remove("hidden");
      }
    }
  },

  async addComparison() {
    const zip = this.el.cmpZip.value.trim();
    const start = this.el.cmpStart.value;
    const end = this.el.cmpEnd.value;

    if (!/^\d{5}$/.test(zip)) {
      return this.showError("Please enter a valid 5-digit ZIP code");
    }
    if (!start || !end) {
      return this.showError("Please pick both comparison dates");
    }
    if (start > end) {
      return this.showError("Start date must be before end date");
    }
    if (this.series.length >= this.MAX_SERIES) {
      return this.showError(`Up to ${this.MAX_SERIES} series at once`);
    }

    this.hideError();
    this.showLoading();

    try {
      const location = await this.geocode(zip);
      const series = this.newSeries({
        isPrimary: false,
        location,
        start,
        end,
      });
      await this.fetchSeriesData(series);
      this.series.push(series);
      this.assignColors();
      this.toggleAddForm(false);
      this.renderChips();
      this.renderCharts();
    } catch (err) {
      this.hideLoading();
      this.showError(err.message);
    }
  },

  removeSeries(id) {
    this.series = this.series.filter((s) => s.id !== id);
    this.assignColors();
    this.renderChips();
    this.renderCharts();
  },

  /* ==============================================
     UI: chips
     ============================================== */

  renderChips() {
    this.el.seriesChips.innerHTML = "";

    // Only show chips list once we have a comparison (otherwise the
    // location header already identifies the single series).
    if (this.series.length < 2) {
      this.el.seriesChips.classList.add("hidden");
      if (this.el.addForm.classList.contains("hidden")) {
        this.el.toggleAddBtn.classList.remove("hidden");
      }
      return;
    }
    this.el.seriesChips.classList.remove("hidden");

    this.series.forEach((s) => {
      const chip = document.createElement("div");
      chip.className = "series-chip";
      chip.style.borderColor = s.color.line;

      const dot = document.createElement("span");
      dot.className = "chip-dot";
      dot.style.background = s.color.line;
      chip.appendChild(dot);

      const label = document.createElement("span");
      label.className = "chip-label";
      label.textContent = this.seriesLabel(s);
      chip.appendChild(label);

      if (!s.isPrimary) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "chip-remove";
        btn.textContent = "×";
        btn.title = "Remove comparison";
        btn.addEventListener("click", () => this.removeSeries(s.id));
        chip.appendChild(btn);
      }

      this.el.seriesChips.appendChild(chip);
    });

    if (this.series.length >= this.MAX_SERIES) {
      this.el.toggleAddBtn.classList.add("hidden");
    } else if (this.el.addForm.classList.contains("hidden")) {
      this.el.toggleAddBtn.classList.remove("hidden");
    }
  },

  seriesLabel(s) {
    const shortName = s.location.name.split(",")[0].trim();
    return `${shortName} · ${this.shortDate(s.start)}–${this.shortDate(s.end)}`;
  },

  shortDate(iso) {
    const d = new Date(iso + "T12:00:00");
    return `${d.getMonth() + 1}/${d.getDate()}`;
  },

  /* ==============================================
     Rendering (Charts)
     ============================================== */

  renderCharts() {
    const series = this.series.filter((s) => s.data?.daily?.time?.length);
    if (!series.length) {
      this.hideLoading();
      this.showError("No weather data for this period");
      return;
    }
    this.hideError();

    // Tear down old charts
    this.charts.forEach((c) => c.destroy());
    this.charts = [];

    const isComparing = series.length > 1;
    const sameDates = this.allSameDates(series);

    // Pre-compute per-series metrics
    series.forEach((s) => {
      const d = s.data.daily;
      const h = s.data.hourly;
      s.metrics = {
        tempMax: d.temperature_2m_max,
        tempMin: d.temperature_2m_min,
        tempMean: d.temperature_2m_max.map((hi, i) => {
          const lo = d.temperature_2m_min[i];
          return hi != null && lo != null ? (hi + lo) / 2 : null;
        }),
        uv:       d.uv_index_max,
        precip:   d.precipitation_sum,
        windSpeed:d.wind_speed_10m_max,
        windGusts:d.wind_gusts_10m_max,
        pressure: this.dailyAverages(d.time, h?.time, h?.pressure_msl),
        humidity: this.dailyAverages(d.time, h?.time, h?.relative_humidity_2m),
        clouds:   this.dailyAverages(d.time, h?.time, h?.cloud_cover),
      };
    });

    // Build x-axis labels
    let labels;
    if (isComparing && !sameDates) {
      const maxLen = Math.max(...series.map((s) => s.data.daily.time.length));
      labels = Array.from({ length: maxLen }, (_, i) => `Day ${i + 1}`);
    } else {
      const times = series[0].data.daily.time;
      labels = times.map((d) => {
        const date = new Date(d + "T12:00:00");
        const md = `${date.getMonth() + 1}/${date.getDate()}`;
        if (times.length <= 10) {
          const day = date.toLocaleDateString("en-US", { weekday: "short" });
          return `${day} ${md}`;
        }
        return md;
      });
    }

    const axisLen = labels.length;
    const pad = (arr) => {
      if (!arr) return Array(axisLen).fill(null);
      if (arr.length >= axisLen) return arr.slice(0, axisLen);
      return [...arr, ...Array(axisLen - arr.length).fill(null)];
    };

    const optsBase = { series, isComparing, sameDates };

    // ---- Temperature ----------------------------
    const tempDatasets = [];
    if (isComparing) {
      series.forEach((s) => {
        tempDatasets.push({
          label: this.seriesLabel(s),
          data: pad(s.metrics.tempMean),
          borderColor: s.color.line,
          backgroundColor: s.color.fill,
          fill: false,
          tension: 0.35,
          pointRadius: 2,
        });
      });
    } else {
      const s = series[0];
      tempDatasets.push(
        {
          label: "High",
          data: s.metrics.tempMax,
          borderColor: "#f0a848",
          backgroundColor: "rgba(240, 168, 72, 0.12)",
          fill: "+1",
          tension: 0.35,
          pointRadius: 3,
        },
        {
          label: "Low",
          data: s.metrics.tempMin,
          borderColor: "#64b5f6",
          fill: false,
          tension: 0.35,
          pointRadius: 3,
        }
      );
    }
    this.charts.push(
      this.makeChart("chart-temp", "line", labels, tempDatasets,
        this.chartOpts({ ...optsBase, ySuffix: "°", legend: true }))
    );

    // ---- UV Index --------------------------------
    const uvDatasets = isComparing
      ? series.map((s) => ({
          label: this.seriesLabel(s),
          data: pad(s.metrics.uv),
          backgroundColor: s.color.line,
          borderRadius: 4,
        }))
      : [{
          label: "UV Index",
          data: series[0].metrics.uv,
          backgroundColor: series[0].metrics.uv.map((v) => this.uvColor(v)),
          borderRadius: 4,
        }];
    this.charts.push(
      this.makeChart("chart-uv", "bar", labels, uvDatasets,
        this.chartOpts({ ...optsBase, yMin: 0, legend: isComparing }))
    );

    // ---- Pressure --------------------------------
    const pressureDatasets = isComparing
      ? series.map((s) => ({
          label: this.seriesLabel(s),
          data: pad(s.metrics.pressure),
          borderColor: s.color.line,
          backgroundColor: s.color.fill,
          fill: false,
          tension: 0.35,
          pointRadius: 2,
        }))
      : [{
          label: "Pressure",
          data: series[0].metrics.pressure,
          borderColor: "#ab94e4",
          backgroundColor: "rgba(171, 148, 228, 0.1)",
          fill: true,
          tension: 0.35,
          pointRadius: 3,
        }];
    this.charts.push(
      this.makeChart("chart-pressure", "line", labels, pressureDatasets,
        this.chartOpts({ ...optsBase, ySuffix: " hPa", legend: isComparing }))
    );

    // ---- Precipitation ---------------------------
    const precipDatasets = isComparing
      ? series.map((s) => ({
          label: this.seriesLabel(s),
          data: pad(s.metrics.precip),
          backgroundColor: s.color.line,
          borderRadius: 4,
        }))
      : [{
          label: "Precipitation",
          data: series[0].metrics.precip,
          backgroundColor: "rgba(100, 181, 246, 0.6)",
          borderRadius: 4,
        }];
    this.charts.push(
      this.makeChart("chart-precip", "bar", labels, precipDatasets,
        this.chartOpts({ ...optsBase, ySuffix: '"', yMin: 0, legend: isComparing }))
    );

    // ---- Humidity & Cloud Cover ------------------
    const humDatasets = isComparing
      ? series.map((s) => ({
          label: this.seriesLabel(s),
          data: pad(s.metrics.humidity),
          borderColor: s.color.line,
          tension: 0.35,
          pointRadius: 2,
        }))
      : [
          {
            label: "Humidity",
            data: series[0].metrics.humidity,
            borderColor: "#4fc3f7",
            tension: 0.35,
            pointRadius: 2,
          },
          {
            label: "Cloud Cover",
            data: series[0].metrics.clouds,
            borderColor: "#78909c",
            borderDash: [4, 4],
            tension: 0.35,
            pointRadius: 2,
          },
        ];
    // When comparing, re-title via DOM? No — just chart type is fine. Legend labels cover it.
    this.charts.push(
      this.makeChart("chart-humidity", "line", labels, humDatasets,
        this.chartOpts({ ...optsBase, ySuffix: "%", yMin: 0, yMax: 100, legend: true }))
    );

    // ---- Wind ------------------------------------
    const windDatasets = isComparing
      ? series.map((s) => ({
          label: this.seriesLabel(s),
          data: pad(s.metrics.windSpeed),
          borderColor: s.color.line,
          tension: 0.35,
          pointRadius: 2,
        }))
      : [
          {
            label: "Speed",
            data: series[0].metrics.windSpeed,
            borderColor: "#81c784",
            tension: 0.35,
            pointRadius: 3,
          },
          {
            label: "Gusts",
            data: series[0].metrics.windGusts,
            borderColor: "rgba(129, 199, 132, 0.4)",
            borderDash: [4, 4],
            tension: 0.35,
            pointRadius: 2,
          },
        ];
    this.charts.push(
      this.makeChart("chart-wind", "line", labels, windDatasets,
        this.chartOpts({ ...optsBase, ySuffix: " mph", yMin: 0, legend: true }))
    );

    // Show
    this.hideLoading();
    this.el.charts.classList.remove("hidden");
  },

  allSameDates(series) {
    if (series.length < 2) return true;
    const [first, ...rest] = series;
    return rest.every((s) => s.start === first.start && s.end === first.end);
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

  chartOpts({
    ySuffix = "",
    yMin,
    yMax,
    legend = false,
    series,
    isComparing = false,
    sameDates = true,
  } = {}) {
    const self = this;
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
              const valStr = v != null ? v.toFixed(1) + ySuffix : "--";

              // In comparison mode with shifted dates, include each series'
              // actual calendar date so overlays are readable.
              if (isComparing && !sameDates && series) {
                const s = series[ctx.datasetIndex];
                const iso = s?.data?.daily?.time?.[ctx.dataIndex];
                if (iso) {
                  return `${ctx.dataset.label} (${self.shortDate(iso)}): ${valStr}`;
                }
              }
              return `${ctx.dataset.label}: ${valStr}`;
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
     UI helpers
     ============================================== */

  setLoading(on) {
    this.el.searchBtn.disabled = on;
    this.el.btnText.classList.toggle("hidden", on);
    this.el.btnLoading.classList.toggle("hidden", !on);
  },

  showLocation() {
    this.el.locationInfo.classList.remove("hidden");
    const primary = this.series[0];
    if (primary) {
      this.el.locationName.textContent = `📍 ${primary.location.name}`;
    }
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
    this.hideLoading();
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
