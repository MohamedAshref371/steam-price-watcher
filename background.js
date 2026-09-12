// background.js — service worker: handles scheduling, checking, and notifications

if (typeof importScripts === "function") {
  importScripts("translations.js");
}

const ALARM_NAME = "price-check-alarm";
const DEFAULT_SETTINGS = {
  intervalHours: 12,   // 1, 3, 6, 12, or 24
  countryCode: "eg",   // Steam store region (affects currency/pricing) — changeable from the popup
  language: "ar",      // ar or en
  repeatAlerts: true,  // false = notify once per price, true = notify every check while below target
  sortBy: "default"    // default | cheapest | closest | discount
};

// Guesses a reasonable default region and language from the browser's own locale
// (best-effort, no network/permissions needed — only used on first install)
function detectDefaultsFromLocale() {
  const uiLang = chrome.i18n.getUILanguage() || ""; // e.g. "ar-EG", "en-US", "ar"
  const [langPart, regionPart] = uiLang.toLowerCase().split("-");

  // Any valid 2-letter region code is used as-is, even if it's not in the popup's
  // preset list — the UI already falls back to its "custom region" field for that case
  const isValidCode = regionPart && /^[a-z]{2}$/.test(regionPart);
  const region = isValidCode ? regionPart : DEFAULT_SETTINGS.countryCode;
  const language = langPart === "ar" ? "ar" : "en";

  return { countryCode: region, language };
}

// ---------- Storage ----------

async function getState() {
  const data = await chrome.storage.local.get(["games", "settings", "lastChecked"]);
  return {
    games: data.games || [],
    settings: { ...DEFAULT_SETTINGS, ...(data.settings || {}) },
    lastChecked: data.lastChecked || null
  };
}

async function saveGames(games) {
  await chrome.storage.local.set({ games });
}

async function saveSettings(settings) {
  await chrome.storage.local.set({ settings });
}

async function setLastChecked(ts) {
  await chrome.storage.local.set({ lastChecked: ts });
}

// ---------- Steam API ----------

async function mapWithConcurrencyLimit(items, limit, fn) {
  const results = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Searches for a game by name, returns a list of {appid, name, image}
async function searchGames(term, countryCode, tr) {
  const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}&cc=${countryCode}&l=english`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(tr.searchError);
  const data = await res.json();
  const results = (data.items || []).map(item => ({
    appid: item.id,
    name: item.name,
    image: item.tiny_image
  }));

  const candidates = results.slice(0, 12);
  const flags = await mapWithConcurrencyLimit(candidates, 3, r => isAdultContent(r.appid, countryCode));
  return candidates.filter((_, i) => !flags[i]);
}

async function isAdultContent(appid, countryCode) {
  try {
    const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&cc=${countryCode}&filters=content_descriptors`;
    const res = await fetch(url);
    if (!res.ok) return false;
    const data = await res.json();
    const entry = data[String(appid)];
    const ids = entry?.data?.content_descriptors?.ids || [];
    return ids.includes(3) || ids.includes(4);
  } catch (e) {
    return false;
  }
}

