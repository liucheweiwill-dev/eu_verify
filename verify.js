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

// 站台設定（關鍵字、已知封鎖站）與 index.html（瀏覽器版）共用同一份
// sites.json，不要在這裡重複定義。
// **sites.json 的 kw 要跟 eu_monitor/index.html 的 SITES.kw 保持一致**——
// 那邊改了這邊要跟著改。這些字為什麼長這樣（哪些被導覽列污染過），
// 見 eu_monitor/docs/AGENT_BRIEF.md §10。
const SITES_CONFIG = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'sites.json'), 'utf8')
);
const SITES = SITES_CONFIG.sites;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TIMEOUT_MS = 25000;
const POLITE_DELAY_MS = 1000;   // 抓取之間停一下，不要打人家的站

// 基準線探測路徑**必須固定**，不要用時間戳記或其他每次都不同的值。
// 2026-09-23 實測發現：同一個網域對不同的假路徑，404 頁內容會有微幅出入
// （例如某次 baseline 探測 A 路徑得到 1 次「Indo-Pacific」，探測 B 路徑得到
// 2 次），推測是 404 樣板裡帶了跟路徑相關的建議連結一類的東西。用固定路徑
// 探測同一個網址四次，結果每次完全一致——問題不是「404 頁不穩定」，
// 是「每次探測的網址不一樣」。
const BASELINE_PROBE = SITES_CONFIG.baselineProbePath;

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

// 關鍵字怎麼算「出現一次」。index.html 有一份一模一樣的規則，改一邊要改另一邊。
// 1. 要從一個字的開頭算起：Coordinator、Senator 裡的 nato 不算 NATO。
//    後面可以接別的字母，所以 drone 也算到 drones。
// 2. 以 s 結尾的關鍵字也接受單數：cables 也算到 cable。Google 會做這種詞形
//    變化，我們不做的話，Google 靠單數命中的頁面會落到「找不到關鍵字」。
//    -ss／-us／-is 結尾、或去掉 s 後不到 4 個字母的不處理，免得 Congress、
//    status、news、arms 被砍成別的字。
// 2026-09-24 用使用者真實的 17 筆 EEAS 結果查出這兩條，見 README「比對規則」。
// 字首判斷刻意不用 lookbehind，舊一點的瀏覽器不支援；多吃掉的那個前導字元不影響計數。
function keywordPattern(kw) {
  let core = kw;
  const last = kw.split(/\s+/).pop().toLowerCase();
  if (/[^sui]s$/.test(last) && last.length - 1 >= 4) core = kw.slice(0, -1);
  const lead = /^[a-z0-9]/i.test(core) ? '(^|[^a-z0-9])' : '';
  return new RegExp(lead + escapeRegExp(core), 'gi');
}

function countKeyword(text, kw) {
  const m = text.match(keywordPattern(kw));
  return m ? m.length : 0;
}

function parseKeywords(kwString) {
  return kwString.split(';').map((k) => k.trim()).filter((k) => k.length > 0);
}

function siteFor(host) {
  return SITES.find((s) => host === s.domain || host.endsWith('.' + s.domain)) || null;
}

// PDF 一律「無法檢查」。這個工具只讀得懂 HTML，把 PDF 當 HTML 數關鍵字，數到的是
// 壓縮過的位元組，幾乎一定是 0，會被誤判成「找不到關鍵字」。只看網址（結尾 .pdf 或
// /pdf）——網頁版經 Jina 看不到目標站的 Content-Type，兩邊要用同一條規則。
// 2026-09-24：consilium 的 PDF 放在 data.consilium.europa.eu，這個子網域其實沒擋程式
// （curl 回 200），之前卻被標成「該站回 403」——理由是錯的。index.html 有同樣一份。
const PDF_REASON = 'PDF 檔：這個工具讀不了 PDF 的內容，要自己開來看。';

function isPdfUrl(u) {
  try { return /(\.pdf|\/pdf)$/i.test(new URL(u).pathname); }
  catch (e) { return false; }
}

