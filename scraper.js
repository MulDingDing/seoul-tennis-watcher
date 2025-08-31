// scraper.js — 렌더링된 달력에서 "선택 가능 날짜" 수집 + 디버그/스크린샷/견고한 예외처리
import { chromium } from "playwright";
import fs from "fs/promises";

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID   = process.env.CHAT_ID;
const DEBUG_NOTIFY = (process.env.DEBUG_NOTIFY || "true").toLowerCase() === "true";

// 모니터링할 페이지들 — 필요시 추가
const URLS = [
  "https://yeyak.seoul.go.kr/web/reservation/selectReservView.do?rsv_svc_id=S250813165159850005"
];

// 스캔 설정
const SCAN_MONTHS_AHEAD = 2;   // 현재 달 포함 n개월 앞으로
const WAIT_MS = 1200;
const TZ = "Asia/Seoul";

// 판정 패턴
const NEG_CLASSES = /(disabled|disable|dim|off|blocked|soldout|unavailable|closed|end|finish|over|unselectable)/i;
const NEG_TEXT    = /(예약\s*마감|예약마감|접수마감|마감되었습니다|마감\b|불가\b|대기\b|sold\s*out|unavailable|불가능)/i;

// 다음달 버튼 후보
const NEXT_SELECTORS = [
  '[aria-label*="다음"]',
  "button.next","a.next",".next",".nextMonth",".ui-datepicker-next",".cal_next",
  'a[onclick*="next"]','button[onclick*="next"]'
];

// 달력/컨텐트가 준비됐는지 대기할 때 쓸 후보 셀렉터
const CALENDAR_HINTS = [
  "[data-date]", "td[data-date]", ".calendar", ".ui-datepicker-calendar", ".cal_tbl"
];

// 팝업/동의/탭 전환 시도용(있을 때만 눌러봄)
const DISMISSORS = [
  'button:has-text("확인")', 'button:has-text("동의")', 'button:has-text("닫기")',
  'a:has-text("확인")', 'a:has-text("동의")', 'a:has-text("닫기")',
  '.btn_confirm', '.btn_ok', '.btn_close'
];

function dow(ymd) {
  const [y,m,d] = ymd.split("-").map(Number);
  return new Date(y, m-1, d).toLocaleDateString("ko-KR", { weekday: "short", timeZone: TZ });
}
function summarizeDates(dates) {
  return dates.sort().map(d => `• ${d} (${dow(d)})`).join("\n");
}
async function sendTelegram(text) {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log("[WARN] Missing BOT_TOKEN or CHAT_ID");
    return;
  }
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type":"application/json" },
      body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true })
    });
  } catch (e) {
    console.log("[WARN] sendTelegram failed:", e);
  }
}
function unique(arr){ return Array.from(new Set(arr)); }

// 잠깐 기다리기
const nap = (ms)=> new Promise(r=> setTimeout(r, ms));

async function waitForCalendar(page) {
  for (const sel of CALENDAR_HINTS) {
    try {
      const el = await page.waitForSelector(sel, { timeout: 3000 });
      if (el) return true;
    } catch(_) {}
  }
  return false;
}

async function dismissPopups(page) {
  // 동의/확인/닫기 비동기 시도
  for (const sel of DISMISSORS) {
    try {
      const el = await page.$(sel);
      if (el && await el.isVisible()) {
        await el.click().catch(()=>{});
        await nap(400);
      }
    } catch(_) {}
  }
}

