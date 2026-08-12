/**
 * background.js  (MV3 service worker)
 * -----------------------------------
 * 역할
 *  1) content script 로부터 댓글 배치를 받아 백엔드(POST /moderate)로 중계한다.
 *     - content script 가 직접 localhost 로 fetch 하지 않는 이유:
 *       CORS/권한을 service worker 한 곳에 몰아두면 관리가 단순해진다.
 *  2) 탭별 통계를 chrome.storage.local 에 기록해 사이드 패널과 공유한다.
 *  3) 툴바 아이콘 클릭 시 사이드 패널이 열리도록 설정한다.
 *
 * 데이터 계약 (backend/schemas.py 와 반드시 일치시킬 것)
 *   요청: { comments: [{ id, text }] }
 *   응답: { results:  [{ id, category, severity, reason }] }
 *          category 가 null 이면 정상 댓글, severity 는 0~100.
 */

const DEFAULT_API_BASE = "http://localhost:8000";

/** 탭별 통계 저장 키. 사이드 패널이 같은 키를 구독한다. */
const statsKey = (tabId) => `stats:${tabId}`;

/** 설정(API 주소, 임계값, on/off)의 기본값. */
const DEFAULT_SETTINGS = {
  apiBase: DEFAULT_API_BASE,
  threshold: 50, // severity 가 이 값 이상이면 블러
  enabled: true,
};

async function getSettings() {
  const stored = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
}

// 툴바 아이콘을 누르면 사이드 패널이 열리도록.
chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.local.set({ settings: await getSettings() });
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((e) => console.warn("[moderation] sidePanel 설정 실패", e));
});

/**
 * 백엔드에 배치 판정 요청.
 * 실패해도 예외를 밖으로 던지지 않고 { error } 를 돌려준다(fail-open).
 * 백엔드가 죽어 있다고 해서 페이지가 망가지면 안 되기 때문.
 */
async function requestModeration(comments) {
  const { apiBase } = await getSettings();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(`${apiBase}/moderate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ comments }),
      signal: controller.signal,
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };

    const data = await res.json();
    return { results: Array.isArray(data.results) ? data.results : [] };
  } catch (e) {
    return { error: String(e && e.message ? e.message : e) };
  } finally {
    clearTimeout(timer);
  }
}

/** 백엔드 헬스체크. 사이드 패널의 연결 상태 표시에 사용. */
async function checkHealth() {
  const { apiBase } = await getSettings();
  try {
    const res = await fetch(`${apiBase}/health`);
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    return { ok: true, detail: (await res.json()).mode || "" };
  } catch (e) {
    return { ok: false, detail: "연결 실패" };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "MODERATE") {
    requestModeration(msg.comments).then(sendResponse);
    return true; // 비동기 응답 사용
  }

  if (msg?.type === "STATS") {
    // content script 가 집계한 통계를 그대로 탭 키에 저장 -> 패널이 구독.
    const tabId = sender.tab?.id;
    if (tabId != null) {
      chrome.storage.local.set({ [statsKey(tabId)]: { ...msg.stats, updatedAt: Date.now() } });
    }
    return false;
  }

  if (msg?.type === "HEALTH") {
    checkHealth().then(sendResponse);
    return true;
  }

  if (msg?.type === "GET_SETTINGS") {
    getSettings().then(sendResponse);
    return true;
  }

  return false;
});

// 탭이 닫히면 통계도 정리.
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.remove(statsKey(tabId));
});
