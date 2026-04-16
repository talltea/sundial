/* ================================================
   Sundial – skymap.js
   All-sky planisphere: stars, constellations, planets
   ================================================ */

const SkyMap = {

  // ---- State -----------------------------------
  canvas: null,
  ctx: null,
  location: null,           // { lat, lon, utcOffsetSec, timezone }
  renderedAt: null,         // Date the current scene was drawn for
  showLines: true,
  showLabels: true,

  // ---- DOM refs --------------------------------
  el: {},

  // ---- Constants -------------------------------
  RAD: Math.PI / 180,
  OBLIQUITY_DEG: 23.4397,
  HORIZON_PAD: 0.93,        // inner radius (horizon) as fraction of canvas radius
  LABEL_MAG_LIMIT: 2.0,     // only label stars brighter than this

  /* ==============================================
     Init
     ============================================== */

  init() {
    this.canvas = document.getElementById("skymap-canvas");
    if (!this.canvas) return;
    this.ctx = this.canvas.getContext("2d");
    this.el = {
      lines:     document.getElementById("skymap-lines"),
      labels:    document.getElementById("skymap-labels"),
      refresh:   document.getElementById("skymap-refresh"),
      timestamp: document.getElementById("skymap-timestamp"),
    };

    this.el.lines.addEventListener("change", () => {
      this.showLines = this.el.lines.checked;
      this.render();
    });
    this.el.labels.addEventListener("change", () => {
      this.showLabels = this.el.labels.checked;
      this.render();
    });
    this.el.refresh.addEventListener("click", () => this.render());

    window.addEventListener("resize", () => {
      if (this.location) this.render();
    });
  },

  /* ==============================================
     Public entry — called by Astro.loadData
     ============================================== */

  draw(lat, lon, utcOffsetSec, timezone) {
    this.location = { lat, lon, utcOffsetSec, timezone };
    this.render();
  },

  render() {
    if (!this.location) return;
    this.renderedAt = new Date();
    this.resizeCanvas();
    this.drawScene();
    this.updateTimestamp();
  },

  /* ==============================================
     Canvas sizing (retina-aware square)
     ============================================== */

  resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const wrap = this.canvas.parentElement;
    const size = wrap.clientWidth;
    this.canvas.width = size * dpr;
    this.canvas.height = size * dpr;
    this.canvas.style.width = size + "px";
    this.canvas.style.height = size + "px";
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.cssSize = size;
  },

  /* ==============================================
     Rendering
     ============================================== */

  drawScene() {
    const ctx = this.ctx;
    const size = this.cssSize;
    const cx = size / 2;
    const cy = size / 2;
    const R = (size / 2) * this.HORIZON_PAD;
    this.cx = cx;
    this.cy = cy;
    this.R = R;

    // Background
    ctx.clearRect(0, 0, size, size);
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
    grad.addColorStop(0, "#0b1125");
    grad.addColorStop(1, "#060914");
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();

    // Horizon ring + compass labels
    ctx.strokeStyle = "rgba(159, 168, 199, 0.45)";
    ctx.lineWidth = 1;
    ctx.stroke();

    // Altitude guide circles (30°, 60°)
    ctx.strokeStyle = "rgba(159, 168, 199, 0.12)";
    for (const alt of [30, 60]) {
      const r = this.altToR(alt) * R;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Compute ephemeris context
    const now = this.renderedAt;
    const jd = now.getTime() / 86400000 + 2440587.5;
    const dJ2000 = jd - 2451545;
    const dSch = jd - 2451543.5;
    const lst = this.localSiderealTime(dJ2000, this.location.lon);   // radians
    const phi = this.location.lat * this.RAD;
    const ecl = this.OBLIQUITY_DEG * this.RAD;

    // Precompute star alt/az/xy
    const starPts = new Array(SKY_STARS.length);
    for (let i = 0; i < SKY_STARS.length; i++) {
      const s = SKY_STARS[i];
      const ra = s[0] * this.RAD;
      const dec = s[1] * this.RAD;
      const { alt, az } = this.raDecToAltAz(ra, dec, lst, phi);
      if (alt < 0) { starPts[i] = null; continue; }
      const xy = this.project(alt, az);
      starPts[i] = { alt, az, x: xy.x, y: xy.y, mag: s[2], name: s[3], hip: s[4] };
    }
    // Map HIP → index for constellation line lookup
    const hipIndex = new Map();
    for (let i = 0; i < SKY_STARS.length; i++) {
      const hip = SKY_STARS[i][4];
      if (hip) hipIndex.set(hip, i);
    }

    // Constellation lines — drawn before stars so they sit beneath
    if (this.showLines) {
      ctx.strokeStyle = "rgba(159, 168, 199, 0.28)";
      ctx.lineWidth = 1;
      for (const [, polylines] of SKY_CONSTELLATIONS) {
        for (const poly of polylines) {
          let prev = null;
          for (const p of poly) {
            const ra = p[0] * this.RAD;
            const dec = p[1] * this.RAD;
            const { alt, az } = this.raDecToAltAz(ra, dec, lst, phi);
            const above = alt >= 0;
            if (!above) { prev = null; continue; }
            const { x, y } = this.project(alt, az);
            if (prev) {
              ctx.beginPath();
              ctx.moveTo(prev.x, prev.y);
              ctx.lineTo(x, y);
              ctx.stroke();
            }
            prev = { x, y };
          }
        }
      }
    }

    // Stars
    ctx.fillStyle = "#f5f7ff";
    for (const p of starPts) {
      if (!p) continue;
      const r = Math.max(0.5, 4 - p.mag * 0.7);
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    // Star labels
    if (this.showLabels) {
      ctx.fillStyle = "rgba(245, 247, 255, 0.75)";
      ctx.font = "11px 'Segoe UI', system-ui, sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      for (const p of starPts) {
        if (!p || !p.name) continue;
        if (p.mag > this.LABEL_MAG_LIMIT) continue;
        const r = Math.max(0.5, 4 - p.mag * 0.7);
        ctx.fillText(p.name, p.x + r + 3, p.y);
      }
    }

    // Planets + Moon + Sun
    const bodies = this.computeBodies(dSch, ecl);
    for (const b of bodies) {
      const { alt, az } = this.raDecToAltAz(b.ra, b.dec, lst, phi);
      if (alt < 0) continue;
      const { x, y } = this.project(alt, az);
      ctx.beginPath();
      ctx.arc(x, y, b.radius, 0, Math.PI * 2);
      ctx.fillStyle = b.color;
      ctx.fill();
      // Outline for visibility
      ctx.lineWidth = 0.75;
      ctx.strokeStyle = "rgba(11, 17, 37, 0.8)";
      ctx.stroke();

      if (this.showLabels) {
        ctx.fillStyle = b.color;
        ctx.font = "600 11px 'Segoe UI', system-ui, sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(b.name, x + b.radius + 3, y);
      }
    }

    // Compass cardinal labels (outside horizon ring)
    ctx.fillStyle = "rgba(159, 168, 199, 0.85)";
    ctx.font = "600 12px 'Segoe UI', system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const pad = (size / 2) - R;
    const offset = R + pad / 2;
    ctx.fillText("N", cx, cy - offset);
    ctx.fillText("S", cx, cy + offset);
    ctx.fillText("E", cx - offset, cy);
    ctx.fillText("W", cx + offset, cy);
  },

  /* ==============================================
     Projection: alt/az → canvas x,y
     Stereographic planisphere — zenith at center,
     horizon at R, N up, E left.
     ============================================== */

  altToR(altDeg) {
    // r normalized to 1 at horizon
    return Math.tan((90 - altDeg) * this.RAD / 2);
  },

  project(alt, az) {
    // alt, az in radians; az measured from N toward E
    const r = Math.tan((Math.PI / 2 - alt) / 2);
    const dx = -Math.sin(az);    // E → -x (left)
    const dy = -Math.cos(az);    // N → -y (up on canvas)
    return {
      x: this.cx + r * this.R * dx,
      y: this.cy + r * this.R * dy,
    };
  },

  /* ==============================================
     Sidereal time (radians)
     ============================================== */

  localSiderealTime(dJ2000, siteLon) {
    // GMST in degrees — Meeus low precision
    let gmst = 280.16 + 360.9856235 * dJ2000;
    gmst = ((gmst % 360) + 360) % 360;
    return (gmst + siteLon) * this.RAD;
  },

  /* ==============================================
     RA/Dec → alt/az
     ============================================== */

  raDecToAltAz(ra, dec, lst, phi) {
    const H = lst - ra;
    const alt = Math.asin(
      Math.sin(phi) * Math.sin(dec) +
      Math.cos(phi) * Math.cos(dec) * Math.cos(H)
    );
    const az = Math.atan2(
      -Math.cos(dec) * Math.sin(H),
      Math.sin(dec) * Math.cos(phi) - Math.cos(dec) * Math.sin(phi) * Math.cos(H)
    );
    // Normalize az to [0, 2π)
    const azN = (az + 2 * Math.PI) % (2 * Math.PI);
    return { alt, az: azN };
  },

  /* ==============================================
     Planet + sun + moon positions
     ============================================== */

  computeBodies(d, eclRad) {
    const bodies = [];

    // --- Sun (geocentric) ---
    const sun = this.sunPosition(d, eclRad);
    // Not plotted (the "sky" is defined for "now" and sun rarely adds value
    // when it's up — but we keep sun ecliptic coords for planet geocentric offsets).

    // --- Planets ---
    const PLANETS = [
      { name: "Mercury", color: "#b0bec5", radius: 3,
        orb: (d) => ({
          N: 48.3313 + 3.24587e-5 * d,
          i:  7.0047 + 5.00e-8 * d,
          w: 29.1241 + 1.01444e-5 * d,
          a: 0.387098,
          e: 0.205635 + 5.59e-10 * d,
          M: 168.6562 + 4.0923344368 * d,
        }),
      },
      { name: "Venus", color: "#fff59d", radius: 4,
        orb: (d) => ({
          N: 76.6799 + 2.46590e-5 * d,
          i:  3.3946 + 2.75e-8 * d,
          w: 54.8910 + 1.38374e-5 * d,
          a: 0.723330,
          e: 0.006773 - 1.302e-9 * d,
          M: 48.0052 + 1.6021302244 * d,
        }),
      },
      { name: "Mars", color: "#ef9a9a", radius: 3.5,
        orb: (d) => ({
          N: 49.5574 + 2.11081e-5 * d,
          i:  1.8497 - 1.78e-8 * d,
          w: 286.5016 + 2.92961e-5 * d,
          a: 1.523688,
          e: 0.093405 + 2.516e-9 * d,
          M: 18.6021 + 0.5240207766 * d,
        }),
      },
      { name: "Jupiter", color: "#ffe0b2", radius: 4.5,
        orb: (d) => ({
          N: 100.4542 + 2.76854e-5 * d,
          i:  1.3030 - 1.557e-7 * d,
          w: 273.8777 + 1.64505e-5 * d,
          a: 5.20256,
          e: 0.048498 + 4.469e-9 * d,
          M: 19.8950 + 0.0830853001 * d,
        }),
      },
      { name: "Saturn", color: "#d7ccc8", radius: 4,
        orb: (d) => ({
          N: 113.6634 + 2.38980e-5 * d,
          i:  2.4886 - 1.081e-7 * d,
          w: 339.3939 + 2.97661e-5 * d,
          a: 9.55475,
          e: 0.055546 - 9.499e-9 * d,
          M: 316.9670 + 0.0334442282 * d,
        }),
      },
    ];

    for (const p of PLANETS) {
      const { ra, dec } = this.planetRaDec(p.orb(d), sun, eclRad);
      bodies.push({ name: p.name, color: p.color, radius: p.radius, ra, dec });
    }

    // --- Moon (Meeus low precision, geocentric) ---
    const m = this.moonRaDec(d - 1.5, eclRad);  // convert Schlyter d to J2000 d
    bodies.push({ name: "Moon", color: "#ffffff", radius: 5, ra: m.ra, dec: m.dec });

    return bodies;
  },

  sunPosition(d, eclRad) {
    const rad = this.RAD;
    const w = rad * (282.9404 + 4.70935e-5 * d);
    const e = 0.016709 - 1.151e-9 * d;
    const M = this.normAngle(rad * (356.0470 + 0.9856002585 * d));

    const E = M + e * Math.sin(M) * (1 + e * Math.cos(M));
    const xv = Math.cos(E) - e;
    const yv = Math.sqrt(1 - e * e) * Math.sin(E);
    const v = Math.atan2(yv, xv);
    const r = Math.sqrt(xv * xv + yv * yv);
    const lon = v + w;

    // Ecliptic rect coords of sun (geocentric)
    const xs = r * Math.cos(lon);
    const ys = r * Math.sin(lon);

    // Equatorial
    const xe = xs;
    const ye = ys * Math.cos(eclRad);
    const ze = ys * Math.sin(eclRad);

    return {
      xEcl: xs,
      yEcl: ys,
      zEcl: 0,
      ra: Math.atan2(ye, xe),
      dec: Math.atan2(ze, Math.sqrt(xe * xe + ye * ye)),
    };
  },

  planetRaDec(o, sun, eclRad) {
    const rad = this.RAD;
    const N = this.normAngle(rad * o.N);
    const i = rad * o.i;
    const w = rad * o.w;
    const a = o.a;
    const e = o.e;
    const M = this.normAngle(rad * o.M);

    // Solve Kepler's equation (iterate for accuracy; Mercury has e~0.2)
    let E = M + e * Math.sin(M) * (1 + e * Math.cos(M));
    for (let j = 0; j < 4; j++) {
      E = E - (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    }

    const xv = a * (Math.cos(E) - e);
    const yv = a * Math.sqrt(1 - e * e) * Math.sin(E);
    const v = Math.atan2(yv, xv);
    const r = Math.sqrt(xv * xv + yv * yv);

    // Heliocentric ecliptic rect
    const vw = v + w;
    const cosN = Math.cos(N), sinN = Math.sin(N);
    const cosVw = Math.cos(vw), sinVw = Math.sin(vw);
    const cosI = Math.cos(i), sinI = Math.sin(i);

    const xh = r * (cosN * cosVw - sinN * sinVw * cosI);
    const yh = r * (sinN * cosVw + cosN * sinVw * cosI);
    const zh = r * (sinVw * sinI);

    // Geocentric ecliptic rect: planet_geo = planet_helio + sun_geo
    const xg = xh + sun.xEcl;
    const yg = yh + sun.yEcl;
    const zg = zh;

    // Rotate to equatorial
    const xe = xg;
    const ye = yg * Math.cos(eclRad) - zg * Math.sin(eclRad);
    const ze = yg * Math.sin(eclRad) + zg * Math.cos(eclRad);

    return {
      ra: Math.atan2(ye, xe),
      dec: Math.atan2(ze, Math.sqrt(xe * xe + ye * ye)),
    };
  },

  moonRaDec(dJ2000, eclRad) {
    const rad = this.RAD;
    const Lp = rad * (218.316 + 13.176396 * dJ2000);
    const M  = rad * (134.963 + 13.064993 * dJ2000);
    const F  = rad * (93.272  + 13.229350 * dJ2000);
    const eclLon = Lp + rad * 6.289 * Math.sin(M);
    const eclLat = rad * 5.128 * Math.sin(F);
    const ra = Math.atan2(
      Math.sin(eclLon) * Math.cos(eclRad) -
        Math.tan(eclLat) * Math.sin(eclRad),
      Math.cos(eclLon)
    );
    const dec = Math.asin(
      Math.sin(eclLat) * Math.cos(eclRad) +
        Math.cos(eclLat) * Math.sin(eclRad) * Math.sin(eclLon)
    );
    return { ra, dec };
  },

  normAngle(rad) {
    const twoPi = 2 * Math.PI;
    return ((rad % twoPi) + twoPi) % twoPi;
  },

  /* ==============================================
     UI helpers
     ============================================== */

  updateTimestamp() {
    const t = this.renderedAt.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: this.location.timezone,
    });
    this.el.timestamp.textContent = "— " + t;
  },
};
