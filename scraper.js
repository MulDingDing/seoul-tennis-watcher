// scraper.js — 렌더링된 달력에서 "선택 가능 날짜"를 수집해 텔레그램으로 전송
import { chromium } from "playwright";

// ▼ 텔레그램 정보: GitHub Secrets가 있으면 자동으로 그 값을 씁니다(하드코딩은 하지 마세요!)
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID   = process.env.CHAT_ID;

// 모니터링할 페이지들 (원하는 주소 계속 추가)
const URLS = [
  "https://yeyak.seoul.go.kr/web/reservation/selectReservView.do?rsv_svc_id=S250813165159850005"
];

// 설정
const SCAN_MONTHS_AHEAD = 2;          // 현재 달 포함 다음 몇 달까지 넘겨볼지
const WAIT_MS = 1200;                  // 페이지 이동/렌더 대기(ms)
const TZ = "Asia/Seoul";

// “비활성/마감” 신호
const NEG_CLASSES = /(disabled|disable|dim|off|blocked|soldout|unavailable|closed|end|finish|over|unselectable)/i;
const NEG_TEXT    = /(예약\s*마감|예약마감|접수마감|마감되었습니다|마감\b|불가\b|대기\b|sold\s*out|unavailable|불가능)/i;

const NEXT_SELECTORS = [
  '[aria-label*="다음"]',
  "button.next","a.next",".next",".nextMonth",".ui-datepicker-next",".cal_next",
  'a[onclick*="next"]','button[onclick*="next"]'
];

function dow(ymd) {
  const [y,m,d] = ymd.split("-").map(Number);
  return new Date(y, m-1, d).toLocaleDateString("ko-KR", { weekday: "short", timeZone: TZ });
}
function summarizeDates(dates) {
  return dates.sort().map(d => `• ${d} (${dow(d)})`).join("\n");
}
async function sendTelegram(text) {
  if (!BOT_TOKEN || !CHAT_ID) throw new Error("BOT_TOKEN/CHAT_ID env missing");
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "content-type":"application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true })
  });
}
function unique(arr){ return Array.from(new Set(arr)); }

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

async function scanOne(url){
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ timezoneId: TZ, locale: "ko-KR" });
  const page = await context.newPage();

  try{
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(WAIT_MS);

    let all = await grabSelectableDates(page);

    for (let i=0;i<SCAN_MONTHS_AHEAD;i++){
      const moved = await clickNextMonth(page);
      if (!moved) break;
      await page.waitForTimeout(WAIT_MS);
      const more = await grabSelectableDates(page);
      all = unique(all.concat(more));
    }
    return all.sort();
  } finally {
    await browser.close();
  }
}

async function main(){
  let blocks = [];
  for (const url of URLS){
    const dates = await scanOne(url);
    if (dates.length === 0) continue;
    const summary = summarizeDates(dates);
    blocks.push(`🎾 <b>예약 가능 날짜</b>\n${summary}\n🔗 ${url}`);
  }
  if (blocks.length > 0){
    const msg = blocks.join("\n\n") + `\n\n⏰ ${new Date().toLocaleString("ko-KR",{ timeZone: TZ })}`;
    await sendTelegram(msg);
  }
}

main().catch(async (e)=>{
  try { await sendTelegram(`⚠️ 스크립트 오류: ${String(e).slice(0,900)}`); } catch (_) {}
  process.exit(1);
});
