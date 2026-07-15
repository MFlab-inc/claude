/**
 * FX Daily Data Fetcher
 * 毎朝8:30 JST（GitHub Actions）に実行される想定。
 * - Twelve Data: 7ペアの日足OHLC → ADR20 / ATR14 / 前日高安 / Pivot / NY終値を計算
 * - Yahoo Finance: DXY / 米10年債利回り / VIX
 * 結果を data/YYYY-MM-DD.json（JST日付）+ data/latest.json + data/index.json に保存
 */

const fs = require("fs");
const path = require("path");

const API_KEY = process.env.TWELVE_DATA_API_KEY;
if (!API_KEY) {
  console.error("ERROR: 環境変数 TWELVE_DATA_API_KEY が設定されていません");
  process.exit(1);
}

// ---- 対象ペア（pip: 1pipの値, digits: 表示桁数）----
const PAIRS = [
  { code: "USDJPY", td: "USD/JPY", pip: 0.01,   digits: 3 },
  { code: "EURUSD", td: "EUR/USD", pip: 0.0001, digits: 5 },
  { code: "GBPUSD", td: "GBP/USD", pip: 0.0001, digits: 5 },
  { code: "EURJPY", td: "EUR/JPY", pip: 0.01,   digits: 3 },
  { code: "AUDUSD", td: "AUD/USD", pip: 0.0001, digits: 5 },
  { code: "EURGBP", td: "EUR/GBP", pip: 0.0001, digits: 5 },
  { code: "XAUUSD", td: "XAU/USD", pip: null,   digits: 2 }, // ゴールドはpip表記なし（ドル建て）
];

// ---- 市場心理（Yahoo Finance 非公式API）----
const SENTIMENT = [
  { code: "DXY",   symbol: "DX-Y.NYB", label: "ドル指数", divisor: 1,  digits: 2 },
  { code: "US10Y", symbol: "^TNX",     label: "米10年債利回り", divisor: 10, digits: 3 }, // ^TNXは利回り×10で返る
  { code: "VIX",   symbol: "^VIX",     label: "VIX", divisor: 1,  digits: 2 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 日付ユーティリティ ----
// NY時間の「直近で確定した日足セッションの日付」を求める。
// FX日足はNY17:00クローズ。17:00以降なら当日が確定済み、それ以前なら前営業日。土日はスキップ。
function lastCompletedSessionDate(now = new Date()) {
  const nyStr = now.toLocaleString("en-US", { timeZone: "America/New_York" });
  const ny = new Date(nyStr);
  let d = new Date(ny);
  if (ny.getHours() < 17) d.setDate(d.getDate() - 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1); // Sun=0, Sat=6
  return d.toISOString ? fmtDateLocal(d) : null;
}

function fmtDateLocal(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// JSTの今日の日付（保存ファイル名に使用）
function jstToday(now = new Date()) {
  const jst = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
  return fmtDateLocal(jst);
}

// ---- 指標計算 ----
// bars: 新しい順 [{date, open, high, low, close}, ...] すべて確定足
function computeIndicators(bars) {
  if (bars.length < 21) {
    throw new Error(`確定足が不足しています（${bars.length}本、最低21本必要）`);
  }
  const prev = bars[0]; // 直近確定足 = 「前日」

  // ADR(20): 直近20日の (H - L) 単純平均
  const adr20 =
    bars.slice(0, 20).reduce((s, b) => s + (b.high - b.low), 0) / 20;

  // ATR(14): Wilder平滑化（TradingViewのRMAと同方式）
  // 古い順に並べ替えて計算
  const asc = [...bars].reverse();
  const trs = [];
  for (let i = 1; i < asc.length; i++) {
    const h = asc[i].high, l = asc[i].low, pc = asc[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const period = 14;
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period; // 初期値=SMA
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period; // Wilder RMA
  }

  // Pivot（クラシック方式）
  const P = (prev.high + prev.low + prev.close) / 3;
  const r1 = 2 * P - prev.low;
  const s1 = 2 * P - prev.high;

  return {
    sessionDate: prev.date,
    prevHigh: prev.high,
    prevLow: prev.low,
    prevClose: prev.close, // 前日NY終値
    adr20,
    atr14: atr,
    pivot: P,
    r1,
    s1,
  };
}

// ---- Twelve Data から日足取得 ----
async function fetchPairBars(tdSymbol, cutoffDate) {
  const url =
    `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(tdSymbol)}` +
    `&interval=1day&outputsize=45&timezone=America/New_York&apikey=${API_KEY}`;
  const res = await fetch(url);
  const json = await res.json();
  if (json.status === "error" || !json.values) {
    throw new Error(`Twelve Data エラー (${tdSymbol}): ${json.message || "no data"}`);
  }
  // 新しい順で返る。確定足のみ（cutoffDate以前）に絞る
  const bars = json.values
    .map((v) => ({
      date: v.datetime.slice(0, 10),
      open: parseFloat(v.open),
      high: parseFloat(v.high),
      low: parseFloat(v.low),
      close: parseFloat(v.close),
    }))
    .filter((b) => b.date <= cutoffDate);
  return bars;
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

const round = (n, d) => Number(n.toFixed(d));

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

  // 7ペア（無料枠 8req/分 のため1.5秒間隔で順次取得）
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

  // 市場心理3種
  for (const s of SENTIMENT) {
    try {
      out.sentiment[s.code] = await fetchYahoo(s);
      console.log(`OK: ${s.code}`);
    } catch (e) {
      console.error(`FAIL: ${s.code} - ${e.message}`);
      out.errors.push(`${s.code}: ${e.message}`);
      out.sentiment[s.code] = null;
    }
    await sleep(500);
  }

  // 保存
  const dataDir = path.join(__dirname, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, `${today}.json`), JSON.stringify(out, null, 2));
  fs.writeFileSync(path.join(dataDir, "latest.json"), JSON.stringify(out, null, 2));

  // index.json（日付一覧、新しい順）を更新
  const indexPath = path.join(dataDir, "index.json");
  let dates = [];
  if (fs.existsSync(indexPath)) {
    try { dates = JSON.parse(fs.readFileSync(indexPath, "utf8")).dates || []; } catch {}
  }
  if (!dates.includes(today)) dates.unshift(today);
  dates.sort().reverse();
  fs.writeFileSync(indexPath, JSON.stringify({ dates }, null, 2));

  console.log(`保存完了: data/${today}.json`);
  if (out.errors.length > 0) {
    console.warn(`警告: ${out.errors.length}件の取得エラーあり（部分的に保存済み）`);
  }
  // 全ペア失敗時のみ異常終了（Actionsの失敗通知が飛ぶ）
  if (Object.keys(out.pairs).length === 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
