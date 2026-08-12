/**
 * content.js
 * ----------
 * 유튜브 페이지에서 실행되는 스크립트.
 *
 * 역할
 *  1) 댓글 DOM 수집: MutationObserver 로 새로 렌더링되는 댓글을 감지한다.
 *  2) 배치 전송: 디바운스로 모아서 background 에 판정 요청을 보낸다.
 *  3) 블러 처리: severity >= 임계값 이면 본문을 블러하고 [원문 보기] 버튼을 붙인다.
 *  4) 통계 집계: 총/유해 댓글 수, 카테고리별 개수를 background 로 보고한다(사이드 패널이 표시).
 *
 * ★ 반드시 알아야 할 유튜브의 동작: DOM 요소 재활용(recycling)
 *   유튜브는 스크롤할 때 ytd-comment-thread-renderer 노드를 새로 만들지 않고
 *   기존 노드의 내용만 다른 댓글로 갈아끼운다.
 *   따라서 "요소에 ID를 붙였으니 처리 완료"라고 판단하면 안 된다. 그렇게 하면
 *     - 갈아끼워진 새 댓글은 영원히 판정을 못 받고
 *     - 이전 댓글의 블러/배지가 남아 엉뚱한 댓글을 덮어버린다.
 *   그래서 이 파일은 요소가 아니라 **본문 텍스트**를 신원의 기준으로 삼고,
 *   화면에 붙이기 직전에 텍스트가 그대로인지 한 번 더 검사한다.
 */