// Fetches current price data for a single appid
async function fetchPrice(appid, countryCode) {
  const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&cc=${countryCode}&filters=price_overview,basic`;
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new Error(`network: ${e.message || e}`);
  }
  if (!res.ok) throw new Error(`http_${res.status}`);

  let data;
  try {
    data = await res.json();
  } catch (e) {
    throw new Error("invalid_json_response");
  }

  const entry = data[String(appid)];
  if (!entry || !entry.success) {
    return { ok: false, reason: "not_found" };
  }
  const overview = entry.data && entry.data.price_overview;
  if (!overview) {
    // Game may be free, or unavailable in this region
    return { ok: true, free: true, currentPrice: 0, currency: null, discountPercent: 0, formatted: null };
  }
  return {
    ok: true,
    free: false,
    currentPrice: overview.final / 100,
    initialPrice: overview.initial / 100,
    currency: overview.currency,
    discountPercent: overview.discount_percent,
    formatted: overview.final_formatted
  };
}

// ---------- Price-check logic ----------

// Checks a single game and returns its updated version (does not save or notify — left to the caller)
async function checkOneGame(game, settings, tr) {
  try {
    const priceInfo = await fetchPrice(game.appid, settings.countryCode);
    if (!priceInfo.ok) {
      return { updated: { ...game, lastError: tr.errorPriceFetch }, alert: null };
    }

    const updated = {
      ...game,
      lastError: null,
      lastPrice: priceInfo.currentPrice,
      lastFormattedPrice: priceInfo.free ? tr.freeLabel : priceInfo.formatted,
      lastCurrency: priceInfo.currency,
      lastDiscount: priceInfo.discountPercent || 0,
      lastCheckedAt: Date.now()
    };

    const alertType = game.alertType || "target"; // backwards compatibility with games added before this feature

    const reachedTarget = !priceInfo.free && (
      alertType === "sale"
        ? (priceInfo.discountPercent || 0) > 0
        : game.targetPrice != null && priceInfo.currentPrice <= game.targetPrice
    );

    let alert = null;

    if (game.muted) {
      // Muted: update the price but never alert, and reset the notified marker
      // so that unmuting later can trigger a fresh alert if the target is still met
      updated.notifiedAtPrice = null;
    } else if (settings.repeatAlerts) {
      // Alert on every check while the price stays at/below target (no dedup)
      if (reachedTarget) {
        updated.notifiedAtPrice = priceInfo.currentPrice;
        alert = { game: updated, priceInfo };
      } else {
        updated.notifiedAtPrice = null;
      }
    } else {
      // Default behavior: alert once per distinct price
      const alreadyNotifiedForThisPrice =
        game.notifiedAtPrice != null && game.notifiedAtPrice === priceInfo.currentPrice;

      if (reachedTarget && !alreadyNotifiedForThisPrice) {
        updated.notifiedAtPrice = priceInfo.currentPrice;
        alert = { game: updated, priceInfo };
      } else if (!reachedTarget) {
        updated.notifiedAtPrice = null;
      }
    }

    return { updated, alert };
  } catch (e) {
    return { updated: { ...game, lastError: tr.errorGeneric }, alert: null };
  }
}

// Checks every saved game (periodic/manual check)
async function checkAllGames({ notify = true } = {}) {
  const { games, settings } = await getState();
  const tr = t(settings.language);

  if (!games.length) {
    await setLastChecked(Date.now());
    return { games, alerts: [] };
  }

  const alerts = [];
  const updatedGames = [];

  for (const game of games) {
    const { updated, alert } = await checkOneGame(game, settings, tr);
    updatedGames.push(updated);
    if (alert) alerts.push(alert);
  }

  await saveGames(updatedGames);
  await setLastChecked(Date.now());

  if (notify) {
    for (const a of alerts) {
      fireNotification(a.game, a.priceInfo, tr);
    }
  }

  return { games: updatedGames, alerts };
}

// Checks a single game by id and saves just that result —
// used right after adding a new game, without re-checking the rest
async function checkSingleGameById(gameId, { notify = true } = {}) {
  const { games, settings } = await getState();
  const tr = t(settings.language);
  const target = games.find(g => g.id === gameId);
  if (!target) return null;

  const { updated, alert } = await checkOneGame(target, settings, tr);
  const updatedGames = games.map(g => (g.id === gameId ? updated : g));
  await saveGames(updatedGames);

  chrome.runtime.sendMessage({ type: "GAME_CHECK_DONE", gameId, game: updated }).catch(() => {});

  if (notify && alert) {
    fireNotification(alert.game, alert.priceInfo, tr);
  }

  return updated;
}

function fireNotification(game, priceInfo, tr) {
  const idSafe = `price-alert-${game.appid}-${Date.now()}`;
  chrome.notifications.create(idSafe, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: tr.notifTitle,
    message:
      game.alertType === "sale"
        ? tr.notifMessageSale(game.name, priceInfo.formatted, priceInfo.discountPercent)
        : tr.notifMessage(game.name, priceInfo.formatted, `${game.targetPrice} ${game.currencyLabel || ""}`.trim()),
    priority: 2
  });
}

// Clicking the notification opens the game's Steam store page directly
chrome.notifications.onClicked.addListener(notificationId => {
  const match = notificationId.match(/^price-alert-(\d+)-/);
  if (match) {
    const appid = match[1];
    chrome.tabs.create({ url: `https://store.steampowered.com/app/${appid}` });
    chrome.notifications.clear(notificationId);
  }
});

