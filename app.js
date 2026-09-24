"use strict";
/* 잠실점 후기 작업실 — 화면 로직 (프레임워크 없음) */

const SRC = { place_receipt: "영수증 리뷰", place_blog: "플레이스 연결 블로그", search_blog: "별도 검색 블로그", manual: "직접 입력" };
const REL = { related: "관련", check: "확인 필요", excluded: "제외" };
const REL_CLS = { related: "ok", check: "warn", excluded: "gray" };
const AD = { disclosed: ["광고·협찬 표기 있음", "bad"], event: ["매장 리뷰 이벤트 언급", "warn"], self_claim: ["'내돈내산' 표기 (작성자 주장)", "gray"],
             none_found: ["광고 표기 확인 안 됨 (자발적 후기로 단정 안 함)", "gray"], unknown: ["광고 표기 판단 불가", "gray"] };
const RUN = { success: ["수집 성공", "ok"], partial: ["일부만 성공", "warn"], failed: ["수집 실패", "bad"], running: ["실행 중", "gray"] };
const WD = ["일", "월", "화", "수", "목", "금", "토"];
const STATUSES = ["검토 전", "수정 중", "사용 완료"];

let S = null;              // /api/state
let ITEMS = null;          // /api/items 캐시
let tab = "summary";
let pollTimer = null;
const pending = new Map(); // 초안 자동 저장 대기

const app = document.getElementById("app");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const md = (d) => (d ? `${+d.slice(5, 7)}/${+d.slice(8, 10)}` : "날짜 없음");
const dt = (iso) => { if (!iso) return "—"; const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]}) ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
const chip = (t, cls = "") => `<span class="chip ${cls}">${esc(t)}</span>`;

const SHARE = !!window.SHARE;
let SHARED = null;
async function api(path, body) {
  if (SHARE) {
    if (body !== undefined) throw new Error("공유본에서는 바꿀 수 없어요. 맥의 작업실에서 수정해 주세요.");
    if (!SHARED) { const r = await fetch(`data.json?t=${Date.now()}`); if (!r.ok) throw new Error("공유 자료를 불러오지 못했어요"); SHARED = await r.json(); }
    if (path === "/api/state") return SHARED.state;
    if (path === "/api/items") return SHARED.items;
    if (path === "/api/drafts/history") return SHARED.history;
    throw new Error("공유본에 없는 자료예요");
  }
  const r = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `요청 실패 (${r.status})`);
  return j;
}
function toast(msg) {
  const t = document.createElement("div"); t.className = "toast"; t.textContent = msg; document.body.append(t);
  setTimeout(() => t.remove(), 2200);
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast("복사했어요"); }
  catch {
    const ta = document.createElement("textarea"); ta.value = text; document.body.append(ta); ta.select();
    try { document.execCommand("copy"); toast("복사했어요"); } catch { toast("복사가 막혀 있어요. 직접 선택해 복사해 주세요"); }
    ta.remove();
  }
}

/* ---------------- 공통 조각 ---------------- */
function refLabel(r) {
  const k = r.kind === "receipt" ? "영수증" : "블로그";
  return `${k} ${md(r.date)}`;
}
function refLinks(refs, max = 10) {
  if (!refs || !refs.length) return `<span class="muted small">근거 링크 없음</span>`;
  const shown = refs.slice(0, max).map((r) => `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(refLabel(r))}</a>`).join("");
  return `<span class="refs">${shown}${refs.length > max ? `<span class="muted">외 ${refs.length - max}건</span>` : ""}</span>`;
}
function quoteList(refs, max = 6) {
  const withQ = refs.filter((r) => r.quote);
  if (!withQ.length) return refLinks(refs);
  return `<div class="stack">${withQ.slice(0, max).map((r) =>
    `<div class="quote">${esc(r.quote)} <a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(refLabel(r))}</a></div>`).join("")}
    ${refs.length > max ? `<div class="small muted">전체 ${refs.length}건: ${refLinks(refs, 30)}</div>` : ""}</div>`;
}
function bars(list, n, limit = 10) {
  if (!list.length) return `<p class="empty">해당 표현이 나온 글이 없어요.</p>`;
  return `<div class="bars">${list.slice(0, limit).map((x) => `
    <details><summary style="list-style:none"><div class="bar"><span>${esc(x.term)}</span>
      <span class="track"><span class="fill" style="width:${n ? Math.round((x.count / n) * 100) : 0}%"></span></span>
      <span class="n">${n}건 중 ${x.count}</span></div></summary>${quoteList(x.refs)}</details>`).join("")}</div>`;
}
function linkify(text) {
  const codes = S.analysis?.codes || {};
  return esc(text).replace(/\b([RB]\d{1,3})\b/g, (m) => codes[m]
    ? `<a class="code" href="${esc(codes[m].url)}" target="_blank" rel="noopener" title="${esc(refLabel(codes[m]))}">${m}</a>` : m);
}
function aiPoints(list, emptyText) {
  if (!list || !list.length) return `<p class="empty">${esc(emptyText)}</p>`;
  return `<ul class="points">${list.map((p) => `<li><span>${linkify(p.point || p.issue || p.claim)}</span>
    <span class="small muted">근거 ${p.refs.length}건 · ${refLinks(p.refs, 6)}</span></li>`).join("")}</ul>`;
}

/* ---------------- 이번 주 요약 (대시보드) ---------------- */
function lastScheduledTime(sc) {
  const now = new Date(); const d = new Date(now);
  d.setHours(+sc.hour, +sc.minute, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() - +sc.weekday + 7) % 7));
  if (d > now) d.setDate(d.getDate() - 7);
  return d;
}
function scheduleText() {
  const sc = S.settings.schedule; const reg = S.schedule.registered;
  const when = `매주 ${WD[sc.weekday]}요일 ${String(sc.hour).padStart(2, "0")}:${String(sc.minute).padStart(2, "0")}`;
  if (!sc.enabled) return { t: "예약 꺼짐", cls: "gray", sub: "버튼으로만 실행해요" };
  if (!reg) return { t: "예약 작동 안 함", cls: "bad", sub: `${when}로 저장만 됐고 이 맥에 등록되지 않았어요` };
  const last = lastScheduledTime(sc);
  if (sc.applied_at && last > new Date(sc.applied_at)) {
    const ran = S.runs.some((r) => r.trigger === "schedule" && new Date(r.started_at) >= new Date(last.getTime() - 60000));
    if (!ran) return { t: "지난 예약 실행 없음", cls: "warn", sub: `${dt(last.toISOString())} 예약 실행 기록이 없어요. 맥이 꺼져 있었을 수 있어요` };
  }
  return { t: `예약 ${WD[sc.weekday]} ${String(sc.hour).padStart(2, "0")}:${String(sc.minute).padStart(2, "0")}`, cls: "ok", sub: `${when} · 이 맥이 켜져 있을 때 실행` };
}
function sourceRows(run) {
  const src = run?.stats?.sources;
  if (!src || !Object.keys(src).length) return `<p class="empty">${run?.error ? esc(run.error.split("\n")[0]) : "출처별 기록이 없어요."}</p>`;
  return `<div class="sources">${Object.entries(src).map(([k, c]) => {
    let state;
    if (!c.ok) state = chip("수집 실패", "bad") + ` <span class="small">${esc(c.error || "")}</span>`;
    else if (c.new === 0) state = chip("새 자료 없음", "gray");
    else state = chip(`새 자료 ${c.new}건`, "ok");
    const range = c.oldest ? `실제 확인 범위 ${md(c.oldest)}~${md(c.newest)}` : "";
    return `<div class="src"><b>${esc(SRC[k] || k)}</b><div>${state}
      <div class="small muted num">${esc(c.since ? `${md(c.since)}부터 확인` : "")} · 목록 ${c.checked}건 확인 · 기간 안 ${c.in_window}건${range ? " · " + range : ""}${c.total_on_naver ? ` · 네이버 표시 전체 ${c.total_on_naver}건` : ""}</div>
      ${c.note ? `<div class="small" style="color:var(--warn)">${esc(c.note)}</div>` : ""}</div></div>`;
  }).join("")}</div>`;
}
function groupPanel(g, label, facts, ai) {
  const f = facts[g]; const a = ai ? ai[g] : null;
  return `<div class="panel">
    <div class="panel-head"><h2>${label}</h2><span class="muted num">분석 ${f.n}건</span></div>
    ${f.n === 0 ? `<p class="empty">이 기간에 분석할 ${label}가 없어요.</p>` : `
    ${a ? `<div class="stack"><div><span class="label-ai">AI 해석</span></div><p>${linkify(a.summary)}</p></div>` : ""}
    <div class="stack"><div class="row"><span class="label-fact">관찰</span><span class="small muted">본문에 해당 표현이 나온 글 수 · 누르면 근거 문장</span></div>
      ${bars(f.aspects, f.n)}
      <details><summary>메뉴 ${f.menus.length}종 · 음료 ${f.drinks.length}종 · 방문 목적 ${f.purposes.length}종</summary>
        <div class="stack"><div class="eyebrow">메뉴</div>${bars(f.menus, f.n)}<div class="eyebrow">음료</div>${bars(f.drinks, f.n)}<div class="eyebrow">명시한 방문 목적</div>${bars(f.purposes, f.n)}</div></details>
      <details><summary>불편·부정 표현이 있는 문장 ${f.negative_sentences.length}건 (단어 기준이라 오탐 포함)</summary>${quoteList(f.negative_sentences, 20)}</details>
      <details><summary>질문·궁금 표현이 있는 문장 ${f.question_sentences.length}건</summary>${quoteList(f.question_sentences, 20)}</details>
    </div>
    ${a ? `<hr class="sep"><div class="stack"><div><span class="label-ai">AI 해석</span> <span class="small muted">근거 수 = 이 내용을 담은 글 수</span></div>
      <div class="eyebrow">반복되는 칭찬 (${a.praise.length})</div>${aiPoints(a.praise, "없음")}
      <div class="eyebrow">불편 사항 (${a.complaints.length})</div>${aiPoints(a.complaints, "이 자료에서는 찾지 못했어요")}
      <div class="eyebrow">고객이 궁금해한 것 (${a.questions.length})</div>${aiPoints(a.questions, "없음")}
      <div class="eyebrow">명시된 방문 목적</div>${aiPoints(a.purposes, "없음")}
      <div class="eyebrow">콘텐츠로 설명하면 좋을 것</div>${aiPoints(a.content_hints, "없음")}</div>` : ""}`}
  </div>`;
}
function compareTable(cmp) {
  if (!cmp || !cmp.available) return `<p class="empty">${esc(cmp?.note || "지난 분석이 없어 비교하지 않았어요.")}</p>`;
  return `<p class="small muted">지난 분석 기간 ${esc((cmp.prev_period || []).join(" ~ "))}. 숫자를 나란히 놓기만 하고, 늘었다·줄었다고 판단하지 않아요.</p>
  <div class="grid2">${["receipt", "blog"].map((g) => {
    const c = cmp.groups[g];
    return `<div class="stack"><div class="eyebrow">${g === "receipt" ? "영수증 리뷰" : "블로그"} · 지난 ${c.prev_n}건 / 이번 ${c.now_n}건</div>
      ${c.note ? `<div class="note warn small">${esc(c.note)}</div>` : ""}
      <div class="tablewrap"><table class="cmp"><tr><th>항목</th><th>지난</th><th>이번</th></tr>
      ${c.rows.slice(0, 12).map((r) => `<tr><td>${esc(r.term)}</td><td>${r.prev}/${c.prev_n}</td><td>${r.now}/${c.now_n}</td></tr>`).join("")}</table></div></div>`;
  }).join("")}</div>`;
}