(() => {
  "use strict";

  // --- 설정값 ---------------------------------------------------------------
  const BATCH_SIZE = 20; // 한 번에 보낼 최대 댓글 수
  const DEBOUNCE_MS = 400; // 새 댓글이 멈춘 뒤 이만큼 기다렸다 전송
  const COMMENT_SELECTOR = "ytd-comment-thread-renderer, ytd-comment-view-model";
  const TEXT_SELECTOR = "#content-text";

  // 디버그 로그. 문제 진단이 끝나면 false 로 두면 된다.
  // 켜져 있으면 판정된 댓글마다 [보낸 텍스트 / 받은 판정 / 실제로 붙인 댓글 텍스트]를 찍는다.
  const DEBUG = true;

  // 유튜브가 본문 안에 끼워 넣는 더보기/접기 버튼 텍스트. 판정 대상에서 제외한다.
  const NOISE_LINES = new Set(["간략히", "자세히 보기", "Show less", "Read more"]);

  // --- 상태 -----------------------------------------------------------------
  const state = {
    seq: 0,
    records: new Map(), // id -> { el, text }   현재 화면에 붙어 있는 댓글
    cache: new Map(), // text -> verdict       같은 텍스트는 재요청하지 않는다
    seenTexts: new Set(), // 통계 중복 집계 방지 (재활용으로 같은 댓글이 다시 잡힐 수 있음)
    pending: [],
    inflight: false,
    threshold: 50,
    enabled: true,
    stats: { total: 0, harmful: 0, categories: { 욕설: 0, 혐오표현: 0, 성희롱: 0, 스팸: 0 } },
    warnedOnce: false,
  };

  let debounceTimer = null;

  const log = (...args) => {
    if (DEBUG) console.log("%c[모더레이션]", "color:#d93025;font-weight:bold", ...args);
  };

  // --- 설정 로드 / 변경 구독 -------------------------------------------------
  chrome.runtime.sendMessage({ type: "GET_SETTINGS" }, (settings) => {
    if (settings) {
      state.threshold = settings.threshold ?? state.threshold;
      state.enabled = settings.enabled ?? state.enabled;
      reapplyAll();
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.settings) return;
    const next = changes.settings.newValue || {};
    state.threshold = next.threshold ?? state.threshold;
    state.enabled = next.enabled ?? state.enabled;
    // 임계값이 바뀌면 이미 판정된 댓글에도 즉시 반영한다(재요청 없이).
    reapplyAll();
  });

  // --- 유틸 -------------------------------------------------------------------

  /** 댓글 본문 텍스트를 읽는다. 더보기/접기 버튼 텍스트는 걸러낸다. */
  function readText(el) {
    const raw = el?.innerText;
    if (!raw) return "";
    return raw
      .split("\n")
      .filter((line) => !NOISE_LINES.has(line.trim()))
      .join("\n")
      .trim();
  }

  /** 요소에 붙어 있는 블러/배지를 모두 제거한다. */
  function cleanup(el) {
    el.querySelector(TEXT_SELECTOR)?.classList.remove("oml-blurred");
    el.querySelector(".oml-notice")?.remove();
  }

  // --- 1) 수집 ---------------------------------------------------------------

  /**
   * 화면의 댓글을 훑어서 새로 판정이 필요한 것을 pending 에 넣는다.
   *
   * 요소에 ID 가 이미 붙어 있어도 그냥 넘기지 않는다.
   * 저장해둔 텍스트와 현재 텍스트를 비교해서, 다르면 '재활용된 것'으로 보고
   * 흔적을 지운 뒤 새 댓글로 다시 등록한다.
   */
  function collect() {
    const nodes = document.querySelectorAll(COMMENT_SELECTOR);

    for (const el of nodes) {
      const textEl = el.querySelector(TEXT_SELECTOR);
      const text = readText(textEl);
      if (!text) continue; // 아직 본문이 안 그려진 상태

      const prevId = el.dataset.omlId;
      if (prevId) {
        const rec = state.records.get(prevId);
        if (rec && rec.text === text) continue; // 내용 그대로 -> 할 일 없음

        // 같은 노드에 다른 댓글이 들어왔다. 이전 판정 흔적을 반드시 지운다.
        log("요소 재활용 감지 — 이전 판정 제거", {
          이전: rec ? rec.text.slice(0, 30) : "(기록 없음)",
          현재: text.slice(0, 30),
        });
        cleanup(el);
        state.records.delete(prevId);
      }

      const id = `c${++state.seq}`;
      el.dataset.omlId = id;
      state.records.set(id, { el, text });

      // 통계의 '수집된 댓글'은 서로 다른 본문 기준으로 센다.
      if (!state.seenTexts.has(text)) {
        state.seenTexts.add(text);
        state.stats.total += 1;
      }

      // 이미 판정한 적 있는 텍스트면 서버에 다시 묻지 않는다.
      if (state.cache.has(text)) {
        render(id);
        continue;
      }

      state.pending.push({ id, text });
    }

    if (state.pending.length > 0) scheduleFlush();
    reportStats();
  }

  function scheduleFlush() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(flush, DEBOUNCE_MS);
  }

  // --- 2) 전송 ---------------------------------------------------------------

  /** pending 을 BATCH_SIZE 단위로 잘라 background 에 보낸다. */
  function flush() {
    if (state.inflight || state.pending.length === 0) return;

    const batch = state.pending.splice(0, BATCH_SIZE);
    // 응답이 왔을 때 "우리가 뭘 보냈는지"를 대조하기 위해 id -> 보낸 텍스트를 남긴다.
    const sentById = new Map(batch.map((c) => [c.id, c.text]));
    state.inflight = true;

    chrome.runtime.sendMessage({ type: "MODERATE", comments: batch }, (res) => {
      state.inflight = false;

      if (!res || res.error) {
        if (!state.warnedOnce) {
          console.warn(
            "[모더레이션] 백엔드 요청 실패:",
            res?.error || "no response",
            "— uvicorn 이 켜져 있는지 확인하세요."
          );
          state.warnedOnce = true;
        }
        // 실패한 배치는 버린다(무한 재시도로 페이지를 괴롭히지 않기 위해).
        // TODO: 지수 백오프 재시도 큐 도입 검토.
      } else {
        for (const r of res.results) applyVerdict(r, sentById.get(r.id));
        reportStats();
      }

      if (state.pending.length > 0) scheduleFlush();
    });
  }

  // --- 3) 판정 적용 (블러) ----------------------------------------------------

  /**
   * 서버 판정 1건을 반영한다.
   *
   * @param result   {id, category, severity, reason}
   * @param sentText 그 id 로 우리가 실제로 보냈던 텍스트
   */
  function applyVerdict(result, sentText) {
    const { id } = result;
    const rec = state.records.get(id);

    // 요청을 보낸 뒤 응답이 오기까지 사이에 요소가 사라졌거나 재활용됐을 수 있다.
    if (!rec) {
      log("판정 폐기 — 요소가 이미 사라짐", { id, 보낸텍스트: sentText });
      return;
    }
    if (sentText !== undefined && rec.text !== sentText) {
      log("판정 폐기 — 응답 대기 중 내용이 바뀜", {
        id,
        보낸텍스트: sentText,
        현재텍스트: rec.text,
      });
      return;
    }

    const key = rec.text;
    const isNew = !state.cache.has(key);
    state.cache.set(key, result);

    // 통계는 서로 다른 본문에 대해 한 번만 센다.
    if (isNew && result.category) {
      state.stats.harmful += 1;
      if (state.stats.categories[result.category] != null) {
        state.stats.categories[result.category] += 1;
      }
    }

    render(id, sentText);
  }

  function shouldBlur(v) {
    return state.enabled && !!v.category && v.severity >= state.threshold;
  }

  /**
   * 하나의 댓글에 현재 판정/설정을 반영한다.
   * 붙이기 직전에 화면의 실제 텍스트를 다시 읽어, 기록과 다르면 아무것도 하지 않는다.
   */
  function render(id, sentText) {
    const rec = state.records.get(id);
    if (!rec) return;

    const textEl = rec.el.querySelector(TEXT_SELECTOR);
    if (!textEl) return;

    // ★ 최종 안전장치: 화면에 지금 떠 있는 글이 우리가 판정한 그 글이 맞는가?
    const liveText = readText(textEl);
    if (liveText !== rec.text) {
      log("렌더 취소 — 화면 내용이 기록과 다름", {
        기록: rec.text.slice(0, 30),
        화면: liveText.slice(0, 30),
      });
      cleanup(rec.el);
      state.records.delete(id);
      return;
    }

    const v = state.cache.get(rec.text);
    if (!v) return;

    if (DEBUG && sentText !== undefined) {
      console.groupCollapsed(
        `%c[모더레이션] ${v.category || "정상"} ${v.severity} — ${rec.text.slice(0, 25)}`,
        `color:${v.category ? "#d93025" : "#1e8e3e"}`
      );
      console.log("보낸 텍스트  :", sentText);
      console.log("받은 판정    :", v.category || "정상", `severity=${v.severity}`);
      console.log("판정 근거    :", v.reason);
      console.log("붙인 댓글    :", liveText);
      console.log("일치 여부    :", sentText === liveText ? "✅ 일치" : "❌ 불일치");
      console.groupEnd();
    }

    if (!shouldBlur(v)) {
      textEl.classList.remove("oml-blurred");
      rec.el.querySelector(".oml-notice")?.remove();
      return;
    }

    textEl.classList.add("oml-blurred");

    // 이미 배지가 있으면 내용만 갱신.
    let notice = rec.el.querySelector(".oml-notice");
    if (!notice) {
      notice = document.createElement("div");
      notice.className = "oml-notice";

      const label = document.createElement("span");
      label.className = "oml-notice__label";

      const btn = document.createElement("button");
      btn.className = "oml-notice__btn";
      btn.textContent = "원문 보기";
      btn.addEventListener("click", () => {
        const hidden = textEl.classList.toggle("oml-blurred");
        btn.textContent = hidden ? "원문 보기" : "다시 가리기";
      });

      notice.append(label, btn);
      textEl.parentNode.insertBefore(notice, textEl);
    }

    notice.querySelector(".oml-notice__label").textContent =
      `⚠ ${v.category} (유해도 ${v.severity}) · ${v.reason || ""}`;
  }

  /** 임계값/on-off 변경 시 화면에 있는 모든 댓글을 다시 그린다. */
  function reapplyAll() {
    for (const id of state.records.keys()) render(id);
  }

  // --- 4) 통계 보고 -----------------------------------------------------------

  function reportStats() {
    chrome.runtime.sendMessage({
      type: "STATS",
      stats: {
        total: state.stats.total,
        harmful: state.stats.harmful,
        categories: { ...state.stats.categories },
        pageUrl: location.href,
      },
    });
  }

  // --- 부팅 / SPA 대응 ---------------------------------------------------------

  const observer = new MutationObserver(() => {
    clearTimeout(observer._t);
    observer._t = setTimeout(collect, 200);
  });

  function start() {
    observer.observe(document.body, { childList: true, subtree: true });
    collect();
  }

  function resetForNavigation() {
    // 남아 있는 블러/배지와 ID 를 전부 정리한다.
    for (const el of document.querySelectorAll("[data-oml-id]")) {
      cleanup(el);
      delete el.dataset.omlId;
    }
    state.seq = 0;
    state.records.clear();
    state.cache.clear();
    state.seenTexts.clear();
    state.pending = [];
    state.stats = { total: 0, harmful: 0, categories: { 욕설: 0, 혐오표현: 0, 성희롱: 0, 스팸: 0 } };
    reportStats();
  }

  // 유튜브 SPA 내비게이션 완료 시 상태 초기화.
  window.addEventListener("yt-navigate-finish", () => {
    resetForNavigation();
    setTimeout(collect, 500);
  });

  start();
})();
