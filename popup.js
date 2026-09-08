// popup.js — واجهة الإضافة

const statusText = document.getElementById("statusText");
const refreshBtn = document.getElementById("refreshBtn");
const searchInput = document.getElementById("searchInput");
const searchBtn = document.getElementById("searchBtn");
const searchResultsEl = document.getElementById("searchResults");
const addForm = document.getElementById("addForm");
const selectedImg = document.getElementById("selectedImg");
const selectedName = document.getElementById("selectedName");
const targetPriceInput = document.getElementById("targetPriceInput");
const confirmAddBtn = document.getElementById("confirmAddBtn");
const cancelAddBtn = document.getElementById("cancelAddBtn");
const intervalSelect = document.getElementById("intervalSelect");
const gamesListEl = document.getElementById("gamesList");
const emptyStateEl = document.getElementById("emptyState");

let selectedGame = null;

function sendMessage(type, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...payload }, response => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response || !response.ok) {
        reject(new Error((response && response.error) || "خطأ غير معروف"));
        return;
      }
      resolve(response.data);
    });
  });
}

function formatRelativeTime(ts) {
  if (!ts) return "لم يتم الفحص بعد";
  const diffMs = Date.now() - ts;
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "الآن";
  if (mins < 60) return `قبل ${mins} دقيقة`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `قبل ${hours} ساعة`;
  const days = Math.round(hours / 24);
  return `قبل ${days} يوم`;
}

function renderGames(games) {
  gamesListEl.innerHTML = "";
  if (!games.length) {
    emptyStateEl.classList.remove("hidden");
    return;
  }
  emptyStateEl.classList.add("hidden");

  for (const game of games) {
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
      : "جارٍ الفحص...";

    li.innerHTML = `
      <div class="row1">
        <span class="game-name">${escapeHtml(game.name)}</span>
        <button class="remove-btn" title="حذف">✕</button>
      </div>
      <div class="row1">
        <span class="game-price ${reached ? "" : "above-target"}">${escapeHtml(priceLabel)}</span>
        <span>
          ${game.lastDiscount ? `<span class="discount-badge">-${game.lastDiscount}%</span>` : ""}
          ${reached ? `<span class="reached-badge">وصل الهدف!</span>` : ""}
        </span>
      </div>
      <div class="game-meta">
        <span>الهدف: ${game.targetPrice != null ? game.targetPrice : "—"}</span>
        <span>آخر فحص: ${formatRelativeTime(game.lastCheckedAt)}</span>
      </div>
      ${game.lastError ? `<span class="error-text">${escapeHtml(game.lastError)}</span>` : ""}
    `;

    li.querySelector(".remove-btn").addEventListener("click", async () => {
      const games = await sendMessage("REMOVE_GAME", { id: game.id });
      renderGames(games);
    });

    gamesListEl.appendChild(li);
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

async function refreshStatus(lastChecked) {
  statusText.textContent = `آخر فحص: ${formatRelativeTime(lastChecked)}`;
}

// نافذة الإضافة تعرض فقط آخر حالة محفوظة — الفحص التلقائي عند تجاوز المدة
// يتم عند إقلاع المتصفح نفسه (في background.js)، وليس عند فتح هذه النافذة.
async function init() {
  const state = await sendMessage("GET_STATE");
  intervalSelect.value = String(state.settings.intervalHours);
  renderGames(state.games);
  refreshStatus(state.lastChecked);
}

refreshBtn.addEventListener("click", async () => {
  statusText.textContent = "جارٍ الفحص...";
  const result = await sendMessage("FORCE_CHECK");
  renderGames(result.games);
  refreshStatus(Date.now());
});

intervalSelect.addEventListener("change", async () => {
  await sendMessage("UPDATE_SETTINGS", { patch: { intervalHours: Number(intervalSelect.value) } });
});

searchBtn.addEventListener("click", doSearch);
searchInput.addEventListener("keydown", e => {
  if (e.key === "Enter") doSearch();
});

async function doSearch() {
  const term = searchInput.value.trim();
  if (!term) return;
  searchResultsEl.innerHTML = "<p style='padding:6px;color:#8f98a0;'>جارٍ البحث...</p>";
  searchResultsEl.classList.remove("hidden");
  try {
    const results = await sendMessage("SEARCH_GAME", { term });
    if (!results.length) {
      searchResultsEl.innerHTML = "<p style='padding:6px;color:#8f98a0;'>لا توجد نتائج</p>";
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

function selectGame(game) {
  selectedGame = game;
  selectedImg.src = game.image || "";
  selectedName.textContent = game.name;
  addForm.classList.remove("hidden");
  searchResultsEl.classList.add("hidden");
  targetPriceInput.focus();
}

cancelAddBtn.addEventListener("click", () => {
  selectedGame = null;
  addForm.classList.add("hidden");
  targetPriceInput.value = "";
});

confirmAddBtn.addEventListener("click", async () => {
  if (!selectedGame) return;
  const targetPrice = parseFloat(targetPriceInput.value);
  if (isNaN(targetPrice) || targetPrice < 0) {
    alert("رجاءً أدخل سعراً صحيحاً");
    return;
  }
  const games = await sendMessage("ADD_GAME", {
    game: { appid: selectedGame.appid, name: selectedGame.name, image: selectedGame.image, targetPrice }
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
  }, 1500);
});

init();
