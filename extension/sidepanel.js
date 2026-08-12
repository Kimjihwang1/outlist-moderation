/**
 * sidepanel.js
 * ------------
 * 사이드 패널 로직.
 *
 * 역할
 *  1) 현재 활성 탭의 통계(`stats:<tabId>`)를 chrome.storage.local 에서 읽어 렌더링.
 *  2) storage.onChanged 를 구독해 실시간 갱신(폴링 없음).
 *  3) 백엔드 /health 상태 표시.
 *  4) 블러 on/off, 임계값 설정을 저장 -> content.js 가 즉시 반영.
 */

const CATEGORIES = ["욕설", "혐오표현", "성희롱", "스팸"];

const el = {
  total: document.getElementById("total"),
  harmful: document.getElementById("harmful"),
  ratio: document.getElementById("ratio"),
  cats: document.getElementById("cats"),
  healthDot: document.getElementById("health-dot"),
  healthText: document.getElementById("health-text"),
  enabled: document.getElementById("enabled"),
  threshold: document.getElementById("threshold"),
  thresholdValue: document.getElementById("threshold-value"),
  footer: document.getElementById("footer"),
};

let currentTabId = null;

// --- 렌더링 -----------------------------------------------------------------

const EMPTY_STATS = { total: 0, harmful: 0, categories: {} };

function render(stats) {
  const s = { ...EMPTY_STATS, ...(stats || {}) };
  const cats = s.categories || {};

  el.total.textContent = s.total;
  el.harmful.textContent = s.harmful;
  el.ratio.textContent = s.total ? `${Math.round((s.harmful / s.total) * 100)}%` : "0%";

  // 막대 길이 기준은 카테고리 최댓값(최소 1)으로 잡아 상대 비교가 되게 한다.
  const max = Math.max(1, ...CATEGORIES.map((c) => cats[c] || 0));

  el.cats.innerHTML = "";
  for (const name of CATEGORIES) {
    const count = cats[name] || 0;
    const li = document.createElement("li");
    li.className = "cat";
    li.innerHTML = `
      <span>${name}</span>
      <span class="cat__bar"><span class="cat__fill" style="width:${(count / max) * 100}%"></span></span>
      <span class="cat__count">${count}</span>`;
    el.cats.appendChild(li);
  }
}

// --- 통계 로드 ---------------------------------------------------------------

async function loadStatsForActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab?.id ?? null;

  if (currentTabId == null) return render(null);

  const key = `stats:${currentTabId}`;
  const stored = await chrome.storage.local.get(key);
  render(stored[key]);

  el.footer.textContent = tab.url?.includes("youtube.com")
    ? "유튜브 댓글을 스크롤하면 계속 집계됩니다."
    : "유튜브 페이지에서만 동작합니다.";
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || currentTabId == null) return;
  const change = changes[`stats:${currentTabId}`];
  if (change) render(change.newValue);
});

// 탭 전환 / 페이지 이동 시 다시 로드.
chrome.tabs.onActivated.addListener(loadStatsForActiveTab);
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (tabId === currentTabId && info.status === "complete") loadStatsForActiveTab();
});

// --- 백엔드 상태 -------------------------------------------------------------

function refreshHealth() {
  chrome.runtime.sendMessage({ type: "HEALTH" }, (res) => {
    const ok = !!res?.ok;
    el.healthDot.className = `dot ${ok ? "ok" : "bad"}`;
    el.healthText.textContent = ok ? `백엔드 연결됨 (${res.detail})` : "백엔드 꺼짐";
  });
}

// --- 설정 -------------------------------------------------------------------

async function loadSettings() {
  const settings = await new Promise((resolve) =>
    chrome.runtime.sendMessage({ type: "GET_SETTINGS" }, resolve)
  );
  el.enabled.checked = settings?.enabled ?? true;
  el.threshold.value = settings?.threshold ?? 50;
  el.thresholdValue.textContent = el.threshold.value;
}

async function saveSettings() {
  const { settings = {} } = await chrome.storage.local.get("settings");
  await chrome.storage.local.set({
    settings: { ...settings, enabled: el.enabled.checked, threshold: Number(el.threshold.value) },
  });
}

el.enabled.addEventListener("change", saveSettings);
el.threshold.addEventListener("input", () => {
  el.thresholdValue.textContent = el.threshold.value;
});
el.threshold.addEventListener("change", saveSettings);

// --- 부팅 -------------------------------------------------------------------

loadStatsForActiveTab();
loadSettings();
refreshHealth();
setInterval(refreshHealth, 15000); // 헬스체크만 주기 갱신(통계는 이벤트 기반)
