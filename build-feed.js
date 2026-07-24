/**
 * GPT Feed Builder
 * data/ 内の3つのJSONを読み、全データをHTML本文に直接書き込んだ
 * 静的ページ data/gpt-feed.html を生成する（JavaScript描画なし）。
 * Daily FX Data / Intraday Snapshot の両ワークフローの最後に実行される。
 */

const fs = require("fs");
const path = require("path");

const dataDir = path.join(__dirname, "data");

function readJson(name) {
  const p = path.join(dataDir, name);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

const daily = readJson("daily-levels.json");
const intra = readJson("intraday.json");
const cal = readJson("economic-calendar.json");

if (!daily) {
  console.error("daily-levels.json がありません。先に Daily FX Data を実行してください。");
  process.exit(1);
}

const esc = (s) => String(s ?? "-").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const PAIR_ORDER = ["USDJPY","EURUSD","GBPUSD","EURJPY","AUDUSD","EURGBP","USDCAD","USDCHF","NZDUSD","AUDNZD","XAUUSD"];

// ---- サマリー（テキスト表）----
let summary = "";
// 市場心理: intradayに最新があればそれを優先（なければ朝のdaily値）
let ms = daily.market_sentiment || {};
let msAsOf = daily.as_of;
if (intra?.sentiment?.DXY) {
  ms = {
    dxy: intra.sentiment.DXY?.value ?? null,
    dxy_change_pct: intra.sentiment.DXY?.changePct ?? null,
    us10y: intra.sentiment.US10Y?.value ?? null,
    us10y_change: intra.sentiment.US10Y?.change ?? null,
    vix: intra.sentiment.VIX?.value ?? null,
    vix_change_pct: intra.sentiment.VIX?.changePct ?? null,
  };
  msAsOf = intra.as_of;
}
const sess = intra?.market_session;
if (sess) {
  summary += `【Market Session】(as_of: ${sess.as_of})\n`;
  summary += `東京: ${sess.tokyo} / ロンドン: ${sess.london} / NY: ${sess.new_york}`;
  summary += `（オープンJST: 東京 ${sess.opens_jst.tokyo} / ロンドン ${sess.opens_jst.london} / NY ${sess.opens_jst.new_york}）\n\n`;
}
summary += `【Market Sentiment】(as_of: ${msAsOf})\n`;
summary += `DXY: ${ms.dxy} (${ms.dxy_change_pct}%) | US10Y: ${ms.us10y}% (${ms.us10y_change >= 0 ? "+" : ""}${ms.us10y_change}) | VIX: ${ms.vix} (${ms.vix_change_pct}%)\n\n`;

summary += `【Pairs】 daily levels as_of: ${daily.as_of}` + (intra ? ` / intraday as_of: ${intra.as_of}` : " / intraday: なし") + "\n";
for (const code of PAIR_ORDER) {
  const d = daily.pairs?.[code];
  if (!d) continue;
  const q = intra?.pairs?.[code];
  summary += `\n[${code}]\n`;
  if (q) {
    summary += `  現在値: ${q.price} (前日終値比 ${q.change_from_prev_close >= 0 ? "+" : ""}${q.change_from_prev_close})\n`;
    summary += `  当日高値: ${q.today_high} / 当日安値: ${q.today_low}\n`;
    summary += `  ADR消化: ${q.adr_used_pct}% (使用 ${q.adr_used} / 残り ${q.adr_remaining})\n`;
    summary += `  price_zone: ${q.price_zone} | R1まで ${q.dist_to_r1} / Pivotまで ${q.dist_to_pivot} / S1まで ${q.dist_to_s1}\n`;
  } else {
    summary += `  （当日データなし）\n`;
  }
  summary += `  前日: 高値 ${d.prev_high} / 安値 ${d.prev_low} / NY終値 ${d.prev_close_ny}` +
    (d.previous_day_range_pct != null ? ` | 前日レンジ/ADR: ${d.previous_day_range_pct}%` : "") + `\n`;
  summary += `  Pivot: ${d.pivot} | R1 ${d.r1} / R2 ${d.r2} | S1 ${d.s1} / S2 ${d.s2}\n`;
  summary += `  ADR20: ${d.adr20}${d.adr20_pips ? ` (${d.adr20_pips}p)` : ""} | ATR14: ${d.atr14}${d.atr14_pips ? ` (${d.atr14_pips}p)` : ""} | ATR_SL目安: ${d.atr_sl_1_0}〜${d.atr_sl_1_5}\n`;
}

summary += `\n【Economic Calendar】(High/Medium, JST)` + (cal ? ` as_of: ${cal.as_of}\n` : ` データなし\n`);
if (cal && cal.events) {
  if (cal.events.length === 0) summary += "本日の該当イベントはありません\n";
  for (const e of cal.events) {
    summary += `${e.time_jst} [${e.currency}] (${e.impact}) ${e.event}` +
      (e.forecast ? ` | 予想: ${e.forecast}` : "") +
      (e.previous ? ` | 前回: ${e.previous}` : "") +
      (e.scheduled_time_passed ? " | 発表時刻経過(実績値は別ソースで確認)" : "") + "\n";
  }
}

// ---- HTML生成（本文に直接データを記載、JS描画なし）----
const nowJst = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Tokyo" }).replace(" ", "T") + "+09:00";
const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<title>FX Daily Levels - GPT Feed</title>
<meta name="robots" content="noindex">
<style>body{font-family:monospace;max-width:1000px;margin:20px auto;padding:0 16px;line-height:1.5}pre{white-space:pre-wrap;word-break:break-all;background:#f6f8fa;padding:12px;border-radius:6px}h2{border-bottom:1px solid #ccc;padding-bottom:4px}</style>
</head>
<body>
<h1>FX Daily Levels - GPT Feed</h1>
<p>feed_generated_at: ${esc(nowJst)} / timezone: Asia/Tokyo</p>
<p>daily as_of: ${esc(daily.as_of)} | intraday as_of: ${esc(intra?.as_of ?? "なし")} | calendar as_of: ${esc(cal?.as_of ?? "なし")}</p>
<p>注意: 事実データのみ。トレード判定は含まない。intradayは最大1時間前の値の場合がある。</p>

<h2>サマリー</h2>
<pre>${esc(summary)}</pre>

<h2>Raw: daily-levels.json</h2>
<pre>${esc(JSON.stringify(daily, null, 1))}</pre>

<h2>Raw: intraday.json</h2>
<pre>${esc(intra ? JSON.stringify(intra, null, 1) : "未生成")}</pre>

<h2>Raw: economic-calendar.json</h2>
<pre>${esc(cal ? JSON.stringify(cal, null, 1) : "未生成")}</pre>
</body>
</html>
`;

fs.writeFileSync(path.join(dataDir, "gpt-feed.html"), html);

// ---- TXT版（フォールバック用・プレーンテキスト）----
const txt = `FX Daily Levels - GPT Feed (plain text)
feed_generated_at: ${nowJst} / timezone: Asia/Tokyo
daily as_of: ${daily.as_of} | intraday as_of: ${intra?.as_of ?? "なし"} | calendar as_of: ${cal?.as_of ?? "なし"}
注意: 事実データのみ。トレード判定は含まない。intradayは最大1時間前の値の場合がある。

===== サマリー =====
${summary}
===== Raw: daily-levels.json =====
${JSON.stringify(daily, null, 1)}

===== Raw: intraday.json =====
${intra ? JSON.stringify(intra, null, 1) : "未生成"}

===== Raw: economic-calendar.json =====
${cal ? JSON.stringify(cal, null, 1) : "未生成"}
`;
fs.writeFileSync(path.join(dataDir, "gpt-feed.txt"), txt);

// ---- CSV版（Googleスプレッドシート IMPORTDATA 用）----
const csvEsc = (v) => {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// 1) feed.csv: 当日スナップショット（1ペア=1行）
{
  const header = [
    "pair","price","today_high","today_low","change_from_prev_close",
    "adr_used_pct","adr_used","adr_remaining","price_zone",
    "prev_high","prev_low","prev_close_ny",
    "pivot","r1","r2","s1","s2",
    "adr20","adr20_pips","atr14","atr14_pips","atr_sl_1_0","atr_sl_1_5","prev_day_range_pct",
    "dxy","dxy_change_pct","us10y","us10y_change","vix","vix_change_pct",
    "daily_as_of","intraday_as_of",
  ];
  const rows = [header.join(",")];
  for (const code of PAIR_ORDER) {
    const d = daily.pairs?.[code];
    if (!d) continue;
    const q = intra?.pairs?.[code] || {};
    rows.push([
      code, q.price, q.today_high, q.today_low, q.change_from_prev_close,
      q.adr_used_pct, q.adr_used, q.adr_remaining, q.price_zone,
      d.prev_high, d.prev_low, d.prev_close_ny,
      d.pivot, d.r1, d.r2, d.s1, d.s2,
      d.adr20, d.adr20_pips, d.atr14, d.atr14_pips, d.atr_sl_1_0, d.atr_sl_1_5, d.previous_day_range_pct,
      ms.dxy, ms.dxy_change_pct, ms.us10y, ms.us10y_change, ms.vix, ms.vix_change_pct,
      daily.as_of, intra?.as_of ?? "",
    ].map(csvEsc).join(","));
  }
  fs.writeFileSync(path.join(dataDir, "feed.csv"), rows.join("\n") + "\n");
}

// 2) history.csv: 日次履歴（日付×ペア、確定足ベース）
{
  const header = [
    "date","pair","session_date","prev_high","prev_low","close_ny",
    "adr20","atr14","pivot","r1","r2","s1","s2","range_pct",
  ];
  const rows = [header.join(",")];
  const idx = readJson("index.json");
  const dates = (idx?.dates || []).slice().sort(); // 古い順
  for (const dt of dates) {
    const day = readJson(`${dt}.json`);
    if (!day?.pairs) continue;
    for (const code of PAIR_ORDER) {
      const p = day.pairs[code];
      if (!p) continue;
      const range = p.prevHigh - p.prevLow;
      const r2 = p.r2 ?? Number((p.pivot + range).toFixed(6));
      const s2 = p.s2 ?? Number((p.pivot - range).toFixed(6));
      const rangePct = p.adr20 > 0 ? Number((((p.prevHigh - p.prevLow) / p.adr20) * 100).toFixed(1)) : "";
      rows.push([
        dt, code, p.sessionDate, p.prevHigh, p.prevLow, p.prevClose,
        p.adr20, p.atr14, p.pivot, p.r1, r2, p.s1, s2, rangePct,
      ].map(csvEsc).join(","));
    }
  }
  fs.writeFileSync(path.join(dataDir, "history.csv"), rows.join("\n") + "\n");
}

console.log("保存完了: gpt-feed.html / gpt-feed.txt / feed.csv / history.csv");
