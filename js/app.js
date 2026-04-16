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
  AIR_QUALITY_URL: "https://air-quality-api.open-meteo.com/v1/air-quality",

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

  AIR_QUALITY_PARAMS: "us_aqi,pm2_5,pm10",

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
      hourlyCard:      document.getElementById("hourly-card"),
      hourlyStrip:     document.getElementById("hourly-strip"),
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

  readSharedLocation() {
    const raw = localStorage.getItem("sundial_location");
    if (!raw) return null;
    try {
      const loc = JSON.parse(raw);
      if (loc?.lat != null && loc?.lon != null) return loc;
    } catch (e) {}
    return null;
  },

  writeSharedLocation(location) {
    localStorage.setItem("sundial_location", JSON.stringify(location));
  },

  restoreSession() {
    let location = this.readSharedLocation();
    let days = "forecast14";
    let start = null;
    let end = null;

    const savedPrimary = localStorage.getItem("sundial_primary");
    if (savedPrimary) {
      try {
        const p = JSON.parse(savedPrimary);
        // Migrate legacy format that embedded location in sundial_primary
        if (p.location && !location) {
          location = p.location;
          this.writeSharedLocation(location);
        }
        if (p.days !== undefined) days = p.days;
        start = p.start ?? null;
        end = p.end ?? null;
      } catch (e) {
        console.warn("Failed to restore session:", e);
      }
    }

    if (!location) return;

    const range = (start && end)
      ? { start, end }
      : this.rangeForDays(days ?? "forecast14");

    this.series = [this.newSeries({
      isPrimary: true,
      location,
      days,
      start: range.start,
      end: range.end,
    })];
    this.el.zip.value = location.zip || "";
    this.activatePillForDays(days);
    this.showLocation();
    this.el.comparison.classList.remove("hidden");
    this.renderChips();
    this.fetchSeriesData(this.series[0])
      .then(() => this.renderCharts())
      .catch((err) => this.showError(err.message));
    this.refreshHourly(location);
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
    this.writeSharedLocation(s.location);
    localStorage.setItem("sundial_primary", JSON.stringify({
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

  buildAirQualityURL(location, startDate, endDate) {
    const { lat, lon } = location;
    // AQ forecast only extends ~5 days out; cap end date to avoid 400 errors
    const maxForecast = new Date();
    maxForecast.setDate(maxForecast.getDate() + 5);
    const maxStr = this.dateStr(maxForecast);
    const cappedEnd = endDate > maxStr ? maxStr : endDate;
    return (
      `${this.AIR_QUALITY_URL}?latitude=${lat}&longitude=${lon}` +
      `&start_date=${startDate}&end_date=${cappedEnd}` +
      `&hourly=${this.AIR_QUALITY_PARAMS}&timezone=auto`
    );
  },

  async fetchSeriesData(series) {
    const weatherURL = this.buildURL(series.location, series.start, series.end);
    const aqURL = this.buildAirQualityURL(series.location, series.start, series.end);

    const [weatherData, aqData] = await Promise.all([
      this.fetchJSON(weatherURL),
      this.fetchJSON(aqURL).catch(() => null),
    ]);

    series.data = weatherData;
    series.airQuality = aqData;
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

  daysToForecastRange(days) {
    const start = new Date();
    const end = new Date();
    end.setDate(end.getDate() + (days - 1));
    return { start: this.dateStr(start), end: this.dateStr(end) };
  },

  rangeForDays(days) {
    if (typeof days === "string" && days.startsWith("forecast")) {
      return this.daysToForecastRange(parseInt(days.replace("forecast", "")));
    }
    return this.daysToRange(typeof days === "string" ? parseInt(days) : days);
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
      const cached = this.readSharedLocation();
      const location = cached?.zip === zip ? cached : await this.geocode(zip);

      // Preserve current primary range if it exists, otherwise default to forecast14
      const prev = this.series[0];
      const days = prev?.days ?? "forecast14";
      const range = prev && prev.days == null
        ? { start: prev.start, end: prev.end }
        : this.rangeForDays(days);

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
      this.refreshHourly(location);
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
      this.el.startDate.value = this.dateStr(weekAgo);
      return;
    }

    this.el.customRange.classList.add("hidden");

    const days = val.startsWith("forecast") ? val : parseInt(val);
    const { start, end } = this.rangeForDays(days);
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
      // No max constraint — allow future dates for forecast comparisons
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
    return `${shortName} · ${this.shortDate(s.start, true)}–${this.shortDate(s.end, true)}`;
  },

  shortDate(iso, withYear = false) {
    const d = new Date(iso + "T12:00:00");
    const md = `${d.getMonth() + 1}/${d.getDate()}`;
    return withYear ? `${md}/${String(d.getFullYear()).slice(-2)}` : md;
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
      const aq = s.airQuality?.hourly;
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
        aqi:      this.dailyMax(d.time, aq?.time, aq?.us_aqi),
        pm25:     this.dailyAverages(d.time, aq?.time, aq?.pm2_5),
        pm10:     this.dailyAverages(d.time, aq?.time, aq?.pm10),
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
      // Per series: solid high line + dashed low line + translucent fill
      // between the two, so each series is a readable "envelope".
      // The low dataset is hidden from the legend (same color+label as high)
      // but carries _kind metadata so tooltips can label it.
      series.forEach((s, i) => {
        const lbl = this.seriesLabel(s);
        tempDatasets.push({
          label: lbl,
          data: pad(s.metrics.tempMax),
          borderColor: s.color.line,
          backgroundColor: s.color.fill,
          fill: "+1",
          tension: 0.35,
          pointRadius: 2,
          _seriesIdx: i,
          _kind: "High",
        });
        tempDatasets.push({
          label: lbl,
          data: pad(s.metrics.tempMin),
          borderColor: s.color.line,
          borderDash: [4, 4],
          fill: false,
          tension: 0.35,
          pointRadius: 2,
          _seriesIdx: i,
          _kind: "Low",
          _hideLegend: true,
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

    // ---- Air Quality (AQI) -------------------------
    const aqiDatasets = isComparing
      ? series.map((s) => ({
          label: this.seriesLabel(s),
          data: pad(s.metrics.aqi),
          borderColor: s.color.line,
          backgroundColor: s.color.fill,
          fill: false,
          tension: 0.35,
          pointRadius: 2,
        }))
      : [
          {
            label: "US AQI",
            data: pad(series[0].metrics.aqi),
            borderColor: "#f0a848",
            backgroundColor: series[0].metrics.aqi.map((v) => this.aqiColor(v)),
            fill: false,
            tension: 0.35,
            pointRadius: 3,
            segment: {
              borderColor: (ctx) =>
                this.aqiColor(ctx.p1.parsed.y),
            },
          },
          {
            label: "PM2.5",
            data: pad(series[0].metrics.pm25),
            borderColor: "#e57373",
            borderDash: [4, 4],
            fill: false,
            tension: 0.35,
            pointRadius: 2,
            yAxisID: "y1",
          },
        ];
    this.charts.push(
      this.makeChart("chart-aqi", "line", labels, aqiDatasets,
        this.chartOpts({
          ...optsBase, yMin: 0, legend: true,
          ...(isComparing ? {} : { y1: { suffix: " µg/m³", position: "right" } }),
        }))
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
    y1,
  } = {}) {
    const self = this;
    return {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          display: legend,
          labels: {
            boxWidth: 12,
            usePointStyle: true,
            // Hide datasets explicitly flagged (e.g. the "Low" half of a
            // temperature envelope — same color/label as its "High" partner).
            filter: (item, data) =>
              !data.datasets[item.datasetIndex]?._hideLegend,
          },
        },
        tooltip: {
          callbacks: {
            label(ctx) {
              const v = ctx.parsed.y;
              const valStr = v != null ? v.toFixed(1) + ySuffix : "--";
              const ds = ctx.dataset;
              const kindSuffix = ds._kind ? ` ${ds._kind}` : "";

              // In comparison mode with shifted dates, include each series'
              // actual calendar date so overlays are readable.
              if (isComparing && !sameDates && series) {
                const seriesIdx = ds._seriesIdx ?? ctx.datasetIndex;
                const s = series[seriesIdx];
                const iso = s?.data?.daily?.time?.[ctx.dataIndex];
                if (iso) {
                  return `${ds.label} (${self.shortDate(iso, true)})${kindSuffix}: ${valStr}`;
                }
              }
              return `${ds.label}${kindSuffix}: ${valStr}`;
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
        ...(y1 ? {
          y1: {
            position: y1.position || "right",
            min: 0,
            grid: { display: false },
            ticks: {
              callback: (v) => `${v}${y1.suffix || ""}`,
            },
          },
        } : {}),
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

  aqiColor(v) {
    if (v == null) return "#5c6788";
    if (v <= 50)   return "#4caf50";  // Good
    if (v <= 100)  return "#f0d94e";  // Moderate
    if (v <= 150)  return "#ff9800";  // Unhealthy for sensitive
    if (v <= 200)  return "#f44336";  // Unhealthy
    if (v <= 300)  return "#9c27b0";  // Very unhealthy
    return "#7e0023";                 // Hazardous
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
     Hourly forecast strip (next 24h)
     ============================================== */

  async refreshHourly(location) {
    if (!location) return;
    try {
      const url =
        `${this.FORECAST_URL}?latitude=${location.lat}&longitude=${location.lon}` +
        `&hourly=temperature_2m,weather_code,precipitation_probability,is_day` +
        `&forecast_hours=24&past_hours=1` +
        `&${this.UNIT_PARAMS}&timezone=auto`;
      const data = await this.fetchJSON(url);
      this.renderHourly(data);
    } catch (e) {
      this.el.hourlyCard.classList.add("hidden");
    }
  },

  renderHourly(data) {
    const h = data.hourly;
    if (!h || !h.time || !h.time.length) {
      this.el.hourlyCard.classList.add("hidden");
      return;
    }

    // Find the index of the hour closest to "now" in the location's timezone.
    const nowMs = Date.now();
    let nowIdx = 0;
    let bestDelta = Infinity;
    for (let i = 0; i < h.time.length; i++) {
      const delta = Math.abs(new Date(h.time[i]).getTime() - nowMs);
      if (delta < bestDelta) { bestDelta = delta; nowIdx = i; }
    }

    const end = Math.min(h.time.length, nowIdx + 24);
    let html = "";
    for (let i = nowIdx; i < end; i++) {
      const d = new Date(h.time[i]);
      const label = i === nowIdx
        ? "Now"
        : d.toLocaleTimeString("en-US", { hour: "numeric", timeZone: data.timezone });
      const temp = h.temperature_2m?.[i];
      const code = h.weather_code?.[i];
      const pop = h.precipitation_probability?.[i];
      const isDay = h.is_day?.[i] !== 0;
      const nowClass = i === nowIdx ? " hc-now" : "";

      html +=
        `<div class="hour-cell${nowClass}">` +
          `<span class="hc-time">${label}</span>` +
          `<span class="hc-icon">${this.weatherCodeEmoji(code, isDay)}</span>` +
          `<span class="hc-temp">${temp != null ? Math.round(temp) + "\u00b0" : "\u2014"}</span>` +
          `<span class="hc-pop">${pop != null && pop > 0 ? pop + "%" : ""}</span>` +
        `</div>`;
    }

    this.el.hourlyStrip.innerHTML = html;
    this.el.hourlyCard.classList.remove("hidden");
  },

  // WMO weather codes → emoji. See https://open-meteo.com/en/docs
  weatherCodeEmoji(code, isDay = true) {
    if (code == null) return "\u2014";
    if (code === 0) return isDay ? "\u2600\ufe0f" : "\ud83c\udf19"; // clear sun / moon
    if (code === 1 || code === 2) {
      return isDay ? "\u26c5" : "\u2601\ufe0f";       // partly cloudy / night clouds
    }
    if (code === 3) return "\u2601\ufe0f";            // overcast
    if (code === 45 || code === 48) return "\ud83c\udf2b\ufe0f"; // fog
    if (code >= 51 && code <= 57) return "\ud83c\udf26\ufe0f";   // drizzle
    if (code >= 61 && code <= 67) return "\ud83c\udf27\ufe0f";   // rain
    if (code >= 71 && code <= 77) return "\ud83c\udf28\ufe0f";   // snow
    if (code >= 80 && code <= 82) return "\ud83c\udf27\ufe0f";   // rain showers
    if (code === 85 || code === 86) return "\ud83c\udf28\ufe0f"; // snow showers
    if (code >= 95) return "\u26c8\ufe0f";            // thunderstorm
    return "\u2601\ufe0f";
  },

  /* ==============================================
     Pure helpers
     ============================================== */

  dailyMax(dailyDates, hourlyTimes, hourlyVals) {
    if (!hourlyTimes || !hourlyVals) return dailyDates.map(() => null);

    return dailyDates.map((date) => {
      let max = null;
      for (let i = 0; i < hourlyTimes.length; i++) {
        if (hourlyTimes[i].startsWith(date) && hourlyVals[i] != null) {
          if (max === null || hourlyVals[i] > max) max = hourlyVals[i];
        }
      }
      return max;
    });
  },

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