/* --- 차트 조각 --- */
const LEG = `<div class="legend"><span><i class="sw rc"></i>영수증 리뷰</span><span><i class="sw bl"></i>블로그</span></div>`;
function dailyChart(an) {
  const days = [];
  for (let d = new Date(an.period_from + "T00:00:00"); d <= new Date(an.period_to + "T00:00:00"); d.setDate(d.getDate() + 1)) {
    days.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
  }
  const by = {}; (an.daily || []).forEach((r) => { (by[r.d] = by[r.d] || { receipt: 0, blog: 0 })[r.kind] = r.n; });
  const vals = days.map((d) => ({ d, r: by[d]?.receipt || 0, b: by[d]?.blog || 0 }));
  const max = Math.max(1, ...vals.map((v) => v.r + v.b));
  const step = max <= 5 ? 1 : max <= 10 ? 2 : max <= 25 ? 5 : 10;
  const top = Math.ceil(max / step) * step;
  const W = 640, H = 200, L = 28, B = 22, T = 8, cw = (W - L - 4) / vals.length, bw = Math.min(28, Math.max(3, cw - 3)), off = (cw - bw) / 2;
  const y = (v) => T + (H - T - B) * (1 - v / top);
  let g = "";
  for (let t = 0; t <= top; t += step) g += `<line x1="${L}" x2="${W}" y1="${y(t)}" y2="${y(t)}" class="grid"/><text x="${L - 6}" y="${y(t) + 4}" class="ax" text-anchor="end">${t}</text>`;
  vals.forEach((v, i) => {
    const x = L + 2 + i * cw + (cw > 34 ? off : 0);
    const hr = (H - T - B) * (v.r / top), hb = (H - T - B) * (v.b / top);
    const base = H - B;
    if (v.r) g += `<rect x="${x}" y="${base - hr}" width="${bw}" height="${hr}" rx="2" class="m-rc"/>`;
    if (v.b) g += `<rect x="${x}" y="${base - hr - hb}" width="${bw}" height="${Math.max(0, hb - (v.r ? 1.5 : 0))}" rx="2" class="m-bl"/>`;
    if (i % 7 === 0 || i === vals.length - 1) g += `<text x="${x + bw / 2}" y="${H - 6}" class="ax" text-anchor="middle">${md(v.d)}</text>`;
    g += `<rect x="${L + 1 + i * cw}" y="${T}" width="${cw}" height="${H - T - B}" class="hit" data-tip="${md(v.d)} · 영수증 ${v.r} · 블로그 ${v.b}"/>`;
  });
  const tr = vals.reduce((s, v) => s + v.r, 0), tb = vals.reduce((s, v) => s + v.b, 0);
  return `<div class="panel chart"><div class="panel-head"><h2>일별 게시 건수</h2><span class="small muted num">영수증 ${tr} · 블로그 ${tb}</span></div>${LEG}
    <div class="svgwrap"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="일별 게시 건수, 영수증 ${tr}건 블로그 ${tb}건">${g}</svg><div class="tip" hidden></div></div>
    <p class="small muted">분석에 쓴 관련 자료만 · 게시일 기준</p></div>`;
}
function weeklyPanel() {
  const W = S.weekly; if (!W || !W.weeks.length) return "";
  const weeks = [...W.weeks].reverse();  // 오래된 주 → 최근 주
  const max = Math.max(1, ...weeks.map((w) => w.receipt + w.blog));
  const step = max <= 10 ? 2 : max <= 30 ? 5 : max <= 60 ? 10 : 20, top = Math.ceil(max / step) * step;
  const Wd = 640, H = 190, L = 28, B = 24, T = 8, cw = (Wd - L - 4) / weeks.length, bw = Math.min(46, cw - 10);
  const y = (v) => T + (H - T - B) * (1 - v / top);
  let g = "";
  for (let t = 0; t <= top; t += step) g += `<line x1="${L}" x2="${Wd}" y1="${y(t)}" y2="${y(t)}" class="grid"/><text x="${L - 6}" y="${y(t) + 4}" class="ax" text-anchor="end">${t}</text>`;
  weeks.forEach((w, i) => {
    const x = L + 2 + i * cw + (cw - bw) / 2, base = H - B, hr = (H - T - B) * (w.receipt / top), hb = (H - T - B) * (w.blog / top);
    if (w.receipt) g += `<rect x="${x}" y="${base - hr}" width="${bw}" height="${hr}" rx="3" class="m-rc${w.partial ? " part" : ""}"/>`;
    if (w.blog) g += `<rect x="${x}" y="${base - hr - hb}" width="${bw}" height="${Math.max(0, hb - 2)}" rx="3" class="m-bl${w.partial ? " part" : ""}"/>`;
    g += `<text x="${x + bw / 2}" y="${base - hr - hb - 5}" class="ax v" text-anchor="middle">${w.receipt + w.blog}</text>`;
    g += `<text x="${x + bw / 2}" y="${H - 7}" class="ax" text-anchor="middle">${md(w.week)}주</text>`;
    g += `<rect x="${L + 1 + i * cw}" y="${T}" width="${cw}" height="${H - T - B}" class="hit" data-tip="${md(w.week)}~${md(w.end)} · 영수증 ${w.receipt} · 블로그 ${w.blog}${w.partial ? " · 일부 기간" : ""}"/>`;
  });
  const asp = ["빵 식감", "재료", "맛", "양", "응대", "가격", "대기", "포장"];
  const rows = W.weeks.map((w) => `<tr>
    <td><b>${md(w.week)}~${md(w.end)}</b> ${w.partial ? chip(new Date(w.end) > new Date() ? "진행 중" : "일부 기간", "gray") : ""}${w.small ? chip("표본 적음", "warn") : ""}</td>
    <td>${w.receipt}</td><td>${w.blog}</td><td>${w.disclosed}</td><td>${w.event}</td><td>${w.negative}</td>
    ${asp.map((a) => `<td title="영수증 리뷰 ${w.n_text}건 중 ${w.aspects[a]}건">${w.n_text ? Math.round((w.aspects[a] / w.n_text) * 100) + "%" : "—"}</td>`).join("")}</tr>`).join("");
  const ai = W.ai.map((a) => `<details class="wk"><summary><b>${md(a.week)}주 분석</b> <span class="small muted">${dt(a.created_at)} · 범위 ${esc(a.period.join(" ~ "))} · 불편 ${a.complaint_total}개</span></summary>
    <div class="grid2" style="margin-top:8px">
      <div class="stack"><div class="eyebrow">칭찬 TOP 3</div><ol class="plain">${a.praise.map((p) => `<li>${esc(p.point)} <span class="muted small num">${p.n}건</span></li>`).join("") || "<li class='muted'>없음</li>"}</ol>
        <div class="eyebrow">추천 주제</div><ol class="plain">${a.topics.map((t) => `<li>${esc(t)}</li>`).join("")}</ol></div>
      <div class="stack"><div class="eyebrow">불편 사항</div><ol class="plain">${a.complaints.map((p) => `<li>${esc(p.point)} <span class="muted small num">${p.n}건</span></li>`).join("") || "<li class='muted'>없음</li>"}</ol>
        <div class="eyebrow">사용 완료한 초안</div>${a.used.length ? `<ol class="plain">${a.used.map((u) => `<li>${esc(u)}</li>`).join("")}</ol>` : `<p class="small muted">아직 없음</p>`}</div>
    </div></details>`).join("");
  return `<div class="panel" id="weekly"><div class="panel-head"><h2>주간 추이</h2><span class="small muted">${W.weeks.length}주 · ${md(W.start)}부터 쌓인 자료</span></div>
    <p class="small muted">게시일 기준으로 주(월~일)마다 묶었어요. 숫자를 나란히 놓기만 하고 늘었다·줄었다고 판단하지 않아요. 영수증 리뷰가 10건 미만인 주는 '표본 적음'이에요.</p>
    <div class="legend"><span><i class="sw rc"></i>영수증 리뷰</span><span><i class="sw bl"></i>블로그</span><span><i class="sw rc" style="opacity:.55"></i>흐린 막대 = 일부 기간(수집 시작 주·진행 중인 주)</span></div>
    <div class="svgwrap"><svg viewBox="0 0 ${Wd} ${H}" role="img" aria-label="주별 게시 건수">${g}</svg><div class="tip" hidden></div></div>
    <div class="tablewrap"><table class="cmp wkt"><tr><th>주</th><th>영수증</th><th>블로그</th><th>협찬 표기</th><th>이벤트 언급</th><th>불편 표현</th>${asp.map((a) => `<th>${a}</th>`).join("")}</tr>${rows}</table></div>
    <p class="small muted">항목 % = 그 주 영수증 리뷰 중 해당 표현이 나온 비율 (관찰) · 불편 표현 = 단어 기준이라 오탐 포함</p>
    <div class="stack"><div class="eyebrow">주별 AI 분석 기록 <span class="label-ai">AI 해석</span></div>${ai || `<p class="empty">아직 없어요.</p>`}</div>
  </div>`;
}
function pairBars(title, rows, nR, nB, note) {
  if (!rows.length) return `<div class="panel chart"><h2>${title}</h2><p class="empty">자료가 없어요.</p></div>`;
  return `<div class="panel chart"><div class="panel-head"><h2>${title}</h2><span class="label-fact">관찰</span></div>${LEG}
    <div class="pairs">${rows.map((r) => {
      const pr = nR ? Math.round((r.r / nR) * 100) : 0, pb = nB ? Math.round((r.b / nB) * 100) : 0;
      return `<div class="pair" title="${esc(r.term)} — 영수증 ${nR}건 중 ${r.r}건(${pr}%) · 블로그 ${nB}건 중 ${r.b}건(${pb}%)">
        <span class="pl">${esc(r.term)}</span>
        <span class="pt"><span class="pb rc" style="width:${pr}%"></span></span><span class="pv num">${pr}%</span>
        <span class="pt"><span class="pb bl" style="width:${pb}%"></span></span><span class="pv num">${pb}%</span></div>`;
    }).join("")}</div>
    <p class="small muted">${note}</p></div>`;
}
function merged(f, key, limit) {
  const m = {};
  ["receipt", "blog"].forEach((g) => f[g][key].forEach((x) => { (m[x.term] = m[x.term] || { term: x.term, r: 0, b: 0 })[g === "receipt" ? "r" : "b"] = x.count; }));
  return Object.values(m).sort((a, b) => (b.r / (f.receipt.n || 1) + b.b / (f.blog.n || 1)) - (a.r / (f.receipt.n || 1) + a.b / (f.blog.n || 1))).slice(0, limit);
}
function topList(ai, key, empty) {
  const items = [];
  ["receipt", "blog"].forEach((g) => (ai?.[g]?.[key] || []).forEach((p) => items.push({ ...p, g })));
  items.sort((a, b) => b.refs.length - a.refs.length);
  if (!items.length) return `<p class="empty">${esc(empty)}</p>`;
  const more = items.length > 10 ? `<p class="small muted">상위 10개만 보여요 (전체 ${items.length}개 · 상세 분석에서 모두 보기)</p>` : "";
  const few = items.length < 10 ? `<p class="small muted">근거가 있는 항목만 ${items.length}개 찾았어요</p>` : "";
  return more + few + `<ol class="rank">${items.slice(0, 10).map((p) => `<li><div class="rk-main"><span class="src-dot ${p.g === "receipt" ? "rc" : "bl"}" title="${p.g === "receipt" ? "영수증 리뷰" : "블로그"}"></span><span>${linkify(p.point)}</span></div>
    <div class="rk-sub small muted"><b class="num">${p.refs.length}건</b><span>${p.g === "receipt" ? "영수증 리뷰" : "블로그"}</span>${refLinks(p.refs, 4)}</div></li>`).join("")}</ol>`;
}
function storeUnconfirmed() {
  const st = S.store || {};
  const m = (st.menus || []).filter((x) => x.price_status === "후기 기준").length;
  const d = (st.discounts || []).filter((x) => x.status === "후기 기준").length;
  const o = (st.options || []).filter((x) => x.status === "후기 기준").length;
  return { total: m + d + o, m, d, o };
}
function kpi(label, value, sub, cls = "", go = "") {
  const inner = `<span class="k-l">${label}</span><span class="k-v num">${value}</span><span class="k-s">${sub}</span>`;
  return go ? `<button class="kpi link ${cls}" data-go="${go}" type="button">${inner}</button>` : `<div class="kpi ${cls}">${inner}</div>`;
}

