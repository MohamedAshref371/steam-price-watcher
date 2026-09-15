// popup.js — extension popup UI

const MAX_TARGET_PRICE = 9999999;

const appTitleEl = document.getElementById("appTitle");
const langSelect = document.getElementById("langSelect");
const statusText = document.getElementById("statusText");
const refreshBtn = document.getElementById("refreshBtn");
const openTabBtn = document.getElementById("openTabBtn");
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
const duplicateWarningText = document.getElementById("duplicateWarningText");
const targetPriceError = document.getElementById("targetPriceErrorText");
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
        reject(new Error((response && response.error) || tr().unknownError));
        return;
      }
      resolve(response.data);
    });
  });
}

function formatRelativeTime(ts, showSub = true) {
  const T = tr();
  if (!ts) return T.neverChecked;
  const diffMs = Date.now() - ts;

  const totalMins = Math.round(diffMs / 60000);
  if (totalMins < 1) return T.justNow;
  if (totalMins < 60) return T.minutesAgo(totalMins);

  const rawHours = diffMs / 3600000;
  if (rawHours < 24) {
    const hours = showSub ? Math.floor(rawHours) : Math.round(rawHours);
    const remMins = showSub ? totalMins % 60 : 0;
    return T.hoursAgo(hours, remMins);
  }

  const rawDays = diffMs / 86400000;
  const days = showSub ? Math.floor(rawDays) : Math.round(rawDays);
  const remHours = showSub ? Math.floor(rawHours) % 24 : 0;
  return T.daysAgo(days, remHours);
}

// ---------- Applying UI text per language ----------

function applyStaticTexts() {
  const T = tr();
  document.documentElement.lang = currentLang;
  document.documentElement.dir = T.dir;

  appTitleEl.textContent = T.appTitle;
  refreshBtn.title = T.refreshTitle;
  openTabBtn.title = T.openTabTitle;
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
  duplicateWarningText.textContent = T.gameAlreadyAdded;
  targetPriceError.textContent = T.invalidPriceAlert;

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

// ---------- Sorting the list ----------

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
      break; // keep insertion order
  }
  return arr;
}

// ---------- Rendering the games list ----------

