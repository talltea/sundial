/* ================================================
   Sundial – astronomy.js
   ================================================ */

const Astro = {

  // ---- API URLs --------------------------------
  GEOCODE_URL: "https://nominatim.openstreetmap.org/search",
  ARCHIVE_URL: "https://archive-api.open-meteo.com/v1/archive",
  FORECAST_URL: "https://api.open-meteo.com/v1/forecast",

  // ---- State -----------------------------------
  location: null,
  moonCalendarDays: 7,
  annualData: null,
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
    Chart.defaults.borderColor = "rgba(42, 58, 92, 0.3)";
    Chart.defaults.font.family =
      "'Segoe UI', system-ui, -apple-system, sans-serif";
    Chart.defaults.font.size = 11;
  },

  cacheDOM() {
    this.el = {
      form:        document.getElementById("astro-form"),
      zip:         document.getElementById("astro-zip"),
      location:    document.getElementById("astro-location"),
      error:       document.getElementById("astro-error"),
      errorText:   document.getElementById("astro-error-text"),
      loading:     document.getElementById("astro-loading"),
      content:     document.getElementById("astro-content"),
      sunDetails:  document.getElementById("sun-details"),
      moonDetails: document.getElementById("moon-details"),
      moonCal:     document.getElementById("moon-calendar"),
    };
  },

  bind() {
    this.el.form.addEventListener("submit", (e) => {
      e.preventDefault();
      this.search();
    });
  },

  restoreSession() {
    const saved = localStorage.getItem("sundial_astro");
    if (!saved) return;
    try {
      const data = JSON.parse(saved);
      this.el.zip.value = data.zip || "";
      if (data.zip) this.search();
    } catch (e) {
      console.warn("Failed to restore astro session:", e);
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
     Data fetching
     ============================================== */

  dateStr(d) {
    return d.toISOString().split("T")[0];
  },

  // Fetch a full year of sunrise/sunset from the archive API (prior year)
  async fetchAnnualSun(location) {
    const { lat, lon } = location;
    const year = new Date().getFullYear() - 1;
    const url =
      `${this.ARCHIVE_URL}?latitude=${lat}&longitude=${lon}` +
      `&start_date=${year}-01-01&end_date=${year}-12-31` +
      `&daily=sunrise,sunset&timezone=auto`;

    const res = await fetch(url);
    if (!res.ok) throw new Error("Weather request failed");
    const data = await res.json();
    if (data.error) throw new Error(data.reason || "API error");
    return data;
  },

  // Sunrise/sunset around today for the "today" card deltas
  async fetchTodayWindow(location) {
    const { lat, lon } = location;
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);

    const url =
      `${this.FORECAST_URL}?latitude=${lat}&longitude=${lon}` +
      `&start_date=${this.dateStr(yesterday)}&end_date=${this.dateStr(tomorrow)}` +
      `&daily=sunrise,sunset&timezone=auto`;

    const res = await fetch(url);
    if (!res.ok) throw new Error("Weather request failed");
    const data = await res.json();
    if (data.error) throw new Error(data.reason || "API error");
    return data;
  },

  // Sunrise/sunset for moon calendar range (days ahead)
  async fetchSunRange(location, days) {
    const { lat, lon } = location;
    const start = new Date();
    const end = new Date();
    end.setDate(end.getDate() + days - 1);

    const url =
      `${this.FORECAST_URL}?latitude=${lat}&longitude=${lon}` +
      `&start_date=${this.dateStr(start)}&end_date=${this.dateStr(end)}` +
      `&daily=sunrise,sunset&timezone=auto`;

    const res = await fetch(url);
    if (!res.ok) throw new Error("Weather request failed");
    const data = await res.json();
    if (data.error) throw new Error(data.reason || "API error");
    return data;
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
      this.location = await this.geocode(zip);
      this.annualData = null;

      this.el.location.textContent = this.location.name;
      this.el.location.classList.remove("hidden");

      localStorage.setItem("sundial_astro", JSON.stringify({ zip }));

      await this.loadData();
    } catch (err) {
      this.hideLoading();
      this.showError(err.message);
    }
  },

  async loadData() {
    this.hideError();
    this.showLoading();

    try {
      const fetches = [
        this.fetchTodayWindow(this.location),
        this.fetchSunRange(this.location, this.moonCalendarDays),
      ];
      if (!this.annualData) {
        fetches.push(this.fetchAnnualSun(this.location));
      }

      const results = await Promise.all(fetches);
      const todayData = results[0];
      const rangeData = results[1];
      if (results[2]) this.annualData = results[2];

      this.renderDaylightHero(todayData);
      this.renderTodayMoon();
      this.renderAnnualChart();
      this.renderMoonCalendar(rangeData);

      this.hideLoading();
      this.el.content.classList.remove("hidden");
    } catch (err) {
      this.hideLoading();
      this.showError(err.message);
    }
  },

  /* ==============================================
     Rendering – Daylight Hero Card
     ============================================== */

  renderDaylightHero(data) {
    const daily = data.daily;
    const tz = data.timezone;

    const dayLength = (i) => {
      const rise = new Date(daily.sunrise[i]);
      const set = new Date(daily.sunset[i]);
      return (set - rise) / 3600000;
    };

    const todayLen = dayLength(1);
    const deltaY = todayLen - dayLength(0);
    const deltaT = dayLength(2) - todayLen;

    const hours = Math.floor(todayLen);
    const mins = Math.round((todayLen - hours) * 60);

    const fmtDelta = (d) => {
      const absMins = Math.round(Math.abs(d) * 60);
      const m = absMins % 60;
      const h = Math.floor(absMins / 60);
      if (h > 0) return `${h}h ${m}m`;
      return `${m}m`;
    };
    const cls = (d) => (d > 0.001 ? "gaining" : d < -0.001 ? "losing" : "flat");
    const sign = (d) => (d > 0.001 ? "+" : d < -0.001 ? "\u2212" : "");

    const fmtTime = (iso) => {
      const d = new Date(iso);
      return d.toLocaleTimeString("en-US", {
        hour: "numeric", minute: "2-digit", timeZone: tz,
      });
    };

    this.el.sunDetails.innerHTML =
      `<div class="daylight-hero">` +
        `<div class="big-number">${hours}h ${mins}m</div>` +
        `<div class="sub">of daylight today</div>` +
        `<div class="delta ${cls(deltaY)}">${sign(deltaY)}${fmtDelta(deltaY)} vs yesterday</div>` +
        `<div class="delta ${cls(deltaT)}">${sign(deltaT)}${fmtDelta(deltaT)} tomorrow</div>` +
      `</div>` +
      `<div class="astro-row">` +
        `<span class="label">Sunrise</span>` +
        `<span class="value">${fmtTime(daily.sunrise[1])}</span>` +
      `</div>` +
      `<div class="astro-row">` +
        `<span class="label">Sunset</span>` +
        `<span class="value">${fmtTime(daily.sunset[1])}</span>` +
      `</div>`;
  },

  /* ==============================================
     Rendering – Today's Moon
     ============================================== */

  renderTodayMoon() {
    const today = new Date();
    const phase = this.moonPhase(today);
    const { name, emoji } = this.moonPhaseName(phase);
    const illum = this.moonIllumination(phase);

    this.el.moonDetails.innerHTML =
      `<div class="moon-hero">` +
        `<span class="moon-icon">${emoji}</span>` +
        `<span class="moon-phase-name">${name}</span>` +
        `<span class="moon-illumination">${illum}% illuminated</span>` +
      `</div>` +
      `<div class="astro-row"><span class="label">Phase Angle</span><span class="value">${(phase * 360).toFixed(1)}\u00B0</span></div>` +
      `<div class="astro-row"><span class="label">Lunar Day</span><span class="value">${(phase * 29.53).toFixed(1)} / 29.5</span></div>`;
  },

  /* ==============================================
     Rendering – Annual Daylight Chart
     ============================================== */

  renderAnnualChart() {
    if (this.chart) {
      this.chart.destroy();
      this.chart = null;
    }

    const daily = this.annualData.daily;
    const lat = this.location.lat;

    // Open-Meteo returns sunrise/sunset as "YYYY-MM-DDTHH:MM" in the
    // location's local time (timezone=auto). Parse directly — avoid
    // round-tripping through new Date(), which reinterprets via the
    // *browser's* timezone and throws the bands off.
    const toLocalHours = (iso) => {
      const timePart = iso.split("T")[1] || "00:00";
      const [h, m] = timePart.split(":").map(Number);
      return h + m / 60;
    };

    // Compute twilight offsets from solar noon (hours) for a given
    // date/latitude and a sun altitude (degrees below horizon).
    const twilightOffset = (dayOfYear, altitudeDeg) => {
      // Solar declination (radians)
      const declRad =
        23.44 * (Math.PI / 180) *
        Math.sin(2 * Math.PI * (dayOfYear - 81) / 365);
      const latRad = lat * (Math.PI / 180);
      const altRad = altitudeDeg * (Math.PI / 180);
      const cosH =
        (Math.sin(altRad) - Math.sin(latRad) * Math.sin(declRad)) /
        (Math.cos(latRad) * Math.cos(declRad));
      if (cosH < -1) return 12;   // sun always above this altitude
      if (cosH >  1) return null; // sun never reaches this altitude
      return Math.acos(cosH) * (180 / Math.PI) / 15; // hours
    };

    const dayOfYear = (dateStr) => {
      const d = new Date(dateStr + "T12:00:00Z");
      const start = new Date(Date.UTC(d.getUTCFullYear(), 0, 0));
      return Math.floor((d - start) / 86400000);
    };

    // Build arrays
    const n = daily.time.length;
    const labels = daily.time;
    const astroDawn = new Array(n);
    const nautDawn  = new Array(n);
    const civilDawn = new Array(n);
    const sunriseArr = new Array(n);
    const sunsetArr  = new Array(n);
    const civilDusk = new Array(n);
    const nautDusk  = new Array(n);
    const astroDusk = new Array(n);

    for (let i = 0; i < n; i++) {
      const riseH = toLocalHours(daily.sunrise[i]);
      const setH  = toLocalHours(daily.sunset[i]);
      // Solar noon midway between sunrise and sunset in local hours
      const noon = (riseH + setH) / 2;
      const doy = dayOfYear(daily.time[i]);

      const offCivil = twilightOffset(doy, -6);
      const offNaut  = twilightOffset(doy, -12);
      const offAstro = twilightOffset(doy, -18);

      sunriseArr[i] = riseH;
      sunsetArr[i]  = setH;
      civilDawn[i] = offCivil != null ? Math.max(0, noon - offCivil) : 0;
      civilDusk[i] = offCivil != null ? Math.min(24, noon + offCivil) : 24;
      nautDawn[i]  = offNaut  != null ? Math.max(0, noon - offNaut)  : 0;
      nautDusk[i]  = offNaut  != null ? Math.min(24, noon + offNaut)  : 24;
      astroDawn[i] = offAstro != null ? Math.max(0, noon - offAstro) : 0;
      astroDusk[i] = offAstro != null ? Math.min(24, noon + offAstro) : 24;
    }

    // Build the index for today (match month/day to archive year)
    const now = new Date();
    const todayMD = `${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    let todayIdx = labels.findIndex((d) => d.endsWith(`-${todayMD}`));
    if (todayIdx < 0) todayIdx = null;

    // Color tokens
    const colors = {
      night:      "#0f1729",
      astro:      "rgba(50, 70, 120, 0.45)",
      nautical:   "rgba(100, 130, 200, 0.35)",
      civil:      "rgba(240, 168, 72, 0.35)",
      daylight:   "rgba(240, 168, 72, 0.85)",
      sunLine:    "#f0a848",
      moonLine:   "#64b5f6",
      lineFaint:  "rgba(255, 255, 255, 0.10)",
    };

    // Stacked datasets, from bottom (lower y) up.
    // fill: "-1" fills between this line and the previous dataset,
    // using this dataset's backgroundColor.
    const baseDs = {
      borderWidth: 0,
      borderColor: "transparent",
      pointRadius: 0,
      tension: 0.3,
      spanGaps: true,
    };

    const datasets = [
      // astro dawn: fill from y=0 (top, because axis is reversed) to this line → pre-dawn night
      {
        ...baseDs,
        label: "Night (pre-dawn)",
        data: astroDawn,
        fill: { value: 0 },
        backgroundColor: colors.night,
      },
      // nautical dawn: astro-twilight band between astro and nautical dawn
      {
        ...baseDs,
        label: "Astronomical twilight",
        data: nautDawn,
        fill: "-1",
        backgroundColor: colors.astro,
      },
      {
        ...baseDs,
        label: "Nautical twilight",
        data: civilDawn,
        fill: "-1",
        backgroundColor: colors.nautical,
      },
      {
        ...baseDs,
        label: "Civil twilight",
        data: sunriseArr,
        fill: "-1",
        backgroundColor: colors.civil,
        // This is the visible sunrise line
        borderColor: colors.sunLine,
        borderWidth: 1.5,
      },
      {
        ...baseDs,
        label: "Daylight",
        data: sunsetArr,
        fill: "-1",
        backgroundColor: colors.daylight,
        // This is the visible sunset line
        borderColor: colors.moonLine,
        borderWidth: 1.5,
      },
      {
        ...baseDs,
        label: "Civil twilight ",
        data: civilDusk,
        fill: "-1",
        backgroundColor: colors.civil,
      },
      {
        ...baseDs,
        label: "Nautical twilight ",
        data: nautDusk,
        fill: "-1",
        backgroundColor: colors.nautical,
      },
      {
        ...baseDs,
        label: "Astronomical twilight ",
        data: astroDusk,
        fill: "-1",
        backgroundColor: colors.astro,
      },
      // Top: fill from astro dusk up to y=24 → post-dusk night
      {
        ...baseDs,
        label: "Night (post-dusk)",
        data: new Array(n).fill(24),
        fill: "-1",
        backgroundColor: colors.night,
      },
    ];

    // Month label positions (index of the 1st of each month in the data)
    const monthStarts = [];
    for (let i = 0; i < n; i++) {
      if (labels[i].endsWith("-01")) monthStarts.push(i);
    }

    const self = this;

    // Plugin: vertical "today" line
    const todayLinePlugin = {
      id: "todayLine",
      afterDatasetsDraw(chart) {
        if (todayIdx == null) return;
        const { ctx, chartArea: area, scales: { x } } = chart;
        const xPos = x.getPixelForValue(todayIdx);
        ctx.save();
        ctx.strokeStyle = "#ef5350";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(xPos, area.top);
        ctx.lineTo(xPos, area.bottom);
        ctx.stroke();

        // "Today" label
        ctx.fillStyle = "#ef5350";
        ctx.font = "600 10px 'Segoe UI', system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillText("Today", xPos, area.top + 4);
        ctx.restore();
      },
    };

    const fmtH = (h) => {
      const hh = Math.floor(h);
      const mm = Math.round((h - hh) * 60);
      const ampm = hh >= 12 ? "PM" : "AM";
      const h12 = hh === 0 ? 12 : hh > 12 ? hh - 12 : hh;
      return `${h12}:${String(mm).padStart(2, "0")} ${ampm}`;
    };

    this.chart = new Chart(document.getElementById("chart-annual"), {
      type: "line",
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            filter: (item) => {
              // Only show the sunrise & sunset lines in the tooltip
              const label = item.dataset.label;
              return label === "Civil twilight" || label === "Daylight";
            },
            callbacks: {
              title(items) {
                const raw = items[0]?.label;
                if (!raw) return "";
                const d = new Date(raw + "T12:00:00");
                return d.toLocaleDateString("en-US", {
                  month: "long", day: "numeric",
                });
              },
              label(ctx) {
                const tag = ctx.dataset.label === "Civil twilight"
                  ? "Sunrise" : "Sunset";
                return `${tag}: ${fmtH(ctx.parsed.y)}`;
              },
            },
          },
        },
        scales: {
          x: {
            ticks: {
              autoSkip: false,
              maxRotation: 0,
              color: "#9fa8c7",
              callback(val) {
                if (!monthStarts.includes(val)) return "";
                const d = new Date(labels[val] + "T12:00:00");
                return d.toLocaleDateString("en-US", { month: "short" });
              },
            },
            grid: { display: false },
          },
          y: {
            min: 0,
            max: 24,
            reverse: true,    // midnight at top, noon in middle, midnight at bottom
            ticks: {
              stepSize: 3,
              callback: (v) => fmtH(v),
            },
            grid: { color: "rgba(255, 255, 255, 0.04)" },
          },
        },
      },
      plugins: [todayLinePlugin],
    });
  },

  /* ==============================================
     Rendering – Moon Calendar
     ============================================== */

  renderMoonCalendar(rangeData) {
    const cal = this.el.moonCal;
    cal.innerHTML = "";

    const daily = rangeData.daily;
    for (let i = 0; i < daily.time.length; i++) {
      const date = new Date(daily.time[i] + "T12:00:00");
      const phase = this.moonPhase(date);
      const { emoji } = this.moonPhaseName(phase);
      const illum = this.moonIllumination(phase);

      const md = `${date.getMonth() + 1}/${date.getDate()}`;

      const div = document.createElement("div");
      div.className = "moon-day";
      div.innerHTML =
        `<span class="md-icon">${emoji}</span>` +
        `<span class="md-date">${md}</span>` +
        `<span class="md-pct">${illum}%</span>`;
      cal.appendChild(div);
    }
  },

  /* ==============================================
     Moon calculations
     ============================================== */

  moonPhase(date) {
    const knownNew = new Date("2000-01-06T18:14:00Z");
    const synodicMonth = 29.53058770576;
    const daysSince = (date.getTime() - knownNew.getTime()) / 86400000;
    const cycles = daysSince / synodicMonth;
    return cycles - Math.floor(cycles);
  },

  moonIllumination(phase) {
    return Math.round((1 - Math.cos(phase * 2 * Math.PI)) / 2 * 100);
  },

  moonPhaseName(phase) {
    if (phase < 0.0625)  return { name: "New Moon",        emoji: "\uD83C\uDF11" };
    if (phase < 0.1875)  return { name: "Waxing Crescent", emoji: "\uD83C\uDF12" };
    if (phase < 0.3125)  return { name: "First Quarter",   emoji: "\uD83C\uDF13" };
    if (phase < 0.4375)  return { name: "Waxing Gibbous",  emoji: "\uD83C\uDF14" };
    if (phase < 0.5625)  return { name: "Full Moon",       emoji: "\uD83C\uDF15" };
    if (phase < 0.6875)  return { name: "Waning Gibbous",  emoji: "\uD83C\uDF16" };
    if (phase < 0.8125)  return { name: "Last Quarter",    emoji: "\uD83C\uDF17" };
    if (phase < 0.9375)  return { name: "Waning Crescent", emoji: "\uD83C\uDF18" };
    return { name: "New Moon", emoji: "\uD83C\uDF11" };
  },

  /* ==============================================
     UI helpers
     ============================================== */

  showLoading() {
    this.el.content.classList.add("hidden");
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
document.addEventListener("DOMContentLoaded", () => Astro.init());
