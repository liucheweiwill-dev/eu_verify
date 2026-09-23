#!/usr/bin/env node
//
// extract.js — 從 Google 結果頁（或一段文字）裡挑出目標站的網址。
//
// 用法：
//   node extract.js saved1.html saved2.html      # 解析 Ctrl+S 存下來的結果頁
//   node extract.js --text clip.txt              # 解析一段純文字（例如剪貼簿內容）
//
// 印出去重後的網址，一行一個。**抓到 0 筆會以 exit code 1 結束**——
// 這是刻意的：Google 改版時要大聲失敗，不可以安靜地少回幾筆。
//
// 零依賴。

'use strict';

const fs = require('fs');

// 只收這幾個站的網址。跟 verify.js 的 SITES 一致。
const TARGETS = ['eeas.europa.eu', 'consilium.europa.eu', 'nato.int'];

function isTarget(host) {
  return TARGETS.some((d) => host === d || host.endsWith('.' + d));
}

// Google 有時候用 /url?q=<真正網址> 包一層
function unwrapGoogle(u) {
  try {
    const parsed = new URL(u);
    if (/(^|\.)google\./.test(parsed.hostname) && parsed.pathname === '/url') {
      const inner = parsed.searchParams.get('q') || parsed.searchParams.get('url');
      if (inner) return inner;
    }
  } catch (e) { /* 不是合法網址就原樣放回去 */ }
  return u;
}

function normalise(raw) {
  let u = unwrapGoogle(raw.trim());
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    if (!isTarget(parsed.hostname)) return null;
    parsed.hash = '';
    // Google 常掛的追蹤參數，去掉以免同一頁重複出現
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']
      .forEach((p) => parsed.searchParams.delete(p));
    return parsed.toString();
  } catch (e) {
    return null;
  }
}

// 從任意文字裡撈出 http(s) 網址。
// 對存檔的 HTML 也適用——href="..." 裡的網址一樣會被這個規則撈到。
function harvest(text) {
  const found = [];
  const re = /https?:\/\/[^\s"'<>\\)\]]+/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    // 去掉常見的結尾標點
    const cleaned = m[0].replace(/[.,;:!?]+$/, '');
    const n = normalise(cleaned);
    if (n) found.push(n);
  }
  return found;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    console.error('用法：node extract.js <檔案...>   或   node extract.js --text <檔案>');
    process.exit(2);
  }

  const files = argv.filter((a) => a !== '--text');
  const all = [];
  const logLines = [];
  let read = 0;

  for (const f of files) {
    if (!fs.existsSync(f)) {
      console.error('找不到檔案：' + f);
      continue;
    }
    const text = fs.readFileSync(f, 'utf8');
    all.push(...harvest(text));
    // 書籤 v2 附的收集紀錄行（#euv ...）原樣傳下去，給 verify.js 判斷
    // 每一站有沒有收完所有頁。這些行不含 http(s)://，不會被當成網址。
    text.split(/\r?\n/).forEach((l) => {
      const t = l.trim();
      if (/^#euv\s/.test(t) && logLines.indexOf(t) < 0) logLines.push(t);
    });
    read++;
  }

  if (read === 0) {
    console.error('沒有讀到任何檔案。');
    process.exit(2);
  }

  const unique = [...new Set(all)];

  if (unique.length === 0) {
    console.error('抓到 0 筆目標站網址。');
    console.error('可能原因：剪貼簿／存檔裡沒有 eeas、consilium、nato 的結果，');
    console.error('或是 Google 改版了。請先自己看一眼再決定，不要當成「今天沒東西」。');
    process.exit(1);
  }

  logLines.forEach((l) => console.log(l));
  unique.forEach((u) => console.log(u));
  console.error('抓到 ' + unique.length + ' 筆' +
    (logLines.length ? '，附收集紀錄 ' + logLines.length + ' 站。' : '（沒有收集紀錄——舊版書籤或手動貼上）。'));
}

main();