function renderSummary() {
  const an = S.analysis; const run = S.runs[0]; const sc = scheduleText();
  const ai = an && an.ai_status === "ok" ? an.ai : null;
  const drafts = S.drafts.filter((d) => !d.superseded);
  const runChip = run ? chip(...(RUN[run.status] || [run.status, "gray"])) : chip("실행 기록 없음", "gray");
  let html = `
  <div class="dash-head">
    <div><h1>이번 주 대시보드</h1>
      <p class="muted small">${an ? esc(an.basis) : "아직 분석 전이에요"} ${an && /뿐이라|미만이에요/.test(an.basis) ? chip("새 자료 적음", "warn") : ""}</p></div>
    <div class="row">${runChip}<span class="small muted">마지막 성공 수집 ${S.last_success_run ? dt(S.last_success_run) : "없음"}</span>${chip(sc.t, sc.cls)}</div>
  </div>
  <div id="jobBox"></div>`;
  if (!an) {
    html += `<div class="panel"><h2>아직 분석한 자료가 없어요</h2>
      <p><b>지금 조회하고 초안 만들기</b>를 누르면 최근 ${S.settings.first_days}일 영수증 리뷰와 블로그 글을 모아 분석하고 초안을 만들어요. 보통 10~15분 걸려요.</p></div>`;
    app.innerHTML = `<section class="view">${html}</section>`; renderJob(); return;
  }
  const f = an.facts;
  const newR = run?.stats?.sources?.place_receipt?.new, newB = (run?.stats?.sources?.place_blog?.new || 0) + (run?.stats?.sources?.search_blog?.new || 0);
  const ads = f.blog_ads || {};
  const compl = ai ? ["receipt", "blog"].reduce((s, g) => s + ai[g].complaints.length, 0) : null;
  const pend = f.pending_check + f.unread.length;
  const ds = STATUSES.map((s) => drafts.filter((d) => d.status === s).length);
  const su = storeUnconfirmed();
  html += `<div class="kpis">
    ${kpi("영수증 리뷰", f.receipt.n, run ? `이번 실행 새로 ${newR ?? 0}건` : "", "", "items")}
    ${kpi("블로그 글", f.blog.n, `${run ? `새로 ${newB}건 · ` : ""}협찬 표기 ${ads.disclosed || 0} · 이벤트 ${ads.event || 0}`, "", "items")}
    ${kpi("불편 사항", compl ?? "—", ai ? "AI가 근거와 함께 찾은 항목" : "AI 해석 없음", compl ? "warn" : "", "")}
    ${kpi("확인 필요 자료", pend, `잠실점 여부 ${f.pending_check} · 본문 없음 ${f.unread.length}`, pend ? "warn" : "", "items")}
    ${kpi("초안", drafts.length, `검토 전 ${ds[0]} · 수정 중 ${ds[1]} · 사용 완료 ${ds[2]}`, ds[0] ? "accent" : "ok", "drafts")}
    ${kpi("매장 정보 확인", su.total ? `${su.total}개 남음` : "완료", su.total ? `가격 ${su.m} · 혜택 ${su.d} · 옵션 ${su.o} 후기 기준` : "모두 공식·확인", su.total ? "warn" : "ok", "store")}
  </div>
  ${an.ai_status !== "ok" ? `<div class="note bad small">AI 해석 실패: ${esc(an.ai_error || an.ai_status)}. 아래는 단어 기준 관찰만이에요. <button class="btn sm" id="reanalyze">분석 다시 하기</button></div>` : ""}
  <div class="dash-grid">
    <div class="span-7">${dailyChart(an)}</div>
    <div class="span-5">${pairBars("고객 반응 항목", merged(f, "aspects", 8), f.receipt.n, f.blog.n, "각 그룹에서 해당 표현이 나온 글의 비율 · 블로그는 글이 길어 대부분 높게 나와요")}</div>
  </div>
  ${weeklyPanel()}
  <div class="dash-grid three">
    <div class="panel"><div class="panel-head"><h2>반복되는 칭찬</h2><span class="label-ai">AI 해석</span></div>${topList(ai, "praise", "없음")}</div>
    <div class="panel"><div class="panel-head"><h2>불편 사항</h2><span class="label-ai">AI 해석</span></div>${topList(ai, "complaints", "이 기간 자료에서는 찾지 못했어요")}</div>
    <div class="panel"><div class="panel-head"><h2>고객이 궁금해한 것</h2><span class="label-ai">AI 해석</span></div>${topList(ai, "questions", "없음")}</div>
  </div>
  <div class="dash-grid">
    <div class="span-7 panel"><div class="panel-head"><h2>추천 콘텐츠 주제</h2><span class="label-ai">AI 해석</span></div>
      ${ai && ai.topics.length ? `<div class="topics two">${ai.topics.map((t, i) => `<div class="topic">
        <div class="row">${chip(t.format === "blog" ? "블로그" : t.format === "thread" ? "스레드" : "블로그·스레드")}<span class="small muted num">근거 ${t.refs.length}건</span></div>
        <h3>${esc(t.title)}</h3><p class="small">${linkify(t.why)}</p>
        ${t.repeat_risk && !/없음|처음|최초|비어/.test(t.repeat_risk) ? `<p class="small" style="color:var(--warn)">반복 주의: ${esc(t.repeat_risk)}</p>` : ""}
        <div><button class="btn sm" data-topic="${i}">이 주제로 블로그 초안</button></div></div>`).join("")}</div>` : `<p class="empty">AI 해석이 있어야 주제를 추천해요.</p>`}
    </div>
    <div class="span-5 stack" style="gap:20px;align-content:start">
      <div class="panel"><div class="panel-head"><h2>생성된 초안</h2><button class="btn ghost sm" data-go="drafts">열기</button></div>
        <div class="dbar" aria-label="초안 상태">${STATUSES.map((s, i) => ds[i] ? `<span class="seg s${i}" style="flex:${ds[i]}">${s} ${ds[i]}</span>` : "").join("")}</div>
        ${drafts.length ? `<div class="stack">${drafts.map((d) => `<div class="drow"><select class="status-select" data-s="${esc(d.status)}" data-status-id="${d.id}" aria-label="상태">${STATUSES.map((s) => `<option ${s === d.status ? "selected" : ""}>${s}</option>`).join("")}</select>
          <span class="dname">${d.kind === "blog" ? "블로그" : `스레드 ${d.slot}`} · ${esc(d.meta.topic)}</span>${d.warnings?.length ? chip(`점검 ${d.warnings.length}`, "warn") : ""}</div>`).join("")}</div>` : `<p class="empty">아직 초안이 없어요.</p>`}
      </div>
      ${pairBars("많이 언급된 메뉴", merged(f, "menus", 6), f.receipt.n, f.blog.n, "메뉴명이 나온 글의 비율 · 판매량이 아니에요")}
    </div>
  </div>
  <div class="panel"><div class="panel-head"><h2>할 일</h2><span class="small muted">운영 개선 · 게시 전 확인</span></div>
    <ul class="todo">
      ${f.conflicts.map((c) => `<li class="bad"><b>${esc(c.type)} 충돌 · ${esc(c.field)}</b><span>매장 정보 ${esc(c.store)} / 후기 ${esc(c.review)} · <a href="${esc(c.ref.url)}" target="_blank" rel="noopener">${esc(refLabel(c.ref))}</a></span></li>`).join("")}
      ${ai ? ai.improvements.map((p) => `<li class="warn"><b>${linkify(p.issue)}</b><span>${linkify(p.suggestion)} · 근거 ${p.refs.length}건 ${refLinks(p.refs, 4)}</span></li>`).join("") : ""}
      ${ai ? ai.store_checks.map((p) => `<li><b>${linkify(p.claim)}</b><span>${linkify(p.why)} ${refLinks(p.refs, 4)}</span></li>`).join("") : ""}
      ${su.total ? `<li><b>매장 정보 ${su.total}개가 '후기 기준'이에요</b><span>확인하면 초안에서 사실로 쓸 수 있어요 <button class="btn ghost sm" data-go="store">매장 정보로</button></span></li>` : ""}
      ${f.pending_check ? `<li><b>잠실점 글인지 확인이 필요한 자료 ${f.pending_check}건</b><span>분석에서 빠져 있어요 <button class="btn ghost sm" data-go="items" data-filter="check">확인하러 가기</button></span></li>` : ""}
    </ul>
  </div>
  <details class="panel"><summary>영수증 리뷰 · 블로그 상세 분석</summary><div class="grid2" style="margin-top:12px">${groupPanel("receipt", "영수증 리뷰", f, ai)}${groupPanel("blog", "블로그 글", f, ai)}</div></details>
  <details class="panel"><summary>지난 분석과 비교</summary>${compareTable(f.compare)}</details>
  ${run ? `<details class="panel"><summary>최근 실행의 출처별 결과 (${esc(run.window_from || "")} ~ ${esc(run.window_to || "")})</summary>${sourceRows(run)}</details>` : ""}`;
  app.innerHTML = `<section class="view">${html}</section>`;
  renderJob();
  bindChartTips();
  app.querySelectorAll("[data-topic]").forEach((b) => b.onclick = () => {
    const t = ai.topics[+b.dataset.topic];
    startJob("/api/generate", { analysis_id: an.id, blog_topic: `${t.title} — ${t.angle}`, only: "blog" }, "블로그 초안을 새로 만들어요. 기존 수정본은 그대로 둬요.");
  });
  const re = document.getElementById("reanalyze"); if (re) re.onclick = () => startJob("/api/reanalyze", {}, "분석을 다시 해요");
  app.querySelectorAll("[data-status-id]").forEach((sel) => sel.onchange = async () => {
    sel.dataset.s = sel.value; await saveDraft(+sel.dataset.statusId, { status: sel.value });
    const d = S.drafts.find((x) => x.id === +sel.dataset.statusId); d.status = sel.value; toast(`'${sel.value}'로 바꿨어요`); renderSummary();
  });
}
function bindChartTips() {
  app.querySelectorAll(".svgwrap").forEach((w) => {
    const tip = w.querySelector(".tip");
    const show = (e) => {
      const t = e.target.closest(".hit"); if (!t) { tip.hidden = true; return; }
      const r = w.getBoundingClientRect(), b = t.getBoundingClientRect();
      tip.textContent = t.dataset.tip; tip.hidden = false;
      tip.style.left = `${Math.min(r.width - 150, Math.max(0, b.left - r.left - 40))}px`; tip.style.top = "0px";
      w.querySelectorAll(".hit.on").forEach((x) => x.classList.remove("on")); t.classList.add("on");
    };
    w.addEventListener("mousemove", show); w.addEventListener("click", show);
    w.addEventListener("mouseleave", () => { tip.hidden = true; w.querySelectorAll(".hit.on").forEach((x) => x.classList.remove("on")); });
  });
}