// ---------- Scheduling (Alarms) ----------

async function rescheduleAlarm() {
  const { settings, lastChecked } = await getState();
  await chrome.alarms.clear(ALARM_NAME);

  const periodMinutes = Math.max(1, settings.intervalHours * 60);

  // Compute the actual time left since the last real check, instead of restarting the countdown
  let delayMinutes = periodMinutes;
  if (lastChecked) {
    const elapsedMinutes = (Date.now() - lastChecked) / 60000;
    const remaining = periodMinutes - elapsedMinutes;
    delayMinutes = remaining > 0 ? remaining : 0.1; // already overdue: check almost immediately
  }

  chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: delayMinutes,
    periodInMinutes: periodMinutes
  });
}

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM_NAME) {
    checkAllGames({ notify: true });
  }
});

chrome.runtime.onInstalled.addListener(async details => {
  const { settings, lastChecked } = await getState();

  if (details.reason === "install") {
    // Fresh install: guess a sensible region/language from the browser's settings
    const detected = detectDefaultsFromLocale();
    settings.countryCode = detected.countryCode;
    settings.language = detected.language;
    if (lastChecked == null) {
      await setLastChecked(Date.now());
    }
  }

  await saveSettings(settings);
  await rescheduleAlarm();
});

// Fires when the browser itself launches — not when the popup is opened
chrome.runtime.onStartup.addListener(async () => {
  await rescheduleAlarm();
});

// ---------- Messages from the popup ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg).then(sendResponse);
  return true; // keep the message channel open for the async response
});

async function handleMessage(msg) {
  try {
    const state = await getState();
    const { settings, games } = state;
    const tr = t(settings.language);

    switch (msg.type) {
      case "GET_STATE": {
        return { ok: true, data: state };
      }
      case "SEARCH_GAME": {
        const results = await searchGames(msg.term, settings.countryCode, tr);
        return { ok: true, data: results };
      }
      case "PREVIEW_PRICE": {
        const priceInfo = await fetchPrice(msg.appid, settings.countryCode);
        return { ok: true, data: priceInfo };
      }
      case "ADD_GAME": {
        const newGame = {
          id: crypto.randomUUID(),
          appid: msg.game.appid,
          name: msg.game.name,
          image: msg.game.image || null,
          alertType: msg.game.alertType === "sale" ? "sale" : "target",
          targetPrice: msg.game.alertType === "sale" ? null : msg.game.targetPrice,
          currencyLabel: msg.game.currencyLabel || "",
          lastPrice: null,
          lastFormattedPrice: null,
          lastDiscount: null,
          lastCheckedAt: null,
          lastError: null,
          notifiedAtPrice: null
        };
        const updatedGames = [...games, newGame];
        await saveGames(updatedGames);
        // Only check this new game right away — no need to re-check the rest
        checkSingleGameById(newGame.id, { notify: true });
        return { ok: true, data: updatedGames };
      }
      case "REMOVE_GAME": {
        const updatedGames = games.filter(g => g.id !== msg.id);
        await saveGames(updatedGames);
        return { ok: true, data: updatedGames };
      }
      case "UPDATE_GAME": {
        const updatedGames = games.map(g =>
          g.id === msg.id ? { ...g, ...msg.patch, notifiedAtPrice: null } : g
        );
        await saveGames(updatedGames);
        return { ok: true, data: updatedGames };
      }
      case "UPDATE_SETTINGS": {
        const updatedSettings = { ...settings, ...msg.patch };
        await saveSettings(updatedSettings);
        await rescheduleAlarm();
        return { ok: true, data: updatedSettings };
      }
      case "FORCE_CHECK": {
        const result = await checkAllGames({ notify: true });
        await rescheduleAlarm(); // realign the next scheduled check to this manual one
        return { ok: true, data: result };
      }
      default:
        return { ok: false, error: tr.unknownCommand };
    }
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
};