// 理事會文件的網址：data.consilium.europa.eu/doc/document/<文件編號>/<語言>/pdf。
// 同一份文件常整批出現十幾種語言版本（2026-09-24：ST-13528-2026-INIT 一次 16 種），
// 都是同一份的官方譯本。合併成一筆顯示，每個語言的連結都留在那一筆底下——
// 一個連結都不丟，只是不用逐筆看 16 次。index.html 有同樣一份。
function councilDocKey(u) {
  try {
    const p = new URL(u);
    if (p.hostname !== 'data.consilium.europa.eu') return null;
    const m = /^\/doc\/document\/([^\/]+)\/([a-z]{2,3})\/pdf$/i.exec(p.pathname);
    return m ? { id: m[1], lang: m[2].toLowerCase() } : null;
  } catch (e) { return null; }
}

function groupCouncilDocs(results) {
  const out = [];
  const byId = {};
  results.forEach((r) => {
    const k = councilDocKey(r.url);
    if (!k) { out.push(r); return; }
    let g = byId[k.id];
    if (!g) {
      g = byId[k.id] = Object.assign({}, r, { docId: k.id, langs: [] });
      out.push(g);
    }
    g.langs.push({ lang: k.lang, url: r.url });
  });
  out.forEach((g) => {
    if (!g.langs) return;
    g.langs.sort((a, b) => (b.lang === 'en') - (a.lang === 'en'));   // en 放最前面，其餘照原順序
    g.url = g.langs[0].url;
    g.lang = g.langs[0].lang;   // 有英文版就算英文，留在主列表
    g.title = g.docId + '（理事會文件' + (g.langs.length > 1 ? '，' + g.langs.length + ' 種語言' : '') + '）';
  });
  return out;
}

// ---------------------------------------------------------------- 日期提示與語言
//
// 兩者都只影響「怎麼顯示、放在哪一區」，不影響命中判定，也不會丟掉任何一筆。
// index.html 有一模一樣的一份，改一邊要改另一邊（keyword-test.js 會檢查）。

// 日期提示：頁面上第一個「不在同站 404 頁上」的日期。2026-10-08 使用者搜「本週」
// 卻看到 9/22 的文章——EEAS 頁面沒有任何機器可讀的日期，伺服器的 Last-Modified 永遠是
// 「剛剛」，Google 只能猜。顯示頁面上寫的日期，舊文章一眼就認得出來。
// - 取第一個、不取最新的：EEAS 把文章日期寫在標題下面（22.09.2026），頁尾「相關報導」
//   列的是別篇文章的較新日期——那多半就是 Google 以為它是新頁面的原因。
// - 扣掉 404 頁上的日期：EEAS 導覽列裡有固定的「14 July 2015」，不是這篇的。
// - 只是提示，不拿來過濾：正文也可能引用別的日期，抓錯了只會顯示錯的提示，不會漏掉頁面。
const DATE_RE = /\b\d{1,2}\.\d{1,2}\.(?:19|20)\d\d\b|\b\d{1,2}(?:\s+de)?\s+(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec|janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|septembre|octobre|novembre|décembre|decembre|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre|januar|februar|märz|maerz|juni|juli|oktober|dezember)\.?(?:\s+de)?\s+(?:19|20)\d\d\b|\b(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)\.?\s+\d{1,2},\s+(?:19|20)\d\d\b|\b(?:19|20)\d\d-\d\d-\d\d(?!\d)/gi;

function datesIn(text) {
  return (text.match(DATE_RE) || []).map((s) => s.toLowerCase().replace(/\s+/g, ' '));
}

function firstDate(text, baselineDates) {
  const found = text.match(DATE_RE) || [];
  for (let i = 0; i < found.length; i++) {
    if (!baselineDates || baselineDates.indexOf(found[i].toLowerCase().replace(/\s+/g, ' ')) < 0) return found[i];
  }
  return '';
}

