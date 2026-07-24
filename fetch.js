/**
 * FX Daily Data Fetcher v2
 * 毎朝8:30 JST（GitHub Actions）に実行される想定。
 * - Twelve Data: 7ペアの日足OHLC → ADR20 / ATR14 / 前日高安 / Pivot(R2/R1/P/S1/S2) / NY終値
 * - Yahoo Finance: DXY / 米10年債利回り / VIX
 * - Forex Factory: 当日の経済指標・要人発言（JST変換済み）
 * 出力:
 *   data/YYYY-MM-DD.json, data/latest.json, data/index.json  … ダッシュボード用（従来通り）
 *   data/daily-levels.json      … GPT等の外部AI用（機械可読スキーマ）
 *   data/economic-calendar.json … GPT等の外部AI用（当日イベント）
 */

const fs = require("fs");
const path = require("path");

const API_KEY = process.env.TWELVE_DATA_API_KEY;
if (!API_KEY) {
  console.error("ERROR: 環境変数 TWELVE_DATA_API_KEY が設定されていません");
  process.exit(1);
}

// ---- 対象ペア ----
const PAIRS = [
  { code: "USDJPY", td: "USD/JPY", pip: 0.01,   digits: 3 },
  { code: "EURUSD", td: "EUR/USD", pip: 0.0001, digits: 5 },
  { code: "GBPUSD", td: "GBP/USD", pip: 0.0001, digits: 5 },
  { code: "EURJPY", td: "EUR/JPY", pip: 0.01,   digits: 3 },
  { code: "AUDUSD", td: "AUD/USD", pip: 0.0001, digits: 5 },
  { code: "EURGBP", td: "EUR/GBP", pip: 0.0001, digits: 5 },
  { code: "USDCAD", td: "USD/CAD", pip: 0.0001, digits: 5 },
  { code: "USDCHF", td: "USD/CHF", pip: 0.0001, digits: 5 },
  { code: "NZDUSD", td: "NZD/USD", pip: 0.0001, digits: 5 },
  { code: "AUDNZD", td: "AUD/NZD", pip: 0.0001, digits: 5 },
  { code: "XAUUSD", td: "XAU/USD", pip: 0.1,    digits: 2 }, // 0.1ドル=1pip
];

// ---- 市場心理（Yahoo Finance 非公式API）----
const SENTIMENT = [
  { code: "DXY",   symbol: "DX-Y.NYB", label: "ドル指数", divisor: 1,  digits: 2 },
  { code: "US2Y",  symbol: "custom",   label: "米2年債利回り", divisor: 1,  digits: 3 }, // fetchUS2Yで特別処理
  { code: "US10Y", symbol: "^TNX",     label: "米10年債利回り", divisor: 10, digits: 3 },
  { code: "VIX",   symbol: "^VIX",     label: "VIX", divisor: 1,  digits: 2 },
];

// ---- 経済指標カレンダー設定 ----
const FF_CALENDAR_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
const CAL_CURRENCIES = ["USD", "JPY", "EUR", "GBP", "AUD", "NZD", "CAD", "CHF", "CNY"]; // 対象通貨
const CAL_IMPACTS = ["High", "Medium"]; // 対象重要度

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (n, d) => Number(n.toFixed(d));

