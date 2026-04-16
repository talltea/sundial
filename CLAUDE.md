# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Sundial is a static PWA (Progressive Web App) that displays historical weather data for US ZIP codes. It uses vanilla JavaScript (no build step, no framework, no bundler) with Chart.js for visualization. Data comes from Open-Meteo (weather) and Nominatim/OpenStreetMap (geocoding).

## Development

No build or install step. Open `index.html` in a browser or serve with any static file server:

```
python3 -m http.server 8000
```

There are no tests, no linter, and no CI configured.

## Architecture

- **Single-object app pattern**: All logic lives in the `Sundial` object literal in `js/app.js`. It boots via `Sundial.init()` on DOMContentLoaded.
- **Series model**: The app supports up to 4 overlaid data series (1 primary + 3 comparisons), each with its own ZIP/date range. Series state is in `Sundial.series[]`.
- **Two API endpoints**: Open-Meteo forecast API (data within ~90 days) vs. archive API (older data). `buildURL()` picks the right one based on how far back the start date is.
- **Session persistence**: The active ZIP/location is shared across all tabs via `localStorage` (`sundial_location` key: `{zip, lat, lon, name}`). Tab-specific state (e.g. weather date range in `sundial_primary`) is stored separately.
- **Service worker** (`sw.js`): Cache-first for same-origin static assets, network-first with cache fallback for external APIs.
- **Charts**: 6 Chart.js canvases (temperature, UV, pressure, precipitation, humidity/cloud cover, wind). All chart creation goes through `makeChart()` and `chartOpts()`.
- **Units**: Hardcoded to US units (Fahrenheit, mph, inches).
- **CSS**: Single file (`css/style.css`) using CSS custom properties defined in `:root`. Dark theme only.

## TODO
- Hourly weather