// 語言：非英文頁面歸到「其他」（使用者 2026-10-08 指定，跟「只在導覽列」一樣可以略過）。
// 頁面標示的語言（<html lang>）與正文常用字（扣掉 404 頁＝導覽列）兩邊都說不是英文，才算非英文：
// - 只看標示會誤判：NATO 的 /fr/ 網址底下常是英文逐字稿（標示 fr，英文常用字多出四千多個），
//   那正是一篇命中最多的頁面，不能丟到後面。
// - 只看常用字也會誤判：EEAS 代表處頁面的模板比 404 頁小，扣完全是 0，判斷不出來。
// 判斷不出來就當英文、留在主列表——寧可多看一筆。
const STOPWORDS = {
  en: ['the', 'and', 'of', 'to', 'is', 'that', 'for', 'with', 'this', 'are'],
  es: ['el', 'los', 'las', 'del', 'que', 'y', 'por', 'para', 'una', 'con'],
  fr: ['le', 'les', 'des', 'et', 'est', 'une', 'pour', 'dans', 'qui', 'du'],
  de: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'mit', 'für', 'auf', 'den'],
};

function stopwordCounts(text) {
  const words = text.toLowerCase().split(/[^a-zà-ÿ]+/);
  const out = {};
  Object.keys(STOPWORDS).forEach((l) => {
    out[l] = words.filter((w) => STOPWORDS[l].indexOf(w) >= 0).length;
  });
  return out;
}

