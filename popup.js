// popup.js — واجهة الإضافة

const appTitleEl = document.getElementById("appTitle");
const langSelect = document.getElementById("langSelect");
const statusText = document.getElementById("statusText");
const refreshBtn = document.getElementById("refreshBtn");
const searchInput = document.getElementById("searchInput");
const searchBtn = document.getElementById("searchBtn");
const searchResultsEl = document.getElementById("searchResults");
const addForm = document.getElementById("addForm");
const selectedImg = document.getElementById("selectedImg");
const selectedName = document.getElementById("selectedName");
const currentPriceLabelText = document.getElementById("currentPriceLabelText");
const currentPriceValue = document.getElementById("currentPriceValue");
const alertTypeLabelText = document.getElementById("alertTypeLabelText");
const alertTypeTargetText = document.getElementById("alertTypeTargetText");
const alertTypeSaleText = document.getElementById("alertTypeSaleText");
const alertTypeRadios = document.querySelectorAll('input[name="alertType"]');
const targetPriceInput = document.getElementById("targetPriceInput");
const confirmAddBtn = document.getElementById("confirmAddBtn");
const cancelAddBtn = document.getElementById("cancelAddBtn");
const intervalLabelText = document.getElementById("intervalLabelText");
const intervalSelect = document.getElementById("intervalSelect");
const repeatAlertsCheckbox = document.getElementById("repeatAlertsCheckbox");
const repeatAlertsLabelText = document.getElementById("repeatAlertsLabelText");
const regionLabelText = document.getElementById("regionLabelText");
const regionSelect = document.getElementById("regionSelect");
const regionCustomInput = document.getElementById("regionCustomInput");
const sortLabelText = document.getElementById("sortLabelText");
const sortSelect = document.getElementById("sortSelect");
const gamesListEl = document.getElementById("gamesList");
const emptyStateEl = document.getElementById("emptyState");

let selectedGame = null;
let currentLang = "ar";
let currentGames = [];
let currentLastChecked = null;
let editingGameId = null;
let currentSortBy = "default";

function tr() {
  return t(currentLang);
}

function sendMessage(type, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...payload }, response => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response || !response.ok) {
        reject(new Error((response && response.error) || "Unknown error"));
        return;
      }
      resolve(response.data);
    });
  });
}

function formatRelativeTime(ts) {
  const T = tr();
  if (!ts) return T.neverChecked;
  const diffMs = Date.now() - ts;
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return T.justNow;
  if (mins < 60) return T.minutesAgo(mins);
  const hours = Math.round(mins / 60);
  if (hours < 24) return T.hoursAgo(hours);
  const days = Math.round(hours / 24);
  return T.daysAgo(days);
}

// ---------- تطبيق النصوص الثابتة حسب اللغة ----------

function applyStaticTexts() {
  const T = tr();
  document.documentElement.lang = currentLang;
  document.documentElement.dir = T.dir;

  appTitleEl.textContent = T.appTitle;
  refreshBtn.title = T.refreshTitle;
  searchInput.placeholder = T.searchPlaceholder;
  searchBtn.textContent = T.searchBtn;
  currentPriceLabelText.textContent = T.currentPriceLabel;
  alertTypeLabelText.textContent = T.alertTypeLabel;
  alertTypeTargetText.textContent = T.alertTypeTargetOption;
  alertTypeSaleText.textContent = T.alertTypeSaleOption;
  targetPriceInput.placeholder = T.targetPricePlaceholder;
  confirmAddBtn.textContent = T.addBtn;
  cancelAddBtn.textContent = T.cancelBtn;
  intervalLabelText.textContent = T.intervalLabel;
  repeatAlertsLabelText.textContent = T.repeatAlertsLabel;
  regionLabelText.textContent = T.regionLabel;
  regionCustomInput.placeholder = T.regionCustomPlaceholder;
  sortLabelText.textContent = T.sortLabel;
  emptyStateEl.textContent = T.emptyState;

  const sortOptions = sortSelect.querySelectorAll("option");
  sortOptions[0].textContent = T.sortDefault;
  sortOptions[1].textContent = T.sortCheapest;
  sortOptions[2].textContent = T.sortClosest;
  sortOptions[3].textContent = T.sortDiscount;

  const intervalOptions = intervalSelect.querySelectorAll("option");
  intervalOptions[0].textContent = T.interval1;
  intervalOptions[1].textContent = T.interval3;
  intervalOptions[2].textContent = T.interval6;
  intervalOptions[3].textContent = T.interval12;
  intervalOptions[4].textContent = T.interval24;
}