/* ---------------- 작업(수집·분석·생성) 진행 ---------------- */
function renderJob() {
  const box = document.getElementById("jobBox"); const j = S.job;
  const btn = document.getElementById("runBtn"); btn.disabled = j.running;
  if (!box) return;
  if (!j.running && !j.error) { box.innerHTML = ""; return; }
  box.innerHTML = `<div class="panel"><div class="panel-head"><h2>${j.running ? "실행 중…" : "마지막 작업이 실패했어요"}</h2>${j.running ? chip("창을 닫아도 계속돼요", "gray") : ""}</div>
    ${j.error ? `<div class="note bad">${esc(j.error)}</div>` : ""}<div class="log">${esc(j.log.slice(-40).join("\n"))}</div></div>`;
  const lg = box.querySelector(".log"); if (lg) lg.scrollTop = lg.scrollHeight;
}
async function startJob(path, body, msg) {
  try {
    const r = await api(path, body);
    if (r.started === false) { toast(r.error || "이미 다른 작업이 실행 중이에요"); return; }
    toast(msg || "시작했어요");
    S.job = { running: true, log: [], error: null };
    if (tab !== "summary") go("summary"); else renderJob();
    poll();
  } catch (e) { toast(e.message); }
}
function poll() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    const was = S.job.running;
    const st = await api("/api/state").catch(() => null);
    if (!st) return poll();
    if (st.job.running) { S.job = st.job; renderJob(); return poll(); }
    await flushSaves();
    S = st; ITEMS = null;
    if (was) toast(st.job.error ? "실행이 끝났지만 오류가 있어요" : "완료했어요");
    render();
  }, 2000);
}
document.getElementById("runBtn").onclick = () => startJob("/api/run", {}, "조회를 시작했어요. 보통 10~15분 걸려요");

