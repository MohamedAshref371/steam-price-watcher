# Steam Price Watcher

A lightweight browser extension for **Chrome** and **Firefox** that tracks the price of any game on Steam and notifies you the moment it drops to (or below) a price you set — completely automatically, in the background.

---

## Features

- **Track multiple games**, each with its own target price
- **Configurable check frequency** — every 1, 3, 6, 12, or 24 hours
- **Background checking** — works even while the popup is closed, using the browser's native alarm scheduler
- **Smart startup check** — when the browser launches, the extension checks how much time is left until the next scheduled check and picks up exactly where it left off, instead of resetting the timer
- **Regional pricing** — choose your Steam store region so prices match what you'd actually see on the store
- **Editable targets** — update a game's target price at any time without removing and re-adding it
- **Repeat alerts (optional)** — choose whether to be notified once per price drop, or on every check while the price stays below your target
- **Bilingual UI** — switch between Arabic and English instantly from the popup
- **Native desktop notifications** when a price drop is detected

---

## Installation

### Google Chrome (and other Chromium browsers — Edge, Brave, etc.)
1. Open `chrome://extensions`
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked**
4. Select the extension folder (the one containing `manifest.json`)

### Firefox
Permanent installation requires the extension to be signed by Mozilla. To try it locally:
1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on**
3. Select the `manifest.json` file inside the extension folder

> **Note:** A temporary add-on in Firefox is removed when the browser closes. For a permanent install, the extension needs to be submitted to [addons.mozilla.org](https://addons.mozilla.org) (it can be submitted as *unlisted* to get it signed without publishing it publicly).

---

## How to Use

1. Open the extension and type a game's name in the search box
2. Select the game from the results
3. Enter the price you want to be notified at
4. Click **Add**
5. Pick a check interval (1h / 3h / 6h / 12h / 24h) — this applies to all tracked games
6. Optionally, set your **region** so prices match your local Steam store, and toggle **repeat alerts** if you'd like to be notified on every check instead of just once

Once set up, the extension checks in the background on its own — no need to keep the popup open. On browser launch, it verifies how much time is left before the next scheduled check and continues counting down from there, rather than restarting the timer.

When a tracked game's price reaches your target, you'll get a desktop notification with the game's name and current price. You can edit a game's target price anytime using the pencil (✎) icon next to it.

---

## Technical Notes

- Prices are fetched from Steam's official public store API (`store.steampowered.com/api`) rather than scraped from SteamDB, since SteamDB does not offer a public API and its terms of service prohibit automated scraping. The underlying price data is identical — it's the same Steam Store pricing SteamDB itself displays.
- Built with Manifest V3, using `chrome.alarms` for scheduling — supported natively in both Chrome and Firefox (109+ for Manifest V3, 121+ recommended for reliable alarm persistence across browser restarts).
- All data (tracked games, settings, last check time) is stored locally using `chrome.storage.local` — nothing is sent to any third-party server besides Steam's own API.