// ---------- ترتيب القائمة ----------

function sortGames(games, sortBy) {
  const arr = [...games];
  switch (sortBy) {
    case "cheapest":
      arr.sort((a, b) => {
        if (a.lastPrice == null) return 1;
        if (b.lastPrice == null) return -1;
        return a.lastPrice - b.lastPrice;
      });
      break;
    case "closest":
      arr.sort((a, b) => {
        const gapA = a.lastPrice != null && a.targetPrice != null ? a.lastPrice - a.targetPrice : Infinity;
        const gapB = b.lastPrice != null && b.targetPrice != null ? b.lastPrice - b.targetPrice : Infinity;
        return gapA - gapB;
      });
      break;
    case "discount":
      arr.sort((a, b) => (b.lastDiscount || 0) - (a.lastDiscount || 0));
      break;
    default:
      break; // ترتيب الإضافة كما هو
  }
  return arr;
}

// ---------- عرض قائمة الألعاب ----------

function renderGames(games) {
  currentGames = games;
  const T = tr();
  gamesListEl.innerHTML = "";
  if (!games.length) {
    emptyStateEl.classList.remove("hidden");
    return;
  }
  emptyStateEl.classList.add("hidden");

  const sortedGames = sortGames(games, currentSortBy);

  for (const game of sortedGames) {
    const li = document.createElement("li");
    li.className = "game-card";

    const reached =
      game.lastPrice != null &&
      game.targetPrice != null &&
      game.lastPrice <= game.targetPrice;

    const priceLabel = game.lastError
      ? "—"
      : game.lastFormattedPrice != null
      ? game.lastFormattedPrice
      : T.pendingCheck;

    const isEditing = editingGameId === game.id;
    const isMuted = !!game.muted;

    li.innerHTML = `
      <div class="row1">
        <span class="game-name">${escapeHtml(game.name)}</span>
        <span class="card-actions">
          <button class="mute-btn ${isMuted ? "is-muted" : ""}" title="${escapeHtml(isMuted ? T.unmuteTitle : T.muteTitle)}">${isMuted ? "🔕" : "🔔"}</button>
          ${game.alertType !== "sale" ? `<button class="edit-btn" title="${escapeHtml(T.editTitle)}">✎</button>` : ""}
          <button class="remove-btn" title="${escapeHtml(T.removeTitle)}">✕</button>
        </span>
      </div>
      <div class="row1">
        <span class="game-price ${reached ? "" : "above-target"}">${escapeHtml(priceLabel)}</span>
        <span>
          ${game.lastDiscount ? `<span class="discount-badge">-${game.lastDiscount}%</span>` : ""}
          ${isMuted ? `<span class="muted-badge">${escapeHtml(T.mutedBadge)}</span>` : reached ? `<span class="reached-badge">${escapeHtml(T.reachedBadge)}</span>` : ""}
        </span>
      </div>
      <div class="game-meta">
        <span>${game.alertType === "sale" ? escapeHtml(T.targetMetaSale) : `${escapeHtml(T.targetMetaLabel)} ${game.targetPrice != null ? game.targetPrice : "—"}`}</span>
        <span>${escapeHtml(T.lastCheckedPrefix)} ${formatRelativeTime(game.lastCheckedAt)}</span>
      </div>
      ${game.lastError ? `<span class="error-text">${escapeHtml(game.lastError)}</span>` : ""}
      ${isEditing && game.alertType !== "sale" ? `
        <div class="edit-target-row">
          <input type="number" step="0.01" min="0" class="edit-target-input" value="${game.targetPrice != null ? game.targetPrice : ""}" />
          <button class="save-target-btn">${escapeHtml(T.saveBtn)}</button>
          <button class="cancel-edit-btn secondary">${escapeHtml(T.cancelBtn)}</button>
        </div>
      ` : ""}
    `;

    li.querySelector(".remove-btn").addEventListener("click", async () => {
      const games = await sendMessage("REMOVE_GAME", { id: game.id });
      renderGames(games);
    });

    li.querySelector(".mute-btn").addEventListener("click", async () => {
      const games = await sendMessage("UPDATE_GAME", { id: game.id, patch: { muted: !isMuted } });
      renderGames(games);
    });

    li.querySelector(".edit-btn")?.addEventListener("click", () => {
      editingGameId = isEditing ? null : game.id;
      renderGames(currentGames);
    });

    if (isEditing) {
      const input = li.querySelector(".edit-target-input");
      li.querySelector(".save-target-btn").addEventListener("click", async () => {
        const newTarget = parseFloat(input.value);
        if (isNaN(newTarget) || newTarget < 0) {
          alert(tr().invalidPriceAlert);
          return;
        }
        const games = await sendMessage("UPDATE_GAME", { id: game.id, patch: { targetPrice: newTarget } });
        editingGameId = null;
        renderGames(games);
      });
      li.querySelector(".cancel-edit-btn").addEventListener("click", () => {
        editingGameId = null;
        renderGames(currentGames);
      });
    }

    gamesListEl.appendChild(li);
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

function refreshStatus(lastChecked) {
  currentLastChecked = lastChecked;
  statusText.textContent = `${tr().lastCheckedPrefix} ${formatRelativeTime(lastChecked)}`;
}

// ---------- تهيئة أولية ----------

// نافذة الإضافة تعرض فقط آخر حالة محفوظة — الفحص التلقائي عند تجاوز المدة
// يتم عند إقلاع المتصفح نفسه (في background.js)، وليس عند فتح هذه النافذة.
async function init() {
  const state = await sendMessage("GET_STATE");
  currentLang = state.settings.language || "ar";
  langSelect.value = currentLang;
  intervalSelect.value = String(state.settings.intervalHours);
  repeatAlertsCheckbox.checked = !!state.settings.repeatAlerts;
  currentSortBy = state.settings.sortBy || "default";
  sortSelect.value = currentSortBy;

  const knownRegions = Array.from(regionSelect.options).map(o => o.value).filter(v => v !== "__custom__");
  const savedRegion = state.settings.countryCode || "us";
  if (knownRegions.includes(savedRegion)) {
    regionSelect.value = savedRegion;
    regionCustomInput.classList.add("hidden");
  } else {
    regionSelect.value = "__custom__";
    regionCustomInput.value = savedRegion;
    regionCustomInput.classList.remove("hidden");
  }

  applyStaticTexts();
  renderGames(state.games);
  refreshStatus(state.lastChecked);
}

// ---------- أحداث ----------

langSelect.addEventListener("change", async () => {
  currentLang = langSelect.value;
  await sendMessage("UPDATE_SETTINGS", { patch: { language: currentLang } });
  applyStaticTexts();
  renderGames(currentGames);
  refreshStatus(currentLastChecked);
});

refreshBtn.addEventListener("click", async () => {
  statusText.textContent = tr().checking;
  const result = await sendMessage("FORCE_CHECK");
  renderGames(result.games);
  refreshStatus(Date.now());
});

intervalSelect.addEventListener("change", async () => {
  await sendMessage("UPDATE_SETTINGS", { patch: { intervalHours: Number(intervalSelect.value) } });
});

repeatAlertsCheckbox.addEventListener("change", async () => {
  await sendMessage("UPDATE_SETTINGS", { patch: { repeatAlerts: repeatAlertsCheckbox.checked } });
});

sortSelect.addEventListener("change", async () => {
  currentSortBy = sortSelect.value;
  await sendMessage("UPDATE_SETTINGS", { patch: { sortBy: currentSortBy } });
  renderGames(currentGames);
});

async function applyRegionChange(code) {
  if (!code || code.length !== 2) return;
  statusText.textContent = tr().checking;
  await sendMessage("UPDATE_SETTINGS", { patch: { countryCode: code.toLowerCase() } });
  const result = await sendMessage("FORCE_CHECK");
  renderGames(result.games);
  refreshStatus(Date.now());
}

regionSelect.addEventListener("change", async () => {
  if (regionSelect.value === "__custom__") {
    regionCustomInput.classList.remove("hidden");
    regionCustomInput.focus();
    return;
  }
  regionCustomInput.classList.add("hidden");
  await applyRegionChange(regionSelect.value);
});

regionCustomInput.addEventListener("change", async () => {
  await applyRegionChange(regionCustomInput.value.trim());
});

searchBtn.addEventListener("click", doSearch);
searchInput.addEventListener("keydown", e => {
  if (e.key === "Enter") doSearch();
});

async function doSearch() {
  const term = searchInput.value.trim();
  if (!term) return;
  const T = tr();
  searchResultsEl.innerHTML = `<p style='padding:6px;color:#8f98a0;'>${escapeHtml(T.searching)}</p>`;
  searchResultsEl.classList.remove("hidden");
  try {
    const results = await sendMessage("SEARCH_GAME", { term });
    if (!results.length) {
      searchResultsEl.innerHTML = `<p style='padding:6px;color:#8f98a0;'>${escapeHtml(T.noResults)}</p>`;
      return;
    }
    searchResultsEl.innerHTML = "";
    for (const r of results.slice(0, 8)) {
      const div = document.createElement("div");
      div.className = "search-result-item";
      div.innerHTML = `<img src="${r.image || ""}" alt="" /><span>${escapeHtml(r.name)}</span>`;
      div.addEventListener("click", () => selectGame(r));
      searchResultsEl.appendChild(div);
    }
  } catch (e) {
    searchResultsEl.innerHTML = `<p style='padding:6px;color:#e23f3f;'>${escapeHtml(e.message)}</p>`;
  }
}

function setAlertTypeUI(type) {
  const isSale = type === "sale";
  targetPriceInput.classList.toggle("hidden", isSale);
  targetPriceInput.required = !isSale;
}

alertTypeRadios.forEach(radio => {
  radio.addEventListener("change", () => {
    setAlertTypeUI(radio.value);
  });
});

async function selectGame(game) {
  selectedGame = game;
  selectedImg.src = game.image || "";
  selectedName.textContent = game.name;
  addForm.classList.remove("hidden");
  searchResultsEl.classList.add("hidden");

  // نرجّع اختيار النوع لوضعه الافتراضي (هدف سعري) في كل مرة نختار لعبة جديدة
  alertTypeRadios.forEach(r => (r.checked = r.value === "target"));
  setAlertTypeUI("target");

  currentPriceValue.textContent = tr().fetchingPrice;
  targetPriceInput.focus();

  try {
    const priceInfo = await sendMessage("PREVIEW_PRICE", { appid: game.appid });
    if (!priceInfo.ok) {
      currentPriceValue.textContent = "—";
    } else if (priceInfo.free) {
      currentPriceValue.textContent = tr().freeLabel;
    } else {
      currentPriceValue.textContent = priceInfo.discountPercent
        ? `${priceInfo.formatted} (-${priceInfo.discountPercent}%)`
        : priceInfo.formatted;
    }
  } catch (e) {
    currentPriceValue.textContent = `${tr().errorPriceFetch} (${e.message})`;
    console.error("PREVIEW_PRICE failed:", e);
  }
}

cancelAddBtn.addEventListener("click", () => {
  selectedGame = null;
  addForm.classList.add("hidden");
  targetPriceInput.value = "";
});

confirmAddBtn.addEventListener("click", async () => {
  if (!selectedGame) return;
  const alertType = document.querySelector('input[name="alertType"]:checked').value;

  let targetPrice = null;
  if (alertType === "target") {
    targetPrice = parseFloat(targetPriceInput.value);
    if (isNaN(targetPrice) || targetPrice < 0) {
      alert(tr().invalidPriceAlert);
      return;
    }
  }

  const games = await sendMessage("ADD_GAME", {
    game: { appid: selectedGame.appid, name: selectedGame.name, image: selectedGame.image, alertType, targetPrice }
  });
  renderGames(games);
  addForm.classList.add("hidden");
  targetPriceInput.value = "";
  searchInput.value = "";
  selectedGame = null;

  // نعيد الفحص بعد لحظة قصيرة لعرض السعر الفعلي فور توفره
  setTimeout(async () => {
    const state = await sendMessage("GET_STATE");
    renderGames(state.games);
    refreshStatus(state.lastChecked);
  }, 1500);
});

init();
