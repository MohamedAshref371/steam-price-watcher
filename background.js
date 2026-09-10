// background.js — service worker: يدير الجدولة، الفحص، والتنبيهات

importScripts("translations.js");

const ALARM_NAME = "price-check-alarm";
const DEFAULT_SETTINGS = {
  intervalHours: 12,   // 1 أو 3 أو 6 أو 12 أو 24
  countryCode: "eg",   // كود الدولة المستخدم في أسعار Steam (يؤثر على العملة) — غيّره من إعدادات الإضافة
  language: "ar",       // ar أو en
  repeatAlerts: false,  // false = نبّه مرة واحدة فقط لكل سعر، true = نبّه في كل فحص طالما السعر تحت الهدف
  sortBy: "default"     // default | cheapest | closest | discount
};

// يحاول تخمين الدولة واللغة المناسبة بناءً على لغة/إقليم المتصفح نفسه
// (تقريب عملي بدون شبكة أو صلاحيات إضافية — يُستخدم فقط أول مرة تُثبَّت فيها الإضافة)
function detectDefaultsFromLocale() {
  const uiLang = chrome.i18n.getUILanguage() || ""; // مثال: "ar-EG" أو "en-US" أو "ar"
  const [langPart, regionPart] = uiLang.toLowerCase().split("-");

  // أي كود دولة صالح (حرفين) نستخدمه كما هو، حتى لو مش من الدول الجاهزة في القائمة —
  // الواجهة أصلاً بتعرضه تلقائياً في خانة "دولة أخرى" (custom) لو مش موجود في القائمة الجاهزة
  const isValidCode = regionPart && /^[a-z]{2}$/.test(regionPart);
  const region = isValidCode ? regionPart : DEFAULT_SETTINGS.countryCode;
  const language = langPart === "ar" ? "ar" : "en";

  return { countryCode: region, language };
}

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
async function searchGames(term, countryCode, tr) {
  const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}&cc=${countryCode}&l=english`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(tr.searchError);
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
    // قد تكون اللعبة مجانية أو غير متوفرة في هذه المنطقة
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

// ---------- منطق الفحص ----------

// يفحص لعبة واحدة ويرجّع النسخة المحدّثة منها (بدون حفظ أو إشعار — تُترك للمستدعي)
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

    const alertType = game.alertType || "target"; // توافق مع الألعاب المضافة قبل هذه الميزة

    const reachedTarget = !priceInfo.free && (
      alertType === "sale"
        ? (priceInfo.discountPercent || 0) > 0
        : game.targetPrice != null && priceInfo.currentPrice <= game.targetPrice
    );

    let alert = null;

    if (game.muted) {
      // اللعبة مكتومة: نحدّث السعر بس بدون أي تنبيه، ونصفّر مؤشر التنبيه
      // عشان لو اتشالت الكتمة بعدين، يقدر يبعث تنبيه جديد لو السعر لسا واصل للهدف
      updated.notifiedAtPrice = null;
    } else if (settings.repeatAlerts) {
      // ينبّه في كل فحص طالما السعر لسا تحت الهدف (بدون تجاهل تكرارات نفس السعر)
      if (reachedTarget) {
        updated.notifiedAtPrice = priceInfo.currentPrice;
        alert = { game: updated, priceInfo };
      } else {
        updated.notifiedAtPrice = null;
      }
    } else {
      // السلوك الافتراضي: ينبّه مرة واحدة فقط لنفس السعر بالضبط
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

// يفحص كل الألعاب المحفوظة (الفحص الدوري/اليدوي)
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

// يفحص لعبة واحدة فقط بالمعرّف (id) ويحفظ نتيجتها ضمن القائمة الحالية —
// يُستخدم مباشرة بعد إضافة لعبة جديدة، دون إعادة فحص بقية الألعاب
async function checkSingleGameById(gameId, { notify = true } = {}) {
  const { games, settings } = await getState();
  const tr = t(settings.language);
  const target = games.find(g => g.id === gameId);
  if (!target) return null;

  const { updated, alert } = await checkOneGame(target, settings, tr);
  const updatedGames = games.map(g => (g.id === gameId ? updated : g));
  await saveGames(updatedGames);

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

// عند الضغط على الإشعار، نفتح صفحة اللعبة في متجر Steam مباشرة
chrome.notifications.onClicked.addListener(notificationId => {
  const match = notificationId.match(/^price-alert-(\d+)-/);
  if (match) {
    const appid = match[1];
    chrome.tabs.create({ url: `https://store.steampowered.com/app/${appid}` });
    chrome.notifications.clear(notificationId);
  }
});

// ---------- الجدولة (Alarms) ----------

async function rescheduleAlarm() {
  const { settings, lastChecked } = await getState();
  await chrome.alarms.clear(ALARM_NAME);

  const periodMinutes = Math.max(1, settings.intervalHours * 60);

  // نحسب الوقت المتبقي فعلياً منذ آخر فحص حقيقي، بدل ما نبدأ عدّ جديد من الصفر
  let delayMinutes = periodMinutes;
  if (lastChecked) {
    const elapsedMinutes = (Date.now() - lastChecked) / 60000;
    const remaining = periodMinutes - elapsedMinutes;
    delayMinutes = remaining > 0 ? remaining : 0.1; // لو المدة عدّت أصلاً، فحص شبه فوري
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

// عند تثبيت/تحديث الإضافة
chrome.runtime.onInstalled.addListener(async details => {
  const { settings } = await getState();

  if (details.reason === "install") {
    // أول تثبيت فعلي: نخمّن الدولة واللغة المناسبة من إعدادات المتصفح
    const detected = detectDefaultsFromLocale();
    settings.countryCode = detected.countryCode;
    settings.language = detected.language;
  }

  await saveSettings(settings); // يضمن حفظ القيم الافتراضية أول مرة
  await rescheduleAlarm();
});

// عند فتح/إقلاع المتصفح نفسه (وليس عند فتح نافذة الإضافة)
chrome.runtime.onStartup.addListener(async () => {
  await rescheduleAlarm();
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
          const tr = t(settings.language);
          const results = await searchGames(msg.term, settings.countryCode, tr);
          sendResponse({ ok: true, data: results });
          break;
        }
        case "PREVIEW_PRICE": {
          const { settings } = await getState();
          const priceInfo = await fetchPrice(msg.appid, settings.countryCode);
          sendResponse({ ok: true, data: priceInfo });
          break;
        }
        case "ADD_GAME": {
          const { games } = await getState();
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
          sendResponse({ ok: true, data: updatedGames });
          // نفحص هذه اللعبة فقط فوراً حتى تظهر بياناتها — بدون إعادة فحص بقية الألعاب
          checkSingleGameById(newGame.id, { notify: true });
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
          await rescheduleAlarm(); // نعيد ضبط الموعد القادم بناءً على وقت هذا الفحص اليدوي
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