/* ---------------- 수집 자료 ---------------- */
const filt = { kind: "", src: "", rel: "", q: "" };
async function renderItems() {
  if (!ITEMS) { app.innerHTML = `<p class="empty">자료를 불러오는 중…</p>`; ITEMS = await api("/api/items"); }
  const rows = ITEMS.filter((it) => (!filt.kind || it.kind === filt.kind) && (!filt.src || it.sources.split(",").includes(filt.src))
    && (!filt.rel || (filt.rel === "unread" ? it.body_status === "snippet_only" : it.relevance_effective === filt.rel))
    && (!filt.q || `${it.title || ""} ${it.body || ""} ${it.snippet || ""}`.includes(filt.q)));
  const cnt = (f) => ITEMS.filter(f).length;
  const sel = (id, opts, v) => `<select id="${id}">${opts.map(([k, t]) => `<option value="${k}" ${k === v ? "selected" : ""}>${esc(t)}</option>`).join("")}</select>`;
  app.innerHTML = `<section class="view">
  <div class="panel"><div class="panel-head"><h1>수집한 리뷰·블로그 자료</h1><span class="muted small num">전체 ${ITEMS.length}건</span></div>
    <div class="row small">${chip(`영수증 ${cnt((i) => i.kind === "receipt")}`)}${chip(`블로그 ${cnt((i) => i.kind === "blog")}`)}
      ${chip(`확인 필요 ${cnt((i) => i.relevance_effective === "check")}`, "warn")}${chip(`제외 ${cnt((i) => i.relevance_effective === "excluded")}`, "gray")}
      ${chip(`본문 미확인 ${cnt((i) => i.body_status === "snippet_only")}`, "gray")}</div>
    <p class="small muted">게시일은 네이버에 표시된 작성일(블로그는 글의 발행 시각), 수집일은 이 앱이 처음 가져온 날이에요. 같은 글은 한 번만 저장하고 출처를 합쳐 표시해요.</p>
    <div class="filters">
      ${sel("fKind", [["", "종류 전체"], ["receipt", "영수증 리뷰"], ["blog", "블로그"]], filt.kind)}
      ${sel("fSrc", [["", "출처 전체"], ["place_receipt", "영수증 리뷰"], ["place_blog", "플레이스 연결 블로그"], ["search_blog", "별도 검색 블로그"], ["manual", "직접 입력"]], filt.src)}
      ${sel("fRel", [["", "관련성 전체"], ["related", "관련"], ["check", "확인 필요"], ["excluded", "제외"], ["unread", "본문 미확인"]], filt.rel)}
      <input class="inline" id="fQ" placeholder="본문 검색" value="${esc(filt.q)}">
    </div>
    <div class="row local-only"><span class="small muted">관련성을 바꾼 뒤에는</span><button class="btn sm" id="reanalyze2">분석·초안 다시 하기</button><span class="small muted">(수정한 초안은 그대로 둬요)</span></div>
  </div>
  <div class="panel"><div class="panel-head"><h2>목록</h2><span class="muted small num">${rows.length}건</span></div>
    <div>${rows.slice(0, 300).map(itemRow).join("") || `<p class="empty">조건에 맞는 자료가 없어요.</p>`}</div>
    ${rows.length > 300 ? `<p class="small muted">앞 300건만 보여요. 필터로 좁혀 주세요.</p>` : ""}
  </div>
  ${manualPanel()}
  </section>`;
  const bind = (id, k) => { const el = document.getElementById(id); el.oninput = el.onchange = () => { filt[k] = el.value; renderItems(); if (k === "q") { const q = document.getElementById("fQ"); q.focus(); q.setSelectionRange(q.value.length, q.value.length); } }; };
  bind("fKind", "kind"); bind("fSrc", "src"); bind("fRel", "rel"); bind("fQ", "q");
  document.getElementById("reanalyze2").onclick = () => startJob("/api/reanalyze", {}, "분석을 다시 해요");
  app.querySelectorAll(".item .body").forEach((b) => b.onclick = () => b.parentElement.classList.toggle("open"));
  app.querySelectorAll("[data-rel]").forEach((b) => b.onclick = async () => {
    const id = b.closest(".item").dataset.id; const v = b.dataset.rel || null;
    await api(`/api/items/${encodeURIComponent(id)}/relevance`, { value: v });
    const it = ITEMS.find((x) => x.id === id); it.relevance_user = v; it.relevance_effective = v || it.relevance;
    toast(v ? `'${REL[v]}'으로 표시했어요` : "자동 판정으로 되돌렸어요"); renderItems();
  });
  bindManual();
  if (SHARE) lockDown();
}
function itemRow(it) {
  const srcs = it.sources.split(",").map((s) => chip(SRC[s] || s, "gray")).join("");
  const ad = AD[it.ad_flag];
  const rel = it.relevance_effective;
  return `<div class="item" data-id="${esc(it.id)}">
    <div class="meta">${chip(it.kind === "receipt" ? "영수증 리뷰" : "블로그")}${srcs}
      ${chip(REL[rel] || rel, REL_CLS[rel])}${it.relevance_user ? chip("직접 지정", "gray") : ""}
      ${it.body_status === "snippet_only" ? chip("본문 미확인", "warn") : ""}${it.body_status === "manual_text" ? chip("붙여 넣은 텍스트", "gray") : ""}
      ${it.kind === "blog" && ad ? chip(ad[0], ad[1]) : ""}${it.kind === "receipt" && it.ad_flag === "event" ? chip(AD.event[0], "warn") : ""}
      <span class="num">게시 ${esc(it.published_at || "미상")} · 수집 ${esc((it.collected_at || "").slice(0, 10))}</span>
      ${it.rating ? `<span>별점 ${it.rating}</span>` : ""}${it.visit_count > 1 ? `<span>${it.visit_count}번째 방문</span>` : ""}</div>
    ${it.title ? `<div class="title">${it.url ? `<a href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.title)}</a>` : esc(it.title)}</div>` : ""}
    <div class="body">${esc(it.body || it.snippet || "(내용 없음)")}</div>
    <div class="small muted">판정 근거: ${esc(it.relevance_reason || "")}${it.ad_evidence ? ` · 표기 문구: “${esc(it.ad_evidence)}”` : ""}</div>
    <div class="row">${!it.title && it.url ? `<a class="small" href="${esc(it.url)}" target="_blank" rel="noopener">원문 보기</a>` : ""}
      <button class="btn sm" data-rel="related">관련 있음</button><button class="btn sm" data-rel="excluded">제외</button>
      ${it.relevance_user ? `<button class="btn ghost sm" data-rel="">자동 판정으로</button>` : ""}</div>
  </div>`;
}
function manualPanel() {
  return `<div class="panel local-only" id="manual"><div class="panel-head"><h2>직접 입력</h2><span class="small muted">수집이 막히거나 빠진 자료를 넣을 때</span></div>
    <div class="form-grid">
      <div class="field"><label for="mKind">종류</label><select id="mKind"><option value="blog">블로그 글</option><option value="receipt">영수증 리뷰</option></select></div>
      <div class="field"><label for="mUrl">링크 (네이버 블로그면 본문을 읽어 와요)</label><input id="mUrl" placeholder="https://blog.naver.com/…"></div>
      <div class="field"><label for="mDate">게시일</label><input id="mDate" type="date"></div>
    </div>
    <div class="field"><label for="mText">본문 텍스트 (링크로 못 읽을 때 붙여 넣기)</label><textarea id="mText"></textarea></div>
    <div class="row"><button class="btn primary" id="mAdd">자료 추가</button>
      <label class="btn" for="mFile">파일로 넣기 (.txt · .csv · .json)</label><input id="mFile" type="file" accept=".txt,.csv,.json" hidden>
      <span class="small muted">txt는 빈 줄로 나눈 덩어리마다 1건, csv는 text·date·url·kind 열</span></div></div>`;
}
function bindManual() {
  document.getElementById("mAdd").onclick = async () => {
    const body = { kind: val("mKind"), url: val("mUrl"), published_at: val("mDate"), text: val("mText") };
    if (!body.url && !body.text) return toast("링크나 본문을 넣어 주세요");
    try { const r = await api("/api/manual", body); toast(r.message || "추가했어요"); if (r.id) { ITEMS = null; renderItems(); } }
    catch (e) { toast(e.message); }
  };
  document.getElementById("mFile").onchange = (ev) => {
    const f = ev.target.files[0]; if (!f) return;
    const rd = new FileReader();
    rd.onload = async () => {
      try { const r = await api("/api/manual/file", { filename: f.name, content: rd.result, kind: val("mKind") });
        toast(`추가 ${r.added} · 중복 ${r.duplicate} · 실패 ${r.failed}`); ITEMS = null; renderItems(); }
      catch (e) { toast(e.message); }
    };
    rd.readAsText(f);
  };
}
const val = (id) => document.getElementById(id).value.trim();