// Builds a single game card element via DOM APIs (no innerHTML, so nothing needs manual escaping)
function buildGameCard(game, T) {
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

  // Row 1: name + action buttons
  const row1 = document.createElement("div");
  row1.className = "row1";

  const nameSpan = document.createElement("span");
  nameSpan.className = "game-name";
  nameSpan.textContent = game.name;
  row1.appendChild(nameSpan);

  const actions = document.createElement("span");
  actions.className = "card-actions";

  const linkBtn = document.createElement("a");
  linkBtn.className = "link-btn";
  linkBtn.href = `https://store.steampowered.com/app/${game.appid}`;
  linkBtn.target = "_blank";
  linkBtn.rel = "noopener";
  linkBtn.title = T.linkTitle;
  linkBtn.textContent = "🔗";
  actions.appendChild(linkBtn);

  const muteBtn = document.createElement("button");
  muteBtn.className = "mute-btn" + (isMuted ? " is-muted" : "");
  muteBtn.title = isMuted ? T.unmuteTitle : T.muteTitle;
  muteBtn.textContent = isMuted ? "🔕" : "🔔";
  muteBtn.addEventListener("click", async () => {
    const games = await sendMessage("UPDATE_GAME", { id: game.id, patch: { muted: !isMuted } });
    renderGames(games);
  });
  actions.appendChild(muteBtn);

  if (game.alertType !== "sale") {
    const editBtn = document.createElement("button");
    editBtn.className = "edit-btn";
    editBtn.title = T.editTitle;
    editBtn.textContent = "✎";
    editBtn.addEventListener("click", () => {
      editingGameId = isEditing ? null : game.id;
      renderGames(currentGames);
    });
    actions.appendChild(editBtn);
  }

  const removeBtn = document.createElement("button");
  removeBtn.className = "remove-btn";
  removeBtn.title = T.removeTitle;
  removeBtn.textContent = "✕";
  removeBtn.addEventListener("click", async () => {
    const games = await sendMessage("REMOVE_GAME", { id: game.id });
    renderGames(games);
  });
  actions.appendChild(removeBtn);

  row1.appendChild(actions);
  li.appendChild(row1);

  // Row 2: price + badges
  const row2 = document.createElement("div");
  row2.className = "row1";

  const priceSpan = document.createElement("span");
  priceSpan.className = "game-price" + (reached ? "" : " above-target");
  priceSpan.textContent = priceLabel;
  row2.appendChild(priceSpan);

  const badges = document.createElement("span");
  if (game.lastDiscount) {
    const discountBadge = document.createElement("span");
    discountBadge.className = "discount-badge";
    discountBadge.textContent = `-${game.lastDiscount}%`;
    badges.appendChild(discountBadge);
  }
  if (isMuted) {
    const mutedBadge = document.createElement("span");
    mutedBadge.className = "muted-badge";
    mutedBadge.textContent = T.mutedBadge;
    badges.appendChild(mutedBadge);
  } else if (reached) {
    const reachedBadge = document.createElement("span");
    reachedBadge.className = "reached-badge";
    reachedBadge.textContent = T.reachedBadge;
    badges.appendChild(reachedBadge);
  }
  row2.appendChild(badges);
  li.appendChild(row2);

  // Meta row: target/alert type + last checked
  const meta = document.createElement("div");
  meta.className = "game-meta";

  const targetMetaSpan = document.createElement("span");
  targetMetaSpan.textContent =
    game.alertType === "sale"
      ? T.targetMetaSale
      : `${T.targetMetaLabel} ${game.targetPrice != null ? game.targetPrice : "—"}`;
  meta.appendChild(targetMetaSpan);

  const lastCheckedSpan = document.createElement("span");
  lastCheckedSpan.textContent = `${T.lastCheckedPrefix} ${formatRelativeTime(game.lastCheckedAt, false)}`;
  meta.appendChild(lastCheckedSpan);

  li.appendChild(meta);

  if (game.lastError) {
    const errorSpan = document.createElement("span");
    errorSpan.className = "error-text";
    errorSpan.textContent = game.lastError;
    li.appendChild(errorSpan);
  }

  if (isEditing && game.alertType !== "sale") {
    const editRow = document.createElement("div");
    editRow.className = "edit-target-row";

    const input = document.createElement("input");
    input.type = "number";
    input.step = "0.25";
    input.min = "0";
    input.max = String(MAX_TARGET_PRICE);
    input.lang = "en";
    input.className = "edit-target-input";
    input.value = game.targetPrice != null ? game.targetPrice : "";
    editRow.appendChild(input);

    const saveBtn = document.createElement("button");
    saveBtn.className = "save-target-btn";
    saveBtn.textContent = T.saveBtn;
    saveBtn.addEventListener("click", async () => {
      const newTarget = parseFloat(input.value);
      if (isNaN(newTarget) || newTarget < 0 || newTarget > MAX_TARGET_PRICE) {
        editTargetError.textContent = newTarget > MAX_TARGET_PRICE ? T.maxPriceAlert : T.invalidPriceAlert;
        editTargetError.classList.remove("hidden");
        return;
      }
      editTargetError.classList.add("hidden");
      const games = await sendMessage("UPDATE_GAME", { id: game.id, patch: { targetPrice: newTarget } });
      editingGameId = null;
      renderGames(games);
    });
    editRow.appendChild(saveBtn);

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "cancel-edit-btn secondary";
    cancelBtn.textContent = T.cancelBtn;
    cancelBtn.addEventListener("click", () => {
      editingGameId = null;
      renderGames(currentGames);
    });
    editRow.appendChild(cancelBtn);

    li.appendChild(editRow);

    const editTargetError = document.createElement("p");
    editTargetError.className = "field-error hidden";
    editTargetError.textContent = T.invalidPriceAlert;
    li.appendChild(editTargetError);
  }

  return li;
}

function renderGames(games) {
  currentGames = games;
  const T = tr();
  gamesListEl.replaceChildren();
  if (!games.length) {
    emptyStateEl.classList.remove("hidden");
    return;
  }
  emptyStateEl.classList.add("hidden");

  const sortedGames = sortGames(games, currentSortBy);
  for (const game of sortedGames) {
    gamesListEl.appendChild(buildGameCard(game, T));
  }
}

function refreshStatus(lastChecked) {
  currentLastChecked = lastChecked;
  statusText.textContent = `${tr().lastCheckedPrefix} ${formatRelativeTime(lastChecked)}`;
}

// ---------- Initial setup ----------