function declaredLang(html) {
  const m = /<html[^>]*\slang=["']?([a-z]{2,3})/i.exec(html);
  return m ? m[1].toLowerCase() : '';
}

function pageLang(declared, counts, baseCounts) {
  if (!declared || declared === 'en') return 'en';
  let best = 'en';
  let bestN = 0;
  Object.keys(counts).forEach((l) => {
    const n = Math.max(0, counts[l] - ((baseCounts && baseCounts[l]) || 0));
    if (n > bestN) { best = l; bestN = n; }
  });
  return best === 'en' || bestN === 0 ? 'en' : declared;
}

// 沒抓頁面的（無法檢查）只能看網址：理事會文件的語言代碼、consilium 網址的 /xx/ 路徑。
// 其他站的網址語言不可靠（EEAS 的 _en 頁面可能是別的語言），看不出來就當英文。
function urlLang(u) {
  const k = councilDocKey(u);
  if (k) return k.lang;
  try {
    const p = new URL(u);
    if (!/(^|\.)consilium\.europa\.eu$/.test(p.hostname)) return '';
    const m = /^\/([a-z]{2})\//.exec(p.pathname);
    return m ? m[1] : '';
  } catch (e) { return ''; }
}

// 正文命中、但頁面日期早於搜尋範圍的，排到第二區（使用者 2026-10-08 指定：第一區只放當期的）。
// - 搜尋範圍看書籤收集紀錄裡記的 tbs（開分頁時實際用的設定）；沒有紀錄就不知道，不分。
// - 範圍再加 2 天寬限：Google 收錄有延遲，搜「過去 24 小時」時，前天發、今天才被收錄的文章
//   對使用者是新的，不能排到後面。
// - 日期抓不到、認不出來、在未來，一律留在第一區。
// - 移到第二區不是過濾：照樣列在正文確認的正下方，只是不進「複製正文確認清單」。
const MONTH_NUM = {
  'january': 1, 'jan': 1, 'janvier': 1, 'enero': 1, 'januar': 1,
  'february': 2, 'feb': 2, 'février': 2, 'fevrier': 2, 'febrero': 2, 'februar': 2,
  'march': 3, 'mar': 3, 'mars': 3, 'marzo': 3, 'märz': 3, 'maerz': 3,
  'april': 4, 'apr': 4, 'avril': 4, 'abril': 4,
  'may': 5, 'mai': 5, 'mayo': 5,
  'june': 6, 'jun': 6, 'juin': 6, 'junio': 6, 'juni': 6,
  'july': 7, 'jul': 7, 'juillet': 7, 'julio': 7, 'juli': 7,
  'august': 8, 'aug': 8, 'août': 8, 'aout': 8, 'agosto': 8,
  'september': 9, 'sep': 9, 'sept': 9, 'septembre': 9, 'septiembre': 9, 'setiembre': 9,
  'october': 10, 'oct': 10, 'octobre': 10, 'octubre': 10, 'oktober': 10,
  'november': 11, 'nov': 11, 'novembre': 11, 'noviembre': 11,
  'december': 12, 'dec': 12, 'décembre': 12, 'decembre': 12, 'diciembre': 12, 'dezember': 12,
};
const RANGE_DAYS = { 'qdr:d': 1, 'qdr:w': 7, 'qdr:m': 31, 'qdr:y': 366 };
const STALE_GRACE_DAYS = 2;

function parseDate(s) {
  if (!s) return null;
  const t = s.toLowerCase();
  let m;
  let d = null;
  if ((m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(t))) d = [+m[3], +m[2], +m[1]];
  else if ((m = /^(\d{4})-(\d\d)-(\d\d)/.exec(t))) d = [+m[1], +m[2], +m[3]];
  else if ((m = /^(\d{1,2})(?:\s+de)?\s+([^\s.]+)\.?(?:\s+de)?\s+(\d{4})$/.exec(t)) && MONTH_NUM[m[2]]) d = [+m[3], MONTH_NUM[m[2]], +m[1]];
  else if ((m = /^([^\s.]+)\.?\s+(\d{1,2}),\s+(\d{4})$/.exec(t)) && MONTH_NUM[m[1]]) d = [+m[3], MONTH_NUM[m[1]], +m[2]];
  return d && d[1] >= 1 && d[1] <= 12 && d[2] >= 1 && d[2] <= 31 ? d : null;
}

function ageDays(s, today) {
  const d = parseDate(s);
  if (!d) return null;
  return Math.round((Date.UTC(today[0], today[1] - 1, today[2]) - Date.UTC(d[0], d[1] - 1, d[2])) / 86400000);
}

function isStale(s, qdr, today) {
  const days = RANGE_DAYS[qdr];
  const age = ageDays(s, today);
  return !!days && age !== null && age > days + STALE_GRACE_DAYS;
}

function todayParts() {
  const n = new Date();
  return [n.getFullYear(), n.getMonth() + 1, n.getDate()];
}

// 一筆結果放在哪一區：非英文一律 'foreign'（「其他」）；正文命中但日期較舊的是 'stale'；其餘照它的判定
function sectionOf(r) {
  const lang = r.lang || urlLang(r.url) || 'en';
  if (lang !== 'en') return 'foreign';
  return r.state === 'confirmed' && r.stale ? 'stale' : r.state;
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
      stop: stopwordCounts(text),   // 404 頁上的常用字與日期都屬於導覽列，判斷語言與日期時要扣掉
      dates: datesIn(text),
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

  if (isPdfUrl(rawUrl)) {
    out.state = 'unknown';
    out.reason = PDF_REASON;
    return out;
  }

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
  out.date = firstDate(text, baseline.dates);
  out.lang = pageLang(declaredLang(res.body), stopwordCounts(text), baseline.stop);
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

  // 三種結果：正文有（超過基準線）、只在導覽列（有出現但沒超過）、找不到（一個都沒有）。
  // 「找不到」不可以併進「只在導覽列」——那等於說 Google 錯了，但我們其實不知道
  // Google 是靠什麼命中的（同義詞、詞形變化、其他語言），見 README「比對規則」。
  out.state = out.hits.length > 0 ? 'confirmed' : out.chromeOnly.length > 0 ? 'chrome' : 'absent';
  return out;
}

// ---------------------------------------------------------------- 報告

// ---------------------------------------------------------------- 收集狀況

// 書籤 v2 附在剪貼簿裡的 #euv 紀錄行，經 extract.js 原樣傳到這裡。
// 規則跟 index.html 的 computeCoverage 完全一樣——三條路要講一樣的話。
// 狀態只有 ok／bad 兩種：沒有紀錄一律算 bad，「不知道」不能被當成「沒問題」。
function parseCollectLog(lines) {
  const logs = {};
  lines.forEach((line) => {
    const m = /^#euv\s+v\d+\s+(\{.*\})\s*$/.exec(line.trim());
    if (!m) return;
    try { const o = JSON.parse(m[1]); if (o && typeof o.d === 'string') logs[o.d] = o; }
    catch (e) { /* 壞掉的紀錄行就當沒有 */ }
  });
  return logs;
}

function pagesLabel(ps) {
  if (!ps || !ps.length) return '';
  ps = ps.slice().sort((a, b) => a - b);
  const contiguous = ps.every((p, i) => i === 0 || p === ps[i - 1] + 1);
  if (contiguous) return ps.length === 1 ? '第 ' + ps[0] + ' 頁' : '第 ' + ps[0] + '–' + ps[ps.length - 1] + ' 頁';
  return '第 ' + ps.join('、') + ' 頁';
}

function missingPages(ps) {
  if (!ps || !ps.length) return [];
  const max = Math.max(...ps), out = [];
  for (let p = 1; p <= max; p++) if (ps.indexOf(p) < 0) out.push(p);
  return out;
}

function computeCoverage(urls, logs) {
  const hasAnyLog = Object.keys(logs).length > 0;
  return SITES.map((s) => {
    const n = urls.filter((u) => {
      try { const h = new URL(u).hostname; return h === s.domain || h.endsWith('.' + s.domain); }
      catch (e) { return false; }
    }).length;
    const e = logs[s.domain];
    const name = s.name || s.domain;
    if (e) {
      const miss = missingPages(e.p);
      if (e.zero) return { name, ok: true, text: '本次查詢 0 筆（Google 顯示查無結果）' };
      if (e.last && !miss.length && !e.err) return { name, ok: true, text: pagesLabel(e.p) + '，已收完（' + n + ' 筆）' };
      const why = e.err ? e.err : (miss.length ? '缺' + pagesLabel(miss) : '還有下一頁沒收');
      return { name, ok: false, text: pagesLabel(e.p) + '（' + n + ' 筆）— ' + why };
    }
    if (n > 0) return { name, ok: false, text: n + ' 筆，但沒有收集紀錄——' +
      (hasAnyLog ? '這站可能是用舊版書籤收的' : '手動貼上或舊版書籤') + '，無法確認是否收完所有頁' };
    return { name, ok: false, text: '沒有收到這站的網址——是這段期間真的沒結果，還是沒在那個分頁按書籤？' };
  });
}

// 「找不到關鍵字」那一區的說明。index.html 用同一段話。
const ABSENT_NOTE = 'Google 回了這幾頁，但抓到的頁面上一個關鍵字都找不到——不在正文，也不在導覽列。' +
  'Google 可能是靠同義詞、詞形變化或其他語言命中的，也可能是頁面後來改過；' +
  '工具判斷不了，所以不能當成 Google 誤判。請看標題決定要不要點開。';

// 第二區與第一區沒依日期分組時的說明。index.html 用同樣的話。
const STALE_NOTE = '這幾筆正文有關鍵字，但頁面上的日期早於這次搜尋的時間範圍（另加 ' + STALE_GRACE_DAYS +
  ' 天寬限，因為 Google 收錄有延遲），多半是 Google 重新收錄的舊文章。' +
  '日期是工具在頁面上找到的第一個日期，可能不準——標題看起來是新的，請點開確認。';
const NO_RANGE_NOTE = '有些網址沒有收集紀錄，不知道搜尋時用的時間範圍，那幾筆沒有依日期分到下一區。';

// 「其他」裡非英文那一組的說明。index.html 用同一段話。
const FOREIGN_NOTE = '頁面標示的語言與正文用字都不是英文的頁面，不論命中與否都放在這裡；' +
  '每一筆原本的判定（正文命中、只在導覽列……）照樣標在底下，一筆都沒丟。';

function renderHtml(results, meta) {
  // 同一份理事會文件的各語言版本先合併成一筆，下面的分區與計數都用合併後的
  const shown = groupCouncilDocs(results);
  const pick = (s) => shown.filter((r) => sectionOf(r) === s);
  const confirmed = pick('confirmed');
  const stale = pick('stale');
  const absent = pick('absent');
  const unknown = pick('unknown');
  const chrome = pick('chrome');
  const foreign = pick('foreign');
  const other = chrome.length + foreign.length;
  const unknownUrls = unknown.reduce((n, r) => n + (r.langs ? r.langs.length : 1), 0);

  const section = (title, cls, rows, bodyFn, note) => {
    if (rows.length === 0) return '';
    return '<section class="' + cls + '">\n<h2>' + escapeHtml(title) +
      ' <span class="n">' + rows.length + '</span></h2>\n' +
      (note ? '<p class="why">' + escapeHtml(note) + '</p>\n' : '') +
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

  // 每筆底下的小字：頁面上的日期（有抓到頁面才有）；非英文那一組另外標語言
  const metaLine = (r, withLang) => {
    const parts = [];
    if (withLang) parts.push('語言：' + (r.lang || urlLang(r.url)));
    if (r.state !== 'unknown') {
      parts.push(r.date ? '頁面上的日期：' + r.date + (r.stale && r.age !== null ? '（' + r.age + ' 天前）' : '')
        : '頁面上找不到日期');
    }
    return parts.length ? '<div class="kw sub">' + escapeHtml(parts.join('　')) + '</div>' : '';
  };

  const langLinks = (r) => (r.langs && r.langs.length > 1
    ? '<div class="kw sub">各語言版本：' + r.langs.map((l) =>
      '<a href="' + escapeHtml(l.url) + '" target="_blank" rel="noopener noreferrer">' +
      escapeHtml(l.lang) + '</a>').join(' ') + '</div>'
    : '');

  // 非英文頁面原本的判定，照樣標出來
  const verdictOf = (r) => {
    if (r.state === 'confirmed') {
      return '<div class="kw">正文命中：' + kwChips(r.hits, 'hit') + '</div>' +
        (r.chromeOnly.length ? '<div class="kw sub">另有只在導覽列的：' + kwChips(r.chromeOnly, 'dim') + '</div>' : '');
    }
    if (r.state === 'chrome') return '<div class="kw">只在導覽列：' + kwChips(r.chromeOnly, 'dim') + '</div>';
    if (r.state === 'absent') return '<div class="kw sub">找不到關鍵字</div>';
    return langLinks(r) + '<div class="why">無法檢查：' + escapeHtml(r.reason || '') + '</div>';
  };

  const hitBody = (r) =>
    '<article>' + linkOf(r) + metaLine(r) +
    '<div class="kw">' + kwChips(r.hits, 'hit') + '</div>' +
    (r.chromeOnly.length
      ? '<div class="kw sub">另有只在導覽列的：' + kwChips(r.chromeOnly, 'dim') + '</div>'
      : '') +
    '</article>';

  // 順序：先正文確認，再正文命中但日期較舊的，再兩類要自己看的（找不到關鍵字、無法檢查），
  // 最後才是可以略過的「其他」（只在導覽列、非英文頁面）。
  const body =
    section('正文確認命中', 'ok', confirmed, hitBody, confirmed.some((r) => !r.range) ? NO_RANGE_NOTE : '') +

    section('正文命中，但日期早於搜尋範圍', 'stale', stale, hitBody, STALE_NOTE) +

    section('找不到關鍵字（要自己看）', 'absent', absent, (r) =>
      '<article>' + linkOf(r) + metaLine(r) + '</article>', ABSENT_NOTE) +

    section('無法檢查', 'unknown', unknown, (r) =>
      '<article>' + linkOf(r) + langLinks(r) +
      '<div class="why">' + escapeHtml(r.reason || '') + '</div>' +
      '</article>',
      unknownUrls > unknown.length
        ? '同一份理事會文件的不同語言版本合併成一筆：' + unknownUrls + ' 個網址 → ' + unknown.length +
          ' 筆。每個語言的連結都在該筆底下。'
        : '') +

    (other
      ? '<section class="chrome">\n<h2>其他（可以略過） <span class="n">' + other + '</span></h2>\n' +
        (chrome.length
          ? '<h3>只在導覽列命中（Google 誤判） <span class="n">' + chrome.length + '</span></h3>\n' +
            chrome.map((r) => '<article>' + linkOf(r) + metaLine(r) +
              '<div class="kw">' + kwChips(r.chromeOnly, 'dim') + '</div></article>').join('\n')
          : '') +
        (foreign.length
          ? '<h3>非英文頁面 <span class="n">' + foreign.length + '</span></h3>\n' +
            '<p class="kw sub">' + escapeHtml(FOREIGN_NOTE) + '</p>\n' +
            foreign.map((r) => '<article>' + linkOf(r) + metaLine(r, true) + verdictOf(r) + '</article>').join('\n')
          : '') +
        '\n</section>'
      : '');

  const needLook = [
    absent.length ? '<b>' + absent.length + '</b> 筆找不到關鍵字' : '',
    unknown.length ? '<b>' + unknown.length + '</b> 筆無法檢查' : '',
  ].filter(Boolean).join('、');

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
  section.unknown h2, section.absent h2 { color:var(--warn); }
  section.stale h2 { color:var(--ok); opacity:.8; }
  section h3 { font-size:13.5px; font-weight:600; color:var(--dim); margin:14px 0 8px; }
  section h3 .n { color:var(--muted); font-weight:400; }
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

  <section class="${meta.coverage.every((c) => c.ok) ? 'ok' : 'unknown'}">
    <h2>收集狀況</h2>
    ${meta.coverage.map((c) => '<div>' + (c.ok ? '✓ ' : '⚠ ') + escapeHtml(c.name) + '：' + escapeHtml(c.text) + '</div>').join('\n    ')}
    ${meta.coverage.every((c) => c.ok) ? '' : '<div class="why">⚠ 收集不完整。下面的結果只涵蓋已收到的網址——沒收到的頁面不會出現在任何一類裡。</div>'}
  </section>

  <div class="tally">
    <div><b>${confirmed.length}</b>正文確認</div>
    <div><b>${stale.length}</b>日期較舊</div>
    <div><b>${absent.length}</b>找不到關鍵字</div>
    <div><b>${unknown.length}</b>無法檢查</div>
    <div><b>${other}</b>其他</div>
  </div>

${body || '<p class="sub">沒有輸入任何網址。</p>'}

  <footer>
    <b>判讀提醒：</b>「只在導覽列」代表該頁的關鍵字命中數沒有超過同站 404 頁的命中數，
    也就是那些字很可能只出現在全站共用的選單裡。「找不到關鍵字」代表抓到的頁面上一個關鍵字都沒有，
    Google 為什麼回它，工具判斷不了。非英文頁面不論命中與否都歸在「其他」，原本的判定照樣標著。
    「頁面上的日期」是工具在頁面上找到的第一個日期，只是提示，沒有拿來排除任何一筆。這是<b>精確度</b>工具——
    它只能從 Google 給的清單裡剔除假命中，<b>不會、也不可能告訴你有沒有漏掉什麼</b>。
    ${needLook ? '<br>本次有 ' + needLook + '，那幾筆<b>既不是命中也不是未命中</b>，請自己看。' : ''}
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
  let summaryJsonPath = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '-o') output = argv[++i];
    else if (argv[i] === '--summary-json') summaryJsonPath = argv[++i];
    else input = argv[i];
  }

  if (!fs.existsSync(input)) {
    console.error('找不到輸入檔：' + input);
    console.error('請建立一個純文字檔，一行一個網址（# 開頭的行會被忽略）。');
    process.exit(1);
  }

  const rawLines = fs.readFileSync(input, 'utf8').split(/\r?\n/);
  const logs = parseCollectLog(rawLines);
  const urls = rawLines
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  if (urls.length === 0) {
    console.error(input + ' 裡沒有任何網址。');
    process.exit(1);
  }

  // 先講「送來的清單完不完整」，再講驗證結果
  const coverage = computeCoverage(urls, logs);
  console.log('收集狀況：');
  coverage.forEach((c) => console.log('  ' + (c.ok ? '✓ ' : '⚠ ') + c.name + '：' + c.text));
  if (!coverage.every((c) => c.ok)) {
    console.log('  ⚠ 收集不完整。下面的結果只涵蓋已收到的網址。');
  }
  console.log('');

  console.log('要檢查 ' + urls.length + ' 個網址…\n');

  const results = [];
  for (let i = 0; i < urls.length; i++) {
    process.stdout.write('  [' + (i + 1) + '/' + urls.length + '] ' + urls[i].slice(0, 78) + ' … ');
    const r = await checkUrl(urls[i]);
    // 這一站搜尋時用的時間範圍，看書籤的收集紀錄；沒有紀錄就不知道，不依日期分組
    r.range = (logs[r.domain] && logs[r.domain].r) || '';
    r.age = ageDays(r.date, todayParts());
    r.stale = isStale(r.date, r.range, todayParts());
    results.push(r);
    const mark = r.state === 'confirmed'
      ? (r.stale ? '正文命中，但日期早於搜尋範圍 (' : '正文命中 (') + r.hits.map((h) => h.kw).join(', ') + ')'
      : r.state === 'chrome' ? '只在導覽列'
      : r.state === 'absent' ? '找不到關鍵字'
      : '無法檢查 — ' + r.reason;
    // 理事會文件不在這裡標語言：同一份文件後面可能還有英文版，合併後才知道放哪一區
    const extra = (r.date ? '［' + r.date + '］' : '') +
      (sectionOf(r) === 'foreign' && !councilDocKey(r.url)
        ? '（非英文：' + (r.lang || urlLang(r.url)) + '，歸到「其他」）' : '');
    console.log(mark + (extra ? ' ' + extra : ''));
  }

  const meta = {
    generatedAt: new Date().toLocaleString('zh-TW', { hour12: false }),
    total: urls.length,
    source: path.basename(input),
    coverage,
  };
  fs.writeFileSync(output, renderHtml(results, meta), 'utf8');

  // 計數用合併後的筆數，跟報告、網頁版一致
  const shown = groupCouncilDocs(results);
  const n = (s) => shown.filter((r) => sectionOf(r) === s).length;
  console.log('\n正文確認 ' + n('confirmed') +
              '　日期較舊 ' + n('stale') +
              '　找不到關鍵字 ' + n('absent') +
              '　無法檢查 ' + n('unknown') +
              '　其他 ' + (n('chrome') + n('foreign')) +
              '（只在導覽列 ' + n('chrome') + '、非英文 ' + n('foreign') + '）');
  console.log('已寫出：' + path.resolve(output));

  // 給 CI 用的機器可讀摘要，不用去解析上面那行人看的文字。
  // 不含網址／標題等內容——那些已經在 HTML 報告裡，這裡只給數字。
  if (summaryJsonPath) {
    fs.writeFileSync(summaryJsonPath, JSON.stringify({
      total: urls.length,
      confirmed: n('confirmed'),
      stale: n('stale'),       // 正文命中、但頁面日期早於搜尋範圍
      absent: n('absent'),
      unknown: n('unknown'),
      chrome: n('chrome'),     // 英文頁面裡只在導覽列的
      foreign: n('foreign'),   // 非英文頁面（不論判定）
      other: n('chrome') + n('foreign'),
      generatedAt: meta.generatedAt,
      incomplete: !coverage.every((c) => c.ok),
      coverage: coverage.map((c) => (c.ok ? '✓ ' : '⚠ ') + c.name + '：' + c.text),
    }, null, 2), 'utf8');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
