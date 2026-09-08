// background.js — service worker: يدير الجدولة، الفحص، والتنبيهات

const ALARM_NAME = "price-check-alarm";
const DEFAULT_SETTINGS = {
  intervalHours: 12,   // 1 أو 12 أو 24
  countryCode: "us"    // كود الدولة المستخدم في أسعار Steam (يؤثر على العملة)
};

// ---------- تخزين ----------

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

// يبحث عن لعبة بالاسم ويرجع قائمة نتائج {appid, name, image}
async function searchGames(term, countryCode) {
  const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}&cc=${countryCode}&l=english`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("فشل البحث في متجر Steam");
  const data = await res.json();
  return (data.items || []).map(item => ({
    appid: item.id,
    name: item.name,
    image: item.tiny_image
  }));
}

// يجلب بيانات السعر الحالية للعبة appid واحدة
async function fetchPrice(appid, countryCode) {
  const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&cc=${countryCode}&filters=price_overview,basic`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("فشل الاتصال بمتجر Steam");
  const data = await res.json();
  const entry = data[String(appid)];
  if (!entry || !entry.success) {
    return { ok: false, reason: "not_found" };
  }
  const overview = entry.data && entry.data.price_overview;
  if (!overview) {
    // قد تكون اللعبة مجانية أو غير متوفرة في هذه المنطقة
    return { ok: true, free: true, currentPrice: 0, currency: null, discountPercent: 0, formatted: "مجانية" };
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

// ---------- منطق الفحص ----------

async function checkAllGames({ notify = true } = {}) {
  const { games, settings } = await getState();
  if (!games.length) {
    await setLastChecked(Date.now());
    return { games, alerts: [] };
  }

  const alerts = [];
  const updatedGames = [];

  for (const game of games) {
    try {
      const priceInfo = await fetchPrice(game.appid, settings.countryCode);
      if (!priceInfo.ok) {
        updatedGames.push({ ...game, lastError: "تعذّر جلب السعر" });
        continue;
      }

      const updated = {
        ...game,
        lastError: null,
        lastPrice: priceInfo.currentPrice,
        lastFormattedPrice: priceInfo.formatted,
        lastCurrency: priceInfo.currency,
        lastDiscount: priceInfo.discountPercent || 0,
        lastCheckedAt: Date.now()
      };

      const reachedTarget =
        !priceInfo.free &&
        game.targetPrice != null &&
        priceInfo.currentPrice <= game.targetPrice;

      // نتجنّب تكرار نفس التنبيه لنفس السعر بالضبط
      const alreadyNotifiedForThisPrice =
        game.notifiedAtPrice != null && game.notifiedAtPrice === priceInfo.currentPrice;

      if (reachedTarget && !alreadyNotifiedForThisPrice) {
        updated.notifiedAtPrice = priceInfo.currentPrice;
        alerts.push({ game: updated, priceInfo });
      } else if (!reachedTarget) {
        updated.notifiedAtPrice = null;
      }

      updatedGames.push(updated);
    } catch (e) {
      updatedGames.push({ ...game, lastError: "خطأ أثناء الفحص" });
    }
  }

  await saveGames(updatedGames);
  await setLastChecked(Date.now());

  if (notify) {
    for (const a of alerts) {
      fireNotification(a.game, a.priceInfo);
    }
  }

  return { games: updatedGames, alerts };
}

function fireNotification(game, priceInfo) {
  const idSafe = `price-alert-${game.id}-${Date.now()}`;
  chrome.notifications.create(idSafe, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: "نزل سعر لعبتك! 🎮",
    message: `${game.name}: صار السعر ${priceInfo.formatted} (هدفك كان ${game.targetPrice} ${game.currencyLabel || ""})`,
    priority: 2
  });
}

// ---------- الجدولة (Alarms) ----------

async function rescheduleAlarm() {
  const { settings } = await getState();
  await chrome.alarms.clear(ALARM_NAME);
  chrome.alarms.create(ALARM_NAME, {
    periodInMinutes: Math.max(1, settings.intervalHours * 60)
  });
}

// يتحقق: هل عدّت مدة الفحص المحددة منذ آخر فحص؟ إذا نعم يفحص فوراً
async function checkIfStaleThenRun() {
  const { lastChecked, settings, games } = await getState();
  if (!games.length) return; // ما فيه شي نراقبه أصلاً

  const intervalMs = settings.intervalHours * 60 * 60 * 1000;
  const isStale = !lastChecked || Date.now() - lastChecked >= intervalMs;

  if (isStale) {
    await checkAllGames({ notify: true });
  }
}

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM_NAME) {
    checkAllGames({ notify: true });
  }
});

// عند تثبيت/تحديث الإضافة
chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await getState();
  await saveSettings(settings); // يضمن حفظ القيم الافتراضية أول مرة
  await rescheduleAlarm();
  await checkIfStaleThenRun();
});

// عند فتح/إقلاع المتصفح نفسه (وليس عند فتح نافذة الإضافة)
chrome.runtime.onStartup.addListener(async () => {
  await rescheduleAlarm();
  await checkIfStaleThenRun();
});

// ---------- الرسائل من الـ popup ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case "GET_STATE": {
          sendResponse({ ok: true, data: await getState() });
          break;
        }
        case "SEARCH_GAME": {
          const { settings } = await getState();
          const results = await searchGames(msg.term, settings.countryCode);
          sendResponse({ ok: true, data: results });
          break;
        }
        case "ADD_GAME": {
          const { games } = await getState();
          const newGame = {
            id: crypto.randomUUID(),
            appid: msg.game.appid,
            name: msg.game.name,
            image: msg.game.image || null,
            targetPrice: msg.game.targetPrice,
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
          sendResponse({ ok: true, data: updatedGames });
          // نفحص هذه اللعبة فوراً حتى تظهر بياناتها بدون انتظار الجدول
          checkAllGames({ notify: true });
          break;
        }
        case "REMOVE_GAME": {
          const { games } = await getState();
          const updatedGames = games.filter(g => g.id !== msg.id);
          await saveGames(updatedGames);
          sendResponse({ ok: true, data: updatedGames });
          break;
        }
        case "UPDATE_GAME": {
          const { games } = await getState();
          const updatedGames = games.map(g =>
            g.id === msg.id ? { ...g, ...msg.patch, notifiedAtPrice: null } : g
          );
          await saveGames(updatedGames);
          sendResponse({ ok: true, data: updatedGames });
          break;
        }
        case "UPDATE_SETTINGS": {
          const { settings } = await getState();
          const updatedSettings = { ...settings, ...msg.patch };
          await saveSettings(updatedSettings);
          await rescheduleAlarm();
          sendResponse({ ok: true, data: updatedSettings });
          break;
        }
        case "FORCE_CHECK": {
          const result = await checkAllGames({ notify: true });
          sendResponse({ ok: true, data: result });
          break;
        }
        default:
          sendResponse({ ok: false, error: "أمر غير معروف" });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e.message || String(e) });
    }
  })();
  return true; // نبقي القناة مفتوحة للرد غير المتزامن
});