// The popup only shows the last saved state — the automatic check when the
// interval has elapsed happens in background.js on browser startup, not here.
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

// ---------- Standalone (full page) mode ----------

// When popup.html is opened as its own browser tab (via the button below), it carries
// ?standalone=1 in the URL. We use that to switch to a wider, roomier layout (see popup.css)
// and hide the "open in tab" button, since it's already open in a tab.
const isStandalone = new URLSearchParams(window.location.search).get("standalone") === "1";
if (isStandalone) {
  document.body.classList.add("standalone");
}

openTabBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("popup.html") + "?standalone=1" });
});

// ---------- Events ----------

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

function showSearchStatus(text, isError) {
  const p = document.createElement("p");
  p.className = isError ? "search-status search-status-error" : "search-status";
  p.textContent = text;
  searchResultsEl.replaceChildren(p);
}

function buildSearchResultItem(r) {
  const div = document.createElement("div");
  div.className = "search-result-item";

  const img = document.createElement("img");
  img.src = r.image || "";
  img.alt = "";
  div.appendChild(img);

  const span = document.createElement("span");
  span.textContent = r.name;
  div.appendChild(span);

  div.addEventListener("click", () => selectGame(r));
  return div;
}

async function doSearch() {
  const term = searchInput.value.trim();
  if (!term) return;

  // If an add-game form is open from a previous search, close it before showing new results
  resetAddForm();

  const T = tr();
  showSearchStatus(T.searching, false);
  searchResultsEl.classList.remove("hidden");
  try {
    const results = await sendMessage("SEARCH_GAME", { term });
    if (!results.length) {
      showSearchStatus(T.noResults, false);
      return;
    }
    searchResultsEl.replaceChildren();
    for (const r of results.slice(0, 8)) {
      searchResultsEl.appendChild(buildSearchResultItem(r));
    }
  } catch (e) {
    showSearchStatus(e.message, true);
  }
}

function setAlertTypeUI(type) {
  const isSale = type === "sale";
  targetPriceInput.classList.toggle("hidden", isSale);
  targetPriceInput.required = !isSale;
}

// Closes the current add-game form and resets all its fields to their defaults
function resetAddForm() {
  selectedGame = null;
  addForm.classList.add("hidden");
  targetPriceInput.value = "";
  duplicateWarningText.classList.add("hidden");
  targetPriceError.classList.add("hidden");
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

  // Reset the alert type back to its default (price target) each time a new game is selected
  alertTypeRadios.forEach(r => (r.checked = r.value === "target"));
  setAlertTypeUI("target");

  const alreadyAdded = currentGames.some(g => g.appid === game.appid);
  duplicateWarningText.classList.toggle("hidden", !alreadyAdded);

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
      if (selectedGame === game) selectedGame.currency = priceInfo.currency || "";
    }
  } catch (e) {
    currentPriceValue.textContent = `${tr().errorPriceFetch} (${e.message})`;
    console.error("PREVIEW_PRICE failed:", e);
  }
}

cancelAddBtn.addEventListener("click", () => {
  resetAddForm();
});

confirmAddBtn.addEventListener("click", async () => {
  if (!selectedGame) return;

  const alertType = document.querySelector('input[name="alertType"]:checked').value;

  let targetPrice = null;
  if (alertType === "target") {
    targetPrice = parseFloat(targetPriceInput.value);
    if (isNaN(targetPrice) || targetPrice < 0 || targetPrice > MAX_TARGET_PRICE) {
      targetPriceError.textContent = targetPrice > MAX_TARGET_PRICE ? tr().maxPriceAlert : tr().invalidPriceAlert;
      targetPriceError.classList.remove("hidden");
      return;
    }
    targetPriceError.classList.add("hidden");
  }

  const games = await sendMessage("ADD_GAME", {
    game: { appid: selectedGame.appid, name: selectedGame.name, image: selectedGame.image, alertType, targetPrice, currencyLabel: selectedGame.currency || "" }
  });
  renderGames(games);
  resetAddForm();
  searchInput.value = "";
});

 
// ---------- Messages pushed from background.js ----------
 
chrome.runtime.onMessage.addListener(msg => {
  if (msg.type === "GAME_CHECK_DONE") {
    const games = currentGames.map(g => (g.id === msg.gameId ? msg.game : g));
    renderGames(games);
  }
});

init();
