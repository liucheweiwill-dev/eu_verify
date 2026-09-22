#!/usr/bin/env node
//
// verify.js — 檢查 Google 回的結果，關鍵字是真的在正文裡，還是只在導覽列裡。
//
// 用法：  node verify.js [urls.txt] [-o search_result.html]
//
// 為什麼需要這個、為什麼不能直接 grep：見 README.md。
// 一句話版本：機構網站的導覽列每一頁都有國名與主題名，直接 grep 會跟
// Google 犯一樣的錯。所以每個 host 先抓一張「保證沒有正文」的 404 頁當
// 對照，候選頁的命中數要**超過**對照頁，才算正文真的有。
//
// 零依賴，Node 18+（用內建 fetch）。

'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------- 設定

// 每個網域的關鍵字，分號分隔。
// **要跟 eu_monitor/index.html 的 SITES.kw 保持一致**——那邊改了這邊要跟著改。
// 這些字為什麼長這樣（哪些被導覽列污染過），見 eu_monitor/docs/AGENT_BRIEF.md §10。
const SITES = [
  {
    domain: 'eeas.europa.eu',
    kw: 'Taiwan Strait;cross-Strait;Chinese;PRC;Beijing;South China Sea;' +
        'the Indo-Pacific;Indo-Pacific region;NATO;drone;cables',
  },
  {
    domain: 'consilium.europa.eu',
    kw: 'Taiwan;China;Chinese;PRC;NATO;drone;cables;Indo-Pacific',
    // 這一站對所有自動化客戶端回 403（連會執行 JS 的瀏覽器也過不去）。
    // 不是 bug，是對方擋的。結果一律標成「無法檢查」。
    knownBlocked: '該站對所有自動化客戶端回 403（JS 指紋挑戰）',
  },
  {
    domain: 'nato.int',
    kw: 'Chinese;PRC;Beijing;Indo-Pacific partners;South China Sea;drone;cables',
  },
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TIMEOUT_MS = 25000;
const POLITE_DELAY_MS = 1000;   // 抓取之間停一下，不要打人家的站
const BASELINE_PROBE = '/zz-eu-verify-no-such-page-' + Date.now();

// ---------------------------------------------------------------- 小工具

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// 把 HTML 變成純文字。
// 標籤換成「空白」而不是刪掉——刪掉會讓 <td>Taiwan</td><td>Strait</td>
// 黏成 "TaiwanStrait"，或讓相鄰選單項黏成假的片語。
function htmlToText(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? htmlToText(m[1]).slice(0, 160) : '';
}

function countKeyword(text, kw) {
  const re = new RegExp(escapeRegExp(kw), 'gi');
  const m = text.match(re);
  return m ? m.length : 0;
}

function parseKeywords(kwString) {
  return kwString.split(';').map((k) => k.trim()).filter((k) => k.length > 0);
}

function siteFor(host) {
  return SITES.find((s) => host === s.domain || host.endsWith('.' + s.domain)) || null;
}

async function fetchPage(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml' },
    });
    const body = await res.text();
    return { ok: true, status: res.status, finalUrl: res.url || url, body };
  } catch (e) {
    return { ok: false, error: (e && e.name === 'AbortError')
      ? '逾時（' + (TIMEOUT_MS / 1000) + ' 秒）'
      : String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- 對照頁

// 對照頁 = 同一個 host 的 404 頁。它保證沒有正文、但有完整的導覽列，
// 所以是最乾淨的「chrome 基準線」。
//
// 已知風險：有些站的不存在路徑會回 soft-404（200 + 真的內容）。那樣基準線
// 會被灌水，真正命中的頁面會被誤判成「只在導覽列」——也就是會漏東西。
// 所以下面會把基準線的數字一起輸出到報告裡，讓人看得到、能自己判斷。
const baselineCache = new Map();

async function getBaseline(host, keywords) {
  if (baselineCache.has(host)) return baselineCache.get(host);

  const url = 'https://' + host + BASELINE_PROBE;
  const res = await fetchPage(url);
  let baseline;

  if (!res.ok) {
    baseline = { available: false, reason: '抓不到對照頁：' + res.error, counts: {} };
  } else {
    const text = htmlToText(res.body);
    const counts = {};
    for (const kw of keywords) counts[kw] = countKeyword(text, kw);
    baseline = {
      available: true,
      status: res.status,
      bytes: res.body.length,
      softNotFound: res.status === 200,   // 可疑：不存在的路徑卻回 200
      counts,
    };
  }

  baselineCache.set(host, baseline);
  await sleep(POLITE_DELAY_MS);
  return baseline;
}

// ---------------------------------------------------------------- 主流程

async function checkUrl(rawUrl) {
  const out = { url: rawUrl };

  let host;
  try {
    host = new URL(rawUrl).hostname;
  } catch (e) {
    out.state = 'unknown';
    out.reason = '不是合法的網址';
    return out;
  }
  out.host = host;

  const site = siteFor(host);
  if (!site) {
    out.state = 'unknown';
    out.reason = '這個 host 不在 SITES 設定裡，沒有對應的關鍵字';
    return out;
  }
  out.domain = site.domain;

  const keywords = parseKeywords(site.kw);

  if (site.knownBlocked) {
    out.state = 'unknown';
    out.reason = site.knownBlocked;
    return out;
  }

  const baseline = await getBaseline(host, keywords);
  out.baseline = baseline;
  if (!baseline.available) {
    out.state = 'unknown';
    out.reason = baseline.reason;
    return out;
  }

  const res = await fetchPage(rawUrl);
  await sleep(POLITE_DELAY_MS);

  if (!res.ok) {
    out.state = 'unknown';
    out.reason = '抓取失敗：' + res.error;
    return out;
  }
  if (res.status >= 400) {
    out.state = 'unknown';
    out.reason = '抓取失敗：HTTP ' + res.status;
    return out;
  }

  out.status = res.status;
  out.finalUrl = res.finalUrl;
  out.title = extractTitle(res.body);

  const text = htmlToText(res.body);
  out.hits = [];       // 正文真的有
  out.chromeOnly = []; // 有出現，但沒超過導覽列的量
  out.absent = [];     // 根本沒有

  for (const kw of keywords) {
    const c = countKeyword(text, kw);
    const b = baseline.counts[kw] || 0;
    if (c === 0) out.absent.push(kw);
    else if (c > b) out.hits.push({ kw, count: c, baseline: b });
    else out.chromeOnly.push({ kw, count: c, baseline: b });
  }

  out.state = out.hits.length > 0 ? 'confirmed' : 'chrome';
  return out;
}

// ---------------------------------------------------------------- 報告

function renderHtml(results, meta) {
  const confirmed = results.filter((r) => r.state === 'confirmed');
  const chrome = results.filter((r) => r.state === 'chrome');
  const unknown = results.filter((r) => r.state === 'unknown');

  const section = (title, cls, rows, bodyFn) => {
    if (rows.length === 0) return '';
    return '<section class="' + cls + '">\n<h2>' + escapeHtml(title) +
      ' <span class="n">' + rows.length + '</span></h2>\n' +
      rows.map(bodyFn).join('\n') + '\n</section>';
  };

  const linkOf = (r) => {
    const href = escapeHtml(r.finalUrl || r.url);
    const label = escapeHtml(r.title || r.url);
    return '<a href="' + href + '" target="_blank" rel="noopener noreferrer">' +
      label + '</a><div class="u">' + escapeHtml(r.url) + '</div>';
  };

  const kwChips = (list, cls) => list.map((h) =>
    '<span class="chip ' + cls + '">' + escapeHtml(h.kw) +
    ' <b>' + h.count + '</b><i>／導覽列 ' + h.baseline + '</i></span>').join(' ');

  const body =
    section('正文確認命中', 'ok', confirmed, (r) =>
      '<article>' + linkOf(r) +
      '<div class="kw">' + kwChips(r.hits, 'hit') + '</div>' +
      (r.chromeOnly.length
        ? '<div class="kw sub">另有只在導覽列的：' + kwChips(r.chromeOnly, 'dim') + '</div>'
        : '') +
      '</article>') +

    section('只在導覽列命中（Google 誤判）', 'chrome', chrome, (r) =>
      '<article>' + linkOf(r) +
      '<div class="kw">' + kwChips(r.chromeOnly, 'dim') + '</div>' +
      '</article>') +

    section('無法檢查', 'unknown', unknown, (r) =>
      '<article>' + linkOf(r) +
      '<div class="why">' + escapeHtml(r.reason || '') + '</div>' +
      '</article>');

  const softWarn = [...baselineCache.entries()]
    .filter(([, b]) => b.available && b.softNotFound)
    .map(([h]) => h);

  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>比對結果 — ${escapeHtml(meta.generatedAt)}</title>
<style>
  :root { color-scheme: light dark;
    --bg:#f6f7f9; --card:#fff; --ink:#16181d; --muted:#6b7280; --line:#e3e6ea;
    --ok:#1a7f43; --warn:#8a6d1f; --dim:#6b7280; --accent:#1f5fd0; --chip:#eef2f9; }
  @media (prefers-color-scheme: dark) { :root {
    --bg:#14161a; --card:#1c1f25; --ink:#e8eaed; --muted:#9aa2ad; --line:#2b2f37;
    --ok:#5fcf8e; --warn:#e2c078; --dim:#9aa2ad; --accent:#6c9bf0; --chip:#242832; } }
  * { box-sizing:border-box; }
  body { margin:0; padding:28px 20px 56px; background:var(--bg); color:var(--ink);
    font:15px/1.6 "Segoe UI","Microsoft JhengHei",system-ui,sans-serif; }
  .wrap { max-width:860px; margin:0 auto; }
  h1 { font-size:21px; margin:0 0 4px; }
  .sub { color:var(--muted); font-size:13.5px; margin:0 0 20px; }
  .tally { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:18px; }
  .tally div { background:var(--card); border:1px solid var(--line); border-radius:10px;
    padding:10px 14px; font-size:13.5px; }
  .tally b { font-size:18px; display:block; }
  section { margin-bottom:22px; }
  h2 { font-size:15px; margin:0 0 10px; padding-bottom:6px; border-bottom:1px solid var(--line); }
  h2 .n { color:var(--muted); font-weight:400; }
  section.ok h2 { color:var(--ok); }
  section.chrome h2 { color:var(--dim); }
  section.unknown h2 { color:var(--warn); }
  article { background:var(--card); border:1px solid var(--line); border-radius:10px;
    padding:12px 14px; margin-bottom:9px; }
  article a { color:var(--accent); text-decoration:none; font-weight:600; }
  article a:hover { text-decoration:underline; }
  .u { color:var(--muted); font-size:11.5px; word-break:break-all; margin-top:3px;
    font-family:ui-monospace,Consolas,monospace; }
  .kw { margin-top:8px; }
  .kw.sub { font-size:12px; color:var(--muted); }
  .chip { display:inline-block; background:var(--chip); border-radius:6px;
    padding:2px 7px; margin:2px 3px 2px 0; font-size:12px; }
  .chip.hit b { color:var(--ok); }
  .chip.dim { opacity:.65; }
  .chip i { color:var(--muted); font-style:normal; font-size:11px; }
  .why { color:var(--warn); font-size:13px; margin-top:6px; }
  footer { color:var(--muted); font-size:12.5px; margin-top:26px;
    border-top:1px solid var(--line); padding-top:14px; }
  footer b { color:var(--ink); }
</style>
</head>
<body>
<div class="wrap">
  <h1>比對結果</h1>
  <p class="sub">${escapeHtml(meta.generatedAt)}　·　輸入 ${meta.total} 筆　·　來源：${escapeHtml(meta.source)}</p>

  <div class="tally">
    <div><b>${confirmed.length}</b>正文確認</div>
    <div><b>${chrome.length}</b>只在導覽列</div>
    <div><b>${unknown.length}</b>無法檢查</div>
  </div>

${body || '<p class="sub">沒有輸入任何網址。</p>'}

  <footer>
    <b>判讀提醒：</b>「只在導覽列」代表該頁的關鍵字命中數沒有超過同站 404 頁的命中數，
    也就是那些字很可能只出現在全站共用的選單裡。這是<b>精確度</b>工具——
    它只能從 Google 給的清單裡剔除假命中，<b>不會、也不可能告訴你有沒有漏掉什麼</b>。
    ${unknown.length ? '<br>本次有 <b>' + unknown.length + '</b> 筆無法檢查，那幾筆<b>既不是命中也不是未命中</b>，請自己開來看。' : ''}
    ${softWarn.length ? '<br><b>警告：</b>' + escapeHtml(softWarn.join('、')) + ' 的 404 探測回了 200，對照基準線可能被灌水，判定會偏嚴（可能誤殺真命中）。' : ''}
  </footer>
</div>
</body>
</html>
`;
}

// ---------------------------------------------------------------- 進入點

async function main() {
  const argv = process.argv.slice(2);
  let input = 'urls.txt';
  let output = 'search_result.html';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '-o') output = argv[++i];
    else input = argv[i];
  }

  if (!fs.existsSync(input)) {
    console.error('找不到輸入檔：' + input);
    console.error('請建立一個純文字檔，一行一個網址（# 開頭的行會被忽略）。');
    process.exit(1);
  }

  const urls = fs.readFileSync(input, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  if (urls.length === 0) {
    console.error(input + ' 裡沒有任何網址。');
    process.exit(1);
  }

  console.log('要檢查 ' + urls.length + ' 個網址…\n');

  const results = [];
  for (let i = 0; i < urls.length; i++) {
    process.stdout.write('  [' + (i + 1) + '/' + urls.length + '] ' + urls[i].slice(0, 78) + ' … ');
    const r = await checkUrl(urls[i]);
    results.push(r);
    const mark = r.state === 'confirmed'
      ? '正文命中 (' + r.hits.map((h) => h.kw).join(', ') + ')'
      : r.state === 'chrome' ? '只在導覽列' : '無法檢查 — ' + r.reason;
    console.log(mark);
  }

  const meta = {
    generatedAt: new Date().toLocaleString('zh-TW', { hour12: false }),
    total: urls.length,
    source: path.basename(input),
  };
  fs.writeFileSync(output, renderHtml(results, meta), 'utf8');

  const n = (s) => results.filter((r) => r.state === s).length;
  console.log('\n正文確認 ' + n('confirmed') +
              '　只在導覽列 ' + n('chrome') +
              '　無法檢查 ' + n('unknown'));
  console.log('已寫出：' + path.resolve(output));
}

main().catch((e) => { console.error(e); process.exit(1); });