async function grabSelectableDates(page) {
  const dates = await page.evaluate(({ NEG_CLASSES, NEG_TEXT }) => {
    function isClickable(el){
      const hasAnchor = el.matches?.('a,button,input[type="button"],[role="button"]') || !!el.querySelector?.('a,button,input[type="button"],[role="button"]');
      const hasOnclick = el.getAttribute?.("onclick");
      const hasHrefJs = el.querySelector?.('a[href^="javascript:"]');
      const ariaEnabled = el.getAttribute?.("aria-disabled") !== "true";
      const notDisabledAttr = el.getAttribute?.("disabled") == null;
      const cls = (el.className || "") + " " + (el.getAttribute?.("class") || "");
      const notDisabledClass = !(new RegExp(NEG_CLASSES)).test(cls);
      const txt = (el.textContent || "");
      const notNegText = !(new RegExp(NEG_TEXT)).test(txt);
      return (hasAnchor || hasOnclick || hasHrefJs) && ariaEnabled && notDisabledAttr && notDisabledClass && notNegText;
    }
    const set = new Set();
    const nodes = Array.from(document.querySelectorAll("[data-date], td[data-date], [data-day]"));
    for (const cell of nodes){
      const ymd = (cell.getAttribute("data-date") || cell.getAttribute("data-day") || "").trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) continue;
      if (isClickable(cell)) { set.add(ymd); continue; }
      const btn = cell.querySelector('a,button,input[type="button"],[role="button"]');
      if (btn && isClickable(btn)) { set.add(ymd); continue; }
      const cls = (cell.className || "") + " " + (cell.getAttribute("class") || "");
      if (!/(disabled|soldout|unavailable|off|dim)/i.test(cls)) {
        const ariaSel = cell.getAttribute("aria-selected");
        const txt = (cell.textContent || "").replace(/\s+/g,"");
        const hasDayNum = /\b([1-9]|[12]\d|3[01])\b/.test(txt);
        if (hasDayNum && ariaSel !== "true") set.add(ymd);
      }
    }
    return Array.from(set);
  }, { NEG_CLASSES: NEG_CLASSES.source, NEG_TEXT: NEG_TEXT.source });

  return unique(dates);
}

async function clickNextMonth(page){
  for (const sel of NEXT_SELECTORS){
    try {
      const el = await page.$(sel);
      if (!el) continue;
      if (await el.isEnabled()) {
        await el.click();
        return true;
      }
    } catch(_) {}
  }
  const candidates = await page.$$('a,button');
  for (const c of candidates){
    const t = (await c.textContent() || "").trim();
    if (/다음|next|▶|≫/i.test(t)) {
      try { if (await c.isEnabled()){ await c.click(); return true; } } catch(_){}
    }
  }
  return false;
}

async function scanOne(url, idx){
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ timezoneId: TZ, locale: "ko-KR" });
  const page = await context.newPage();

  try{
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await nap(WAIT_MS);
    await dismissPopups(page);                // 1) 팝업/동의 닫기
    await waitForCalendar(page);              // 2) 달력 힌트 대기
    await page.screenshot({ path: `out/month0_${idx}.png`, fullPage: true });

    let all = await grabSelectableDates(page);

    for (let i=0;i<SCAN_MONTHS_AHEAD;i++){
      const moved = await clickNextMonth(page);
      if (!moved) break;
      await nap(WAIT_MS);
      await waitForCalendar(page);
      await dismissPopups(page);
      await page.screenshot({ path: `out/month${i+1}_${idx}.png`, fullPage: true });
      const more = await grabSelectableDates(page);
      all = unique(all.concat(more));
    }
    return all.sort();
  } finally {
    await browser.close();
  }
}

async function main(){
  try { await fs.mkdir("logs", { recursive: true }); } catch(_) {}
  try { await fs.mkdir("out",  { recursive: true }); } catch(_) {}

  await sendTelegram("🟢 시작: 테니스 예약 감시 실행");

  const summaries = [];
  for (let i=0;i<URLS.length;i++){
    const url = URLS[i];
    try {
      const dates = await scanOne(url, i);
      if (dates.length > 0) {
        summaries.push(`🎾 <b>예약 가능 날짜</b>\n${summarizeDates(dates)}\n🔗 ${url}`);
      } else if (DEBUG_NOTIFY) {
        await sendTelegram(`ℹ️ 현재 예약 가능 날짜 0건\n🔗 ${url}`);
      }
    } catch (e) {
      const msg = `⚠️ URL 처리 중 오류\n${url}\n${String(e).slice(0,500)}`;
      console.error(msg);
      await fs.writeFile(`logs/error_${Date.now()}_${i}.txt`, msg).catch(()=>{});
      await sendTelegram(msg);
    }
  }

  if (summaries.length > 0) {
    const final = summaries.join("\n\n") + `\n\n⏰ ${new Date().toLocaleString("ko-KR",{ timeZone: TZ })}`;
    await sendTelegram(final);
  } else if (DEBUG_NOTIFY) {
    await sendTelegram("📭 모든 대상에서 현재 예약 가능 날짜 없음");
  }
}

// 메인 실행: 실패해도 프로세스는 0으로 종료하여 아티팩트 업로드 보장
(async () => {
  try {
    await main();
  } catch (e) {
    const msg = `💥 치명적 오류: ${String(e).slice(0,900)}`;
    console.error(msg);
    try { await fs.writeFile(`logs/fatal_${Date.now()}.txt`, msg); } catch(_){}
    await sendTelegram(msg);
  } finally {
    process.exit(0);
  }
})();