// ---- 日付ユーティリティ ----
function lastCompletedSessionDate(now = new Date()) {
  const nyStr = now.toLocaleString("en-US", { timeZone: "America/New_York" });
  const ny = new Date(nyStr);
  let d = new Date(ny);
  if (ny.getHours() < 17) d.setDate(d.getDate() - 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
  return fmtDateLocal(d);
}

function fmtDateLocal(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function jstToday(now = new Date()) {
  const jst = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
  return fmtDateLocal(jst);
}

// JSTのISO文字列（例: 2026-07-15T08:30:00+09:00）
function jstIso(now = new Date()) {
  const s = now.toLocaleString("sv-SE", { timeZone: "Asia/Tokyo" });
  return s.replace(" ", "T") + "+09:00";
}

// ---- 指標計算 ----
function computeIndicators(bars) {
  if (bars.length < 21) {
    throw new Error(`確定足が不足しています（${bars.length}本、最低21本必要）`);
  }
  const prev = bars[0];
  const adr20 =
    bars.slice(0, 20).reduce((s, b) => s + (b.high - b.low), 0) / 20;

  const asc = [...bars].reverse();
  const trs = [];
  for (let i = 1; i < asc.length; i++) {
    const h = asc[i].high, l = asc[i].low, pc = asc[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const period = 14;
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }

  const P = (prev.high + prev.low + prev.close) / 3;
  const range = prev.high - prev.low;
  return {
    sessionDate: prev.date,
    prevHigh: prev.high,
    prevLow: prev.low,
    prevClose: prev.close,
    adr20,
    atr14: atr,
    pivot: P,
    r1: 2 * P - prev.low,
    s1: 2 * P - prev.high,
    r2: P + range,
    s2: P - range,
  };
}

// ---- Twelve Data から日足を構築（1時間足→NY17:00区切りで自前集計）----
// 理由: Twelve Dataの1day足はtimezone指定が無視され取引所ローカル時間(FX=Australia/Sydney)
// 区切りになるため、NY17:00クローズの日足は1時間足(timezone有効)から集計する。
// 1時間足のtimestampはバーの開始時刻。NY時間に+7hすると 17:00以降のバーが翌セッション日に入る。
function aggregateToNySessions(hourBarsAsc) {
  const sessions = new Map(); // sessionDate -> {open,high,low,close}
  for (const b of hourBarsAsc) {
    const dt = new Date(b.datetime.replace(" ", "T")); // NY表記のローカル時刻として解釈
    const shifted = new Date(dt.getTime() + 7 * 3600000);
    const sd = fmtDateLocal(shifted);
    const dow = shifted.getDay();
    if (dow === 0 || dow === 6) continue; // 土日セッションは存在しない(混入分は除外)
    if (!sessions.has(sd)) {
      sessions.set(sd, { date: sd, open: b.open, high: b.high, low: b.low, close: b.close, bars: 1 });
    } else {
      const s = sessions.get(sd);
      s.high = Math.max(s.high, b.high);
      s.low = Math.min(s.low, b.low);
      s.close = b.close; // 昇順処理なので最後のバーのcloseが残る
      s.bars += 1;
    }
  }
  return [...sessions.values()].sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchPairBars(tdSymbol, cutoffDate) {
  const url =
    `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(tdSymbol)}` +
    `&interval=1h&outputsize=1500&timezone=America/New_York&apikey=${API_KEY}`;
  const res = await fetch(url);
  const json = await res.json();
  if (json.status === "error" || !json.values) {
    throw new Error(`Twelve Data エラー (${tdSymbol}): ${json.message || "no data"}`);
  }
  const hoursAsc = json.values
    .map((v) => ({
      datetime: v.datetime,
      open: parseFloat(v.open),
      high: parseFloat(v.high),
      low: parseFloat(v.low),
      close: parseFloat(v.close),
    }))
    .reverse(); // APIは新しい順 → 昇順へ
  const daily = aggregateToNySessions(hoursAsc)
    .filter((b) => b.date <= cutoffDate)
    .filter((b) => b.bars >= 6); // 極端に欠けたセッション(祝日の断片等)を除外
  return daily.reverse(); // computeIndicatorsは新しい順を期待
}

// ---- Yahoo Finance から指数取得 ----
async function fetchYahoo(item) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(item.symbol)}?range=10d&interval=1d`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
  });
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status} (${item.symbol})`);
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo データなし (${item.symbol})`);
  const closes = (result.indicators?.quote?.[0]?.close || []).filter(
    (c) => c !== null && c !== undefined
  );
  if (closes.length < 2) throw new Error(`Yahoo 終値不足 (${item.symbol})`);
  let value = closes[closes.length - 1] / item.divisor;
  let prev = closes[closes.length - 2] / item.divisor;
  // 米10年債のスケール自動補正（どちらの表記で来ても4.59%になる）
  if (item.code === "US10Y" && value < 1) { value *= 10; prev *= 10; }
  return {
    label: item.label,
    value: round(value, item.digits),
    prev: round(prev, item.digits),
    change: round(value - prev, item.digits),
    changePct: round(((value - prev) / prev) * 100, 2),
  };
}

// ---- 米2年債利回り（Yahoo 2YY=F → 失敗時はFRED DGS2に自動フォールバック）----
async function fetchUS2Y() {
  // 第1候補: Yahoo 2YY=F（CME 2年利回り先物・ほぼリアルタイム）
  try {
    const res = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/2YY%3DF?range=10d&interval=1d", {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
    });
    if (res.ok) {
      const json = await res.json();
      const closes = (json?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [])
        .filter((c) => c !== null && c !== undefined);
      if (closes.length >= 2) {
        const value = closes[closes.length - 1];
        const prev = closes[closes.length - 2];
        if (value > 0.05 && value < 20 && prev > 0.05 && prev < 20) { // 妥当範囲チェック
          return {
            label: "米2年債利回り",
            value: Number(value.toFixed(3)),
            prev: Number(prev.toFixed(3)),
            change: Number((value - prev).toFixed(3)),
            changePct: Number((((value - prev) / prev) * 100).toFixed(2)),
            source: "yahoo:2YY=F",
          };
        }
      }
    }
  } catch (e) { /* フォールバックへ */ }

  // 第2候補: FRED公式 DGS2（1営業日遅れ・確実）
  const res2 = await fetch("https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS2", {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
  });
  if (!res2.ok) throw new Error(`FRED HTTP ${res2.status}`);
  const csv = await res2.text();
  const vals = csv.trim().split("\n").slice(1)
    .map((l) => parseFloat(l.split(",")[1]))
    .filter((v) => !isNaN(v));
  if (vals.length < 2) throw new Error("FRED DGS2 データ不足");
  const value = vals[vals.length - 1], prev = vals[vals.length - 2];
  return {
    label: "米2年債利回り",
    value: Number(value.toFixed(3)),
    prev: Number(prev.toFixed(3)),
    change: Number((value - prev).toFixed(3)),
    changePct: Number((((value - prev) / prev) * 100).toFixed(2)),
    source: "fred:DGS2(前営業日値)",
  };
}


// ---- Forex Factory カレンダー取得（当日JST分を抽出）----
async function fetchCalendar(todayJst) {
  const res = await fetch(FF_CALENDAR_URL, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
  });
  if (!res.ok) throw new Error(`Forex Factory HTTP ${res.status}`);
  const events = await res.json();
  const out = [];
  for (const e of events) {
    if (!CAL_CURRENCIES.includes(e.country)) continue;
    if (!CAL_IMPACTS.includes(e.impact)) continue;
    const dt = new Date(e.date); // ISO with offset
    if (isNaN(dt.getTime())) continue;
    const jstDate = fmtDateLocal(new Date(dt.toLocaleString("en-US", { timeZone: "Asia/Tokyo" })));
    if (jstDate !== todayJst) continue;
    const jstTime = dt.toLocaleTimeString("ja-JP", {
      timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hour12: false,
    });
    out.push({
      time_jst: jstTime,
      datetime_jst: jstIso(dt),
      currency: e.country,
      impact: e.impact,           // High / Medium
      event: e.title,
      forecast: e.forecast || null,
      previous: e.previous || null,
      scheduled_time_passed: dt.getTime() <= Date.now(), // 発表予定時刻を過ぎたか（事実）
    });
  }
  out.sort((a, b) => a.time_jst.localeCompare(b.time_jst));
  return out;
}

// ---- メイン ----
async function main() {
  const now = new Date();
  const cutoff = lastCompletedSessionDate(now);
  const today = jstToday(now);
  console.log(`実行日(JST): ${today} / 確定セッション: ${cutoff}`);

  const out = {
    date: today,
    generatedAt: now.toISOString(),
    sessionDate: cutoff,
    pairs: {},
    sentiment: {},
    errors: [],
  };

  for (const p of PAIRS) {
    try {
      const bars = await fetchPairBars(p.td, cutoff);
      const ind = computeIndicators(bars);
      out.pairs[p.code] = {
        sessionDate: ind.sessionDate,
        prevHigh: round(ind.prevHigh, p.digits),
        prevLow: round(ind.prevLow, p.digits),
        prevClose: round(ind.prevClose, p.digits),
        adr20: round(ind.adr20, p.digits),
        atr14: round(ind.atr14, p.digits),
        pivot: round(ind.pivot, p.digits),
        r1: round(ind.r1, p.digits),
        s1: round(ind.s1, p.digits),
        r2: round(ind.r2, p.digits),
        s2: round(ind.s2, p.digits),
        adr20Pips: p.pip ? Math.round(ind.adr20 / p.pip) : null,
        atr14Pips: p.pip ? Math.round(ind.atr14 / p.pip) : null,
      };
      console.log(`OK: ${p.code} (session=${ind.sessionDate})`);
    } catch (e) {
      console.error(`FAIL: ${p.code} - ${e.message}`);
      out.errors.push(`${p.code}: ${e.message}`);
    }
    await sleep(1500);
  }

  for (const s of SENTIMENT) {
    try {
      out.sentiment[s.code] = s.code === "US2Y" ? await fetchUS2Y() : await fetchYahoo(s);
      console.log(`OK: ${s.code}`);
    } catch (e) {
      console.error(`FAIL: ${s.code} - ${e.message}`);
      out.errors.push(`${s.code}: ${e.message}`);
      out.sentiment[s.code] = null;
    }
    await sleep(500);
  }

  // 経済指標カレンダー（GPT用）
  let calendar = [];
  try {
    calendar = await fetchCalendar(today);
    console.log(`OK: カレンダー ${calendar.length}件`);
  } catch (e) {
    console.error(`FAIL: カレンダー - ${e.message}`);
    out.errors.push(`calendar: ${e.message}`);
  }

  // ---- 保存 ----
  const dataDir = path.join(__dirname, "data");
  fs.mkdirSync(dataDir, { recursive: true });

  // 1) ダッシュボード用（従来通り）
  fs.writeFileSync(path.join(dataDir, `${today}.json`), JSON.stringify(out, null, 2));
  fs.writeFileSync(path.join(dataDir, "latest.json"), JSON.stringify(out, null, 2));

  const indexPath = path.join(dataDir, "index.json");
  let dates = [];
  if (fs.existsSync(indexPath)) {
    try { dates = JSON.parse(fs.readFileSync(indexPath, "utf8")).dates || []; } catch {}
  }
  if (!dates.includes(today)) dates.unshift(today);
  dates.sort().reverse();
  fs.writeFileSync(indexPath, JSON.stringify({ dates }, null, 2));

  // 2) GPT用 daily-levels.json
  const s = (c) => out.sentiment[c];
  const dailyLevels = {
    as_of: jstIso(now),
    timezone: "Asia/Tokyo",
    session_date: cutoff,
    market_sentiment: {
      dxy: s("DXY")?.value ?? null,
      dxy_change_pct: s("DXY")?.changePct ?? null,
      us2y: s("US2Y")?.value ?? null,
      us2y_change: s("US2Y")?.change ?? null,
      us10y: s("US10Y")?.value ?? null,
      us10y_change: s("US10Y")?.change ?? null,
      vix: s("VIX")?.value ?? null,
      vix_change_pct: s("VIX")?.changePct ?? null,
    },
    pairs: {},
  };
  for (const p of PAIRS) {
    const d = out.pairs[p.code];
    if (!d) continue;
    dailyLevels.pairs[p.code] = {
      prev_high: d.prevHigh,
      prev_low: d.prevLow,
      prev_close_ny: d.prevClose,
      adr20: d.adr20,
      adr20_pips: d.adr20Pips,
      atr14: d.atr14,
      atr14_pips: d.atr14Pips,
      atr_sl_1_0: round(d.atr14 * 1.0, p.digits), // SL目安レンジ（事実値: ATR×1.0〜1.5）
      atr_sl_1_5: round(d.atr14 * 1.5, p.digits),
      // 前日値幅 ÷ ADR20（%）: 前日にADRをどれだけ使ったか
      previous_day_range_pct: d.adr20 > 0 ? round(((d.prevHigh - d.prevLow) / d.adr20) * 100, 1) : null,
      pivot: d.pivot,
      r1: d.r1, r2: d.r2,
      s1: d.s1, s2: d.s2,
    };
  }
  fs.writeFileSync(path.join(dataDir, "daily-levels.json"), JSON.stringify(dailyLevels, null, 2));

  // 3) GPT用 economic-calendar.json
  fs.writeFileSync(path.join(dataDir, "economic-calendar.json"), JSON.stringify({
    as_of: jstIso(now),
    date: today,
    timezone: "Asia/Tokyo",
    source: "Forex Factory calendar feed",
    actuals_note: "本フィードのデータ源(FF公開フィード)は実績値(actual)を含まない。scheduled_time_passed=trueのイベントの実績値は別ソースで確認すること。",
    filters: { currencies: CAL_CURRENCIES, impacts: CAL_IMPACTS },
    events: calendar,
  }, null, 2));

  console.log(`保存完了: latest.json / daily-levels.json / economic-calendar.json`);
  if (out.errors.length > 0) {
    console.warn(`警告: ${out.errors.length}件の取得エラーあり（部分的に保存済み）`);
  }
  if (Object.keys(out.pairs).length === 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