/* ---------------- 초안 ---------------- */
function draftCard(d) {
  const m = d.meta || {};
  const blog = d.kind === "blog";
  const current = !d.superseded;
  const titles = blog ? (d.titles || []).map((t, i) => `<div class="title-row"><span class="muted num">${i + 1}</span>
      <input data-title="${i}" value="${esc(t)}" aria-label="제목 후보 ${i + 1}"><button class="btn sm" data-copy-title="${i}">복사</button></div>`).join("") : "";
  return `<article class="draft" data-id="${d.id}">
    <div class="write">
      <div class="row">${chip(blog ? "블로그" : `스레드 ${d.slot}`)}${m.tone ? chip(m.tone, "gray") : ""}
        <select class="status-select" data-s="${esc(d.status)}">${STATUSES.map((s) => `<option ${s === d.status ? "selected" : ""}>${s}</option>`).join("")}</select>
        ${!current ? chip("이전 분석의 수정본", "gray") : ""}<span class="saved" data-saved>${d.edited ? `수정 저장 ${dt(d.updated_at)}` : "AI 초안 그대로"}</span></div>
      <h3>${esc(m.topic)}</h3>
      ${blog ? `<div class="stack"><div class="eyebrow">제목 후보</div>${titles}</div>` : ""}
      <textarea class="body ${blog ? "blog" : "thread"}" aria-label="본문">${esc(d.body)}</textarea>
      <div class="row"><span class="small muted num" data-count></span><span style="margin-left:auto"></span>
        <button class="btn primary sm" data-copy-body>본문 복사</button></div>
      ${d.edited ? `<details><summary>AI가 처음 쓴 글 보기</summary><div class="quote" style="white-space:pre-wrap">${esc(d.original_body)}</div></details>` : ""}
    </div>
    <div class="why"><dl>
      <div><dt>이 주제를 고른 이유</dt><dd>${esc(m.reason)}</dd></div>
      <div><dt>전달하려는 핵심 메시지</dt><dd>${esc(m.key_message)}</dd></div>
      <div><dt>활용한 후기 근거 (${(m.refs || []).length}건)</dt><dd>${refLinks(m.refs || [], 12)}</dd></div>
      <div><dt>게시 전 확인할 매장 정보</dt><dd>${(m.store_checks || []).length ? `<ul class="warns" style="color:inherit">${m.store_checks.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "없음"}</dd></div>
      <div><dt>자동 점검</dt><dd data-warn>${warnList(d.warnings)}</dd></div>
      ${blog && m.photos?.length ? `<div><dt>사진 넣을 자리</dt><dd><ul class="warns" style="color:inherit">${m.photos.map((p, i) => `<li><b>[사진${i + 1}]</b> ${esc(p.where)} — ${esc(p.what)}</li>`).join("")}</ul></dd></div>` : ""}
      <div><dt>자료 범위</dt><dd class="small">${esc(m.basis || "")}${m.few_new ? `<div class="note warn small" style="margin-top:6px">이번 기간 새 후기가 적어 이미 확인한 이전 자료를 함께 썼어요.</div>` : ""}</dd></div>
    </dl></div>
  </article>`;
}
function warnList(w) {
  return w && w.length ? `<ul class="warns">${w.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : `<span class="muted small">걸린 항목 없음</span>`;
}
function countText(txt, blog) {
  const n = txt.replace(/\[사진\d+\]/g, "").replace(/^#+\s?/gm, "").trim().length;
  if (!blog) return `${n.toLocaleString()}자`;
  const { min, max } = S.settings.blog_len;
  return `${n.toLocaleString()}자 (공백 포함 · 목표 ${min.toLocaleString()}~${max.toLocaleString()}자)`;
}
function renderDrafts() {
  const an = S.analysis; const st = S.settings;
  const cur = S.drafts.filter((d) => !d.superseded);
  const kept = S.drafts.filter((d) => d.superseded && d.edited);
  const order = (a, b) => (a.kind === b.kind ? a.slot - b.slot : a.kind === "blog" ? -1 : 1);
  const blogs = cur.filter((d) => d.kind === "blog").sort((a, b) => b.id - a.id);
  const threads = cur.filter((d) => d.kind === "thread").sort((a, b) => b.id - a.id || order(a, b));
  app.innerHTML = `<section class="view">
  <div class="panel"><div class="panel-head"><h1>블로그 · 스레드 초안</h1><span class="small muted">${SHARE ? "읽기 전용 · 본문 복사 가능" : "입력하면 자동 저장 · 게시는 복사해서 직접"}</span></div>
    <div class="form-grid local-only">
      <div class="field"><label for="dTone">스레드 말투</label><select id="dTone">${["반말", "존댓말", "친근한 존댓말(해요체)"].map((t) => `<option ${t === st.thread_tone ? "selected" : ""}>${t}</option>`).join("")}<option value="__custom" ${!["반말", "존댓말", "친근한 존댓말(해요체)"].includes(st.thread_tone) ? "selected" : ""}>직접 입력…</option></select>
        <input id="dToneCustom" placeholder="예: 담백한 반말, 문장 짧게" value="${!["반말", "존댓말", "친근한 존댓말(해요체)"].includes(st.thread_tone) ? esc(st.thread_tone) : ""}" ${["반말", "존댓말", "친근한 존댓말(해요체)"].includes(st.thread_tone) ? "hidden" : ""}></div>
      <div class="field"><label for="dMin">블로그 길이 (공백 포함)</label><div class="row"><input class="inline num" id="dMin" type="number" step="100" value="${st.blog_len.min}" style="width:96px"> ~ <input class="inline num" id="dMax" type="number" step="100" value="${st.blog_len.max}" style="width:96px"> 자</div></div>
      <div class="field"><label>다시 만들기 (고친 초안은 덮어쓰지 않아요)</label><div class="row">
        <button class="btn sm" data-regen="blog" ${an ? "" : "disabled"}>블로그만</button><button class="btn sm" data-regen="threads" ${an ? "" : "disabled"}>스레드 3개만</button><button class="btn sm" data-regen="all" ${an ? "" : "disabled"}>모두</button></div></div>
    </div>
  </div>
  ${!cur.length ? `<div class="panel"><p class="empty">아직 초안이 없어요. 위쪽의 <b>지금 조회하고 초안 만들기</b>를 눌러 주세요.</p></div>` : ""}
  ${blogs.map(draftCard).join("")}
  ${threads.length ? `<div class="threads">${threads.map(draftCard).join("")}</div>` : ""}
  ${kept.length ? `<div class="panel"><h2>이전에 고쳐 둔 초안</h2><p class="small muted">다시 만들어도 사용자가 고친 초안은 여기 남아요.</p></div>${kept.map(draftCard).join("")}` : ""}
  <details class="panel" id="hist"><summary>손대지 않고 교체된 이전 초안 ${S.superseded_count}개 보기</summary><div id="histBody" class="stack"></div></details>
  </section>`;
  // 설정
  const tone = document.getElementById("dTone"), toneC = document.getElementById("dToneCustom");
  tone.onchange = () => { toneC.hidden = tone.value !== "__custom"; if (tone.value !== "__custom") saveSettings({ thread_tone: tone.value }); };
  toneC.onchange = () => toneC.value.trim() && saveSettings({ thread_tone: toneC.value.trim() });
  const len = () => { const mn = +val("dMin"), mx = +val("dMax"); if (mn > 0 && mx >= mn) saveSettings({ blog_len: { min: mn, max: mx } }); else toast("길이 범위를 확인해 주세요"); };
  document.getElementById("dMin").onchange = len; document.getElementById("dMax").onchange = len;
  app.querySelectorAll("[data-regen]").forEach((b) => b.onclick = () =>
    startJob("/api/generate", { analysis_id: an.id, only: b.dataset.regen }, "새 초안을 만들어요. 고친 초안은 그대로 둬요"));
  document.getElementById("hist").ontoggle = async (e) => {
    if (!e.target.open) return;
    const rows = await api("/api/drafts/history");
    document.getElementById("histBody").innerHTML = rows.length ? rows.map((d) => `<div class="stack"><div class="small muted">${dt(d.created_at)} · ${d.kind === "blog" ? "블로그" : "스레드"} · ${esc(d.meta.topic)}</div><div class="quote" style="white-space:pre-wrap">${esc(d.body)}</div>
      <div><button class="btn sm" data-copy-old="${d.id}">복사</button></div></div>`).join("") : `<p class="empty">없어요.</p>`;
    document.querySelectorAll("[data-copy-old]").forEach((b) => b.onclick = () => copyText(rows.find((r) => r.id === +b.dataset.copyOld).body));
  };
  app.querySelectorAll("article.draft").forEach(bindDraft);
}
function bindDraft(el) {
  const id = +el.dataset.id; const d = S.drafts.find((x) => x.id === id);
  const ta = el.querySelector("textarea.body"); const cnt = el.querySelector("[data-count]");
  const blog = d.kind === "blog";
  const upd = () => cnt.textContent = countText(ta.value, blog); upd();
  const titles = () => [...el.querySelectorAll("[data-title]")].map((i) => i.value);
  ta.oninput = () => { upd(); queueSave(id, el, () => ({ body: ta.value, ...(blog ? { titles: titles() } : {}) })); };
  el.querySelectorAll("[data-title]").forEach((i) => i.oninput = () => queueSave(id, el, () => ({ body: ta.value, titles: titles() })));
  el.querySelector("[data-copy-body]").onclick = () => copyText(ta.value);
  el.querySelectorAll("[data-copy-title]").forEach((b) => b.onclick = () => copyText(titles()[+b.dataset.copyTitle]));
  const sel = el.querySelector(".status-select");
  sel.onchange = async () => { sel.dataset.s = sel.value; d.status = sel.value; await saveDraft(id, { status: sel.value }); toast(`'${sel.value}'로 바꿨어요`); };
}
function queueSave(id, el, payload) {
  el.querySelector("[data-saved]").textContent = "저장 중…";
  const p = pending.get(id); if (p) clearTimeout(p.t);
  pending.set(id, { payload, el, t: setTimeout(() => runSave(id), 700) });
}
async function runSave(id) {
  const p = pending.get(id); if (!p) return; pending.delete(id);
  try {
    const r = await saveDraft(id, p.payload());
    const d = S.drafts.find((x) => x.id === id);
    Object.assign(d, p.payload(), { status: r.status, warnings: r.warnings, edited: r.edited });
    p.el.querySelector("[data-saved]").textContent = `수정 저장 ${dt(r.updated_at)}`;
    const sel = p.el.querySelector(".status-select"); sel.value = r.status; sel.dataset.s = r.status;
    p.el.querySelector("[data-warn]").innerHTML = warnList(r.warnings);
  } catch (e) { p.el.querySelector("[data-saved]").textContent = "저장 실패 — 연결을 확인해 주세요"; }
}
async function flushSaves() { await Promise.all([...pending.keys()].map((id) => { clearTimeout(pending.get(id).t); return runSave(id); })); }
const saveDraft = (id, body) => api(`/api/drafts/${id}`, body);
async function saveSettings(patch) {
  try { const r = await api("/api/settings", patch); S.settings = r.settings; toast("설정을 저장했어요"); } catch (e) { toast(e.message); }
}
window.addEventListener("beforeunload", () => { if (pending.size) flushSaves(); });
document.addEventListener("visibilitychange", () => { if (document.hidden) flushSaves(); });

/* ---------------- 매장 정보 · 실행 설정 ---------------- */
const STAT_CLS = { "공식": "ok", "확인": "ok", "후기 기준": "warn", "": "gray" };
const statChip = (s) => chip(s || "근거 없음", STAT_CLS[s ?? ""] ?? "gray");
const BASIC = [["name", "매장명"], ["address", "주소"], ["hours", "영업시간"], ["hours_detail", "이번 주 요일별"], ["parking", "주차"],
  ["facilities", "편의시설"], ["ordering", "주문·예약"], ["transit", "오시는 길"], ["location_hint", "찾는 법"]];
async function saveStore(msg) {
  try { const r = await api("/api/store", S.store); S.store = r.store; toast(msg || "저장했어요"); } catch (e) { toast(e.message); }
}
function renderStore() {
  const st = S.store; const s = S.settings; const sc = s.schedule; const sct = scheduleText();
  const f = S.analysis?.facts; const su = storeUnconfirmed();
  st.status = st.status || {}; st.sources = st.sources || {};
  const menus = st.menus || [];
  const nOfficial = BASIC.filter(([k]) => st[k]).length + (st.brand_facts || []).length + menus.filter((m) => m.feature_status === "공식").length;
  const basicRows = BASIC.map(([k, label]) => {
    const conf = st.status[k] === "확인"; const val = st[k] || "";
    const warnT = k === "transit" && /확인 필요/.test(val) && !conf;
    return `<div class="frow"><div class="fl">${label}</div>
      <div class="fv"><textarea data-basic="${k}" rows="${Math.max(1, Math.min(4, Math.ceil(val.length / 52)))}" aria-label="${label}">${esc(val)}</textarea>
        <div class="small muted">${conf ? "직접 확인함" : esc(st.sources[k] || "출처 없음")}</div></div>
      <div class="fs">${conf ? statChip("확인") : warnT ? statChip("후기 기준").replace("후기 기준", "확인 필요") : val ? statChip("공식") : statChip("")}
        ${conf ? "" : `<button class="btn sm" data-okbasic="${k}">확인</button>`}</div></div>`;
  }).join("");
  const menuRow = (m, i) => `<tr data-i="${i}">
      <td class="mname"><textarea data-m="name" rows="1" aria-label="메뉴명">${esc(m.name)}</textarea></td>
      <td class="mprice"><input data-m="price" class="num" value="${esc(m.price)}" placeholder="—" aria-label="매장가">
        <div class="row" style="gap:4px">${m.price ? statChip(m.price_status === "후기 기준" ? "후기 기준" : "확인") : ""}${m.price && m.price_status === "후기 기준" ? `<button class="btn sm" data-okprice="${i}">확인</button>` : ""}</div>
        <div class="small muted">${esc(m.price_status === "후기 기준" ? (m.price_source || "").replace(/ · \d{4}-\d{2}-\d{2}$/, "") : m.price ? (m.price_source && m.price_status === "확인" ? m.price_source : "직접 확인") : m.price_source || "")}</div></td>
      <td class="num muted">${m.delivery_price ? `${(+m.delivery_price).toLocaleString()}원` : "—"}</td>
      <td><textarea data-m="feature" rows="${Math.max(1, Math.min(7, Math.ceil((m.feature || "").length / 26)))}" placeholder="—" aria-label="특징">${esc(m.feature)}</textarea><div class="small muted">${m.feature ? esc(m.feature_status === "확인" ? "직접 확인" : m.feature_source || "") : ""}</div></td>
      <td><button class="btn ghost sm" data-delmenu="${i}" aria-label="삭제">삭제</button></td></tr>`;
  const mainIdx = [], restIdx = [];
  menus.forEach((m, i) => ((m.price || m.feature || !m.delivery_price) ? mainIdx : restIdx).push(i));
  const head = `<tr><th>메뉴</th><th>매장가</th><th>배달가(참고)</th><th>특징 (배민 메뉴 설명, 매장 작성)</th><th></th></tr>`;
  const menuRows = mainIdx.map((i) => menuRow(menus[i], i)).join("");
  const restRows = restIdx.map((i) => menuRow(menus[i], i)).join("");
  const listRows = (key) => (st[key] || []).map((d, i) => `<div class="lrow">
      <div><div>${esc(d.text)}${d.period ? ` <span class="muted small">(${esc(d.period)})</span>` : ""}</div><div class="small muted">${esc(d.status === "확인" ? "직접 확인" : d.source || "")}</div></div>
      <div class="row">${statChip(d.status)}${d.status === "후기 기준" ? `<button class="btn sm" data-oklist="${key}:${i}">확인</button>` : ""}<button class="btn ghost sm" data-dellist="${key}:${i}">삭제</button></div></div>`).join("") || `<p class="empty">없음</p>`;

  app.innerHTML = `<section class="view">
  <div class="dash-head"><div><h1>매장 정보</h1>
    <p class="small muted">초안은 <b>공식</b>(매장이 직접 올린 정보·대표님 안내문)과 <b>확인</b>(직접 확인한 값)만 사실로 써요. <b>후기 기준</b>은 초안에 [확인 필요]로 남아요.</p></div>
    <div class="row"><span class="small muted">${st.filled_at ? `자동 채움 ${dt(st.filled_at)}` : ""}</span><button class="btn local-only" id="refill">네이버·후기에서 다시 채우기</button></div></div>
  <div class="kpis three">
    ${kpi("공식 · 확인", nOfficial, "초안에서 사실로 쓰는 항목", "ok")}
    ${kpi("후기 기준", su.total, `매장가 ${su.m} · 혜택·이벤트 ${su.d} · 옵션·좌석 ${su.o}`, su.total ? "warn" : "ok")}
    ${kpi("매장가 근거 없음", menus.filter((m) => !m.price).length, "배달가만 알고 매장가는 못 찾은 메뉴", "")}
  </div>
  <div class="panel"><div class="panel-head"><h2>기본 정보</h2><span class="small muted">네이버 플레이스에 매장이 등록한 정보</span></div>
    <div class="frows">${basicRows}</div></div>
  <div class="panel"><div class="panel-head"><h2>메뉴 · 가격</h2><span class="small muted">${menus.length}개</span>
      ${su.m ? `<button class="btn sm" id="okAllPrices">후기 기준 가격 ${su.m}개 모두 확인</button>` : ""}</div>
    <div class="note warn small">네이버 메뉴 탭 가격은 <b>배민 배달가</b>라 매장가와 달라요(샌드위치 800원 차이). 매장가는 최근 영수증 리뷰·블로그에 반복해서 적힌 값을 넣었어요. 메뉴판과 같으면 '확인'을 누르세요. 값을 고치면 자동으로 '확인'이 돼요.</div>
    <div class="tablewrap"><table class="edit menus">${head}${menuRows}</table></div>
    ${restIdx.length ? `<details><summary>그 외 메뉴 ${restIdx.length}개 (음료·티 등 — 매장가 근거 없음, 배달가만 확인)</summary>
      <div class="tablewrap"><table class="edit menus">${head}${restRows}</table></div></details>` : ""}
    <div><button class="btn sm" id="addMenu">메뉴 추가</button></div></div>
  <div class="grid2">
    <div class="panel"><div class="panel-head"><h2>혜택 · 이벤트</h2></div><div class="lrows">${listRows("discounts")}</div></div>
    <div class="panel"><div class="panel-head"><h2>주문 옵션 · 좌석</h2></div><div class="lrows">${listRows("options")}</div></div>
  </div>
  <div class="panel"><div class="panel-head"><h2>브랜드 사실</h2>${chip("공식", "ok")}<span class="small muted">대표님이 체험단에 배포한 안내문 (brand-facts.md)</span></div>
    <ul class="points">${(st.brand_facts || []).map((b) => `<li>${esc(b.text)}</li>`).join("")}</ul></div>
  <div class="panel"><div class="field"><label for="sNotes">메모 (AI 분석·초안에 참고로 들어가요)</label><textarea id="sNotes">${esc(st.notes)}</textarea></div>
    <div><button class="btn primary" id="saveNotes">메모 저장</button></div></div>
  ${f ? `<div class="panel"><div class="panel-head"><h2>후기와 매장 정보 대조</h2></div>
    ${f.conflicts.length ? f.conflicts.map((c) => `<div class="note bad small">${esc(c.type)} · ${esc(c.field)}: 매장 정보 <b>${esc(c.store)}</b> / 후기 <b>${esc(c.review)}</b> <a href="${esc(c.ref.url)}" target="_blank" rel="noopener">${esc(refLabel(c.ref))}</a></div>`).join("")
      : `<p class="small muted">'확인'한 가격·영업시간과 다른 후기는 찾지 못했어요. (후기 기준 값은 대조 대상에서 빠져요)</p>`}</div>` : ""}

  <div class="dash-head local-only" style="margin-top:8px"><div><h1>실행 설정</h1></div></div>
  <div class="panel local-only"><div class="panel-head"><h2>주간 실행</h2>${chip(sct.t, sct.cls)}</div>
    <p class="small">${esc(sct.sub)}</p>
    <div class="form-grid">
      <div class="field"><label for="cEn">예약 실행</label><select id="cEn"><option value="1" ${sc.enabled ? "selected" : ""}>켜기</option><option value="0" ${sc.enabled ? "" : "selected"}>끄기</option></select></div>
      <div class="field"><label for="cWd">요일</label><select id="cWd">${WD.map((w, i) => `<option value="${i}" ${i === +sc.weekday ? "selected" : ""}>${w}요일</option>`).join("")}</select></div>
      <div class="field"><label for="cTime">시간</label><input id="cTime" type="time" value="${String(sc.hour).padStart(2, "0")}:${String(sc.minute).padStart(2, "0")}"></div>
    </div>
    <div class="row"><button class="btn primary" id="applySched">예약 적용</button><span class="small muted">이 맥의 launchd에 등록하고, 실제로 등록됐는지 확인해서 위 상태에 보여 줘요</span></div>
    <div class="note small"><b>어떻게 실행되나요?</b><br>
      · 수집·분석은 <b>이 맥북에서</b> 돌아가요. 예약 시각에 맥이 <b>켜져 있고 로그인된 상태</b>여야 해요. 잠자기 중이면 깨어난 뒤 실행되고, 전원이 꺼져 있었다면 그 주는 건너뛰어요('지난 예약 실행 없음'으로 표시).<br>
      · Chrome이나 브라우저 연결, 네이버 로그인은 필요 없어요(로그인 없이 보이는 공개 페이지만 읽어요).<br>
      · AI 분석·초안은 이 맥에 로그인된 <b>Claude Code(claude.ai Pro 구독)</b>로 돌아가요. 따로 API 요금은 없고 Pro 사용량에서 차감돼요.<br>
      · 실행할 때마다 매장 정보도 네이버에서 다시 읽어요(임시 휴무 등). '확인'한 칸은 건드리지 않아요.<br>
      · 아이폰에서 보려면 맥에서 이 앱이 켜져 있고 같은 와이파이여야 해요. 예약 실행 자체는 앱이 꺼져 있어도 돌아요.</div>
  </div>
  <div class="panel local-only"><div class="panel-head"><h2>공유 사이트</h2>${S.share ? chip("배포됨", "ok") : chip("아직 배포 안 함", "gray")}</div>
    ${S.share ? `<p class="small">주소: <a href="${esc(S.share.url)}" target="_blank" rel="noopener">${esc(S.share.url)}</a> · 마지막 갱신 ${dt(S.share.published_at)}</p>` : ""}
    <p class="small muted">대시보드·수집 자료·초안을 읽기 전용으로 올려요. 매주 실행이 끝나면 자동으로 다시 올라가요. 초안을 고친 뒤 바로 반영하려면 아래 버튼을 누르세요. 영수증 리뷰 작성자 닉네임과 접속 키는 올리지 않고, 검색엔진 노출은 막아 둬요.</p>
    <div class="row"><button class="btn primary" id="publishShare">공유 사이트 지금 갱신</button>${S.share ? `<button class="btn sm" id="copyShare">주소 복사</button>` : ""}</div></div>
  <div class="panel local-only"><div class="panel-head"><h2>백업</h2>${S.backup ? chip(S.backup.icloud ? "iCloud Drive" : "이 맥에만", S.backup.icloud ? "ok" : "warn") : chip("아직 없음", "gray")}</div>
    ${S.backup ? `<p class="small">마지막 백업 ${dt(S.backup.at)} · 자료 ${S.backup.counts.items}건 · 분석 ${S.backup.counts.analyses}개 · 초안 ${S.backup.counts.drafts}개 · ${(S.backup.size / 1048576).toFixed(1)}MB</p>
      <p class="small muted">위치: ${esc(S.backup.dir.replace(/^.*CloudDocs/, "iCloud Drive"))} · 최근 ${S.backup.kept}개 보관 (최대 26개)</p>` : ""}
    <p class="small muted">실행이 끝날 때마다 자동으로 백업돼요(하루 1개). 복원하려면 앱을 끄고 백업 파일을 data/studio.db 로 바꿔 넣은 뒤 다시 켜세요.</p>
    <div class="row"><button class="btn" id="runBackup">지금 백업</button></div></div>
  <div class="panel local-only"><div class="panel-head"><h2>수집 · 초안 설정</h2></div>
    <div class="form-grid">
      <div class="field"><label for="cQ">별도 검색어 (줄마다 1개)</label><textarea id="cQ" style="min-height:70px">${esc((s.search_queries || []).join("\n"))}</textarea></div>
      <div class="field"><label for="cFirst">첫 실행 범위 (일)</label><input id="cFirst" type="number" min="1" max="120" value="${s.first_days}"><span class="small muted">이후에는 마지막 성공 수집 이틀 전부터 확인</span></div>
      <div class="field"><label for="cMin">새 자료가 이보다 적으면 최근 30일 자료 함께 사용</label><input id="cMin" type="number" min="0" value="${s.min_new_items}"></div>
    </div>
    <div class="row"><button class="btn" id="saveCollect">설정 저장</button></div>
    <p class="small muted">마지막 성공 — 영수증 ${dt(S.last_ok.place_receipt)} · 플레이스 블로그 ${dt(S.last_ok.place_blog)} · 검색 블로그 ${dt(S.last_ok.search_blog)}</p>
  </div>
  <div class="panel local-only"><div class="panel-head"><h2>실행 기록</h2></div>
    ${S.runs.length ? `<div class="tablewrap"><table class="cmp"><tr><th>시작</th><th>방식</th><th>결과</th><th>새 자료</th><th>확인 기간</th></tr>${S.runs.map((r) =>
      `<tr><td>${dt(r.started_at)}</td><td>${r.trigger === "schedule" ? "예약" : "직접"}</td><td>${chip(...(RUN[r.status] || [r.status, "gray"]))}</td><td>${r.stats?.new_total ?? "—"}</td><td>${esc(r.window_from || "")} ~ ${esc(r.window_to || "")}</td></tr>`).join("")}</table></div>` : `<p class="empty">아직 없어요.</p>`}
  </div>
  ${S.access ? `<div class="panel local-only"><div class="panel-head"><h2>아이폰에서 열기</h2></div>
    <p class="small">아이폰이 이 맥과 <b>같은 와이파이</b>일 때 아래 주소를 사파리로 한 번 열면 이후엔 키 없이 들어가져요. 공유 버튼 → '홈 화면에 추가'로 앱처럼 쓸 수 있어요.</p>
    <div class="row"><code style="overflow-wrap:anywhere">${esc(S.access.lan)}</code><button class="btn sm" id="copyLan">주소 복사</button></div>
    <p class="small muted">주소 끝의 키는 같은 와이파이의 다른 사람이 못 들어오게 막는 용도예요. 공유하지 마세요.</p></div>` : ""}
  </section>`;

  const fit = (t) => { t.style.height = "auto"; t.style.height = `${t.scrollHeight + 2}px`; };
  app.querySelectorAll(".fv textarea, table.menus textarea").forEach((t) => { fit(t); t.addEventListener("input", () => fit(t)); });
  app.querySelectorAll("details").forEach((d) => d.addEventListener("toggle", () => d.querySelectorAll("textarea").forEach(fit)));
  // 기본 정보: 고치면 '확인'
  app.querySelectorAll("[data-basic]").forEach((t) => t.onchange = () => { st[t.dataset.basic] = t.value.trim(); st.status[t.dataset.basic] = "확인"; saveStore("고친 값을 '확인'으로 저장했어요").then(renderStore); });
  app.querySelectorAll("[data-okbasic]").forEach((b) => b.onclick = () => { st.status[b.dataset.okbasic] = "확인"; saveStore("확인했어요").then(renderStore); });
  // 메뉴
  app.querySelectorAll("table.menus [data-m]").forEach((inp) => inp.onchange = () => {
    const m = menus[+inp.closest("tr").dataset.i]; const k = inp.dataset.m; m[k] = inp.value.trim();
    if (k === "price") { m.price_status = m.price ? "확인" : ""; m.price_source = m.price ? "직접 확인" : ""; }
    if (k === "feature") { m.feature_status = "확인"; }
    saveStore("저장했어요 (고친 값은 '확인')").then(renderStore);
  });
  app.querySelectorAll("[data-okprice]").forEach((b) => b.onclick = () => { const m = menus[+b.dataset.okprice]; m.price_status = "확인"; m.price_source = `직접 확인 ${new Date().toLocaleDateString("ko-KR")}`; saveStore(`${m.name} 가격을 확인했어요`).then(renderStore); });
  const okAll = document.getElementById("okAllPrices");
  if (okAll) okAll.onclick = () => { menus.forEach((m) => { if (m.price_status === "후기 기준") { m.price_status = "확인"; m.price_source = `직접 확인 ${new Date().toLocaleDateString("ko-KR")}`; } }); saveStore("모든 후기 기준 가격을 확인했어요").then(renderStore); };
  app.querySelectorAll("[data-delmenu]").forEach((b) => b.onclick = () => { menus.splice(+b.dataset.delmenu, 1); saveStore("삭제했어요").then(renderStore); });
  document.getElementById("addMenu").onclick = () => { menus.push({ name: "", price: "", feature: "" }); renderStore(); };
  app.querySelectorAll("[data-oklist]").forEach((b) => b.onclick = () => { const [k, i] = b.dataset.oklist.split(":"); st[k][+i].status = "확인"; saveStore("확인했어요").then(renderStore); });
  app.querySelectorAll("[data-dellist]").forEach((b) => b.onclick = () => { const [k, i] = b.dataset.dellist.split(":"); st[k].splice(+i, 1); saveStore("삭제했어요").then(renderStore); });
  document.getElementById("saveNotes").onclick = () => { st.notes = document.getElementById("sNotes").value.trim(); saveStore("메모를 저장했어요"); };
  document.getElementById("refill").onclick = async (e) => {
    e.target.disabled = true; e.target.textContent = "불러오는 중…";
    try { const r = await api("/api/store/fill", {}); S.store = r.store; toast("네이버·후기에서 다시 채웠어요 ('확인'한 칸은 그대로)"); } catch (err) { toast(err.message); }
    renderStore();
  };
  document.getElementById("applySched").onclick = async () => {
    const [h, mi] = (val("cTime") || "09:30").split(":");
    const body = { enabled: val("cEn") === "1", weekday: +val("cWd"), hour: +h, minute: +mi, applied_at: new Date().toISOString() };
    try { const r = await api("/api/schedule", body); S.schedule = r; S.settings.schedule = body;
      toast(r.error ? `등록 실패: ${r.error}` : body.enabled ? (r.registered ? "예약을 등록했어요" : "등록이 확인되지 않았어요") : "예약을 껐어요"); renderStore(); }
    catch (e) { toast(e.message); }
  };
  document.getElementById("saveCollect").onclick = () => saveSettings({
    search_queries: document.getElementById("cQ").value.split("\n").map((x) => x.trim()).filter(Boolean),
    first_days: +val("cFirst") || 30, min_new_items: +val("cMin") || 0 });
  const cl = document.getElementById("copyLan"); if (cl) cl.onclick = () => copyText(S.access.lan);
  const rb = document.getElementById("runBackup");
  if (rb) rb.onclick = async () => { try { const r = await api("/api/backup", {}); S.backup = r.backup; toast("백업했어요"); renderStore(); } catch (e) { toast(e.message); } };
  const ps = document.getElementById("publishShare"); if (ps) ps.onclick = () => startJob("/api/share", {}, "공유 사이트에 올리는 중이에요");
  const cs = document.getElementById("copyShare"); if (cs) cs.onclick = () => copyText(S.share.url);
}

/* ---------------- 탭 ---------------- */
function render() {
  document.querySelectorAll("nav.tabs button").forEach((b) => b.setAttribute("aria-current", b.dataset.tab === tab ? "page" : "false"));
  const r = ({ summary: renderSummary, items: renderItems, drafts: renderDrafts, store: renderStore })[tab]();
  renderJob();
  if (SHARE) Promise.resolve(r).then(lockDown);
}
function lockDown() {
  app.querySelectorAll("textarea, input").forEach((e) => { e.readOnly = true; if (e.type === "file") e.disabled = true; });
  app.querySelectorAll("select").forEach((e) => { if (!e.closest(".filters")) e.disabled = true; });
  app.querySelectorAll(".filters input").forEach((e) => { e.readOnly = false; });
  app.querySelectorAll("button, label.btn").forEach((b) => {
    if (!b.matches("[data-go], [data-copy-body], [data-copy-title], [data-copy-old], .kpi")) b.hidden = true;
  });
}
async function go(t, opts = {}) {
  await flushSaves();
  tab = t; if (opts.filter) { filt.rel = opts.filter; }
  try { history.replaceState(null, "", `#${t}`); } catch {}
  render(); window.scrollTo(0, 0);
}
document.querySelectorAll("nav.tabs button").forEach((b) => b.onclick = () => go(b.dataset.tab));
app.addEventListener("click", (e) => { const g = e.target.closest("[data-go]"); if (g) go(g.dataset.go, { filter: g.dataset.filter }); });

(async function init() {
  if (SHARE) {
    document.body.classList.add("share");
    document.getElementById("runBtn").hidden = true;
  }
  const h = location.hash.slice(1); if (["summary", "items", "drafts", "store"].includes(h)) tab = h;
  try { S = await api("/api/state"); }
  catch (e) { app.innerHTML = `<div class="panel"><h2>연결할 수 없어요</h2><p>${esc(e.message)}</p><p class="small muted">맥에서 서버가 켜져 있는지 확인해 주세요.</p></div>`; return; }
  if (SHARE) document.querySelector(".brand span").textContent = `읽기 전용 공유본 · ${dt(SHARED.built_at)} 기준`;
  render();
  if (S.job.running && !SHARE) poll();
})();
