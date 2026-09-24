#!/usr/bin/env node
//
// keyword-test.js — 關鍵字比對規則的測試。不連網、零依賴。
//
// 用法：  node keyword-test.js
//
// 比對規則（keywordPattern／countKeyword）在 index.html 和 verify.js 各有一份，
// 兩邊必須一模一樣。這裡從兩個檔案各自抽出那幾個函式，用同一批案例跑，
// 任何一邊答錯、或兩邊答案不一樣，都會 exit 1。規則為什麼長這樣見 README「比對規則」。

'use strict';

const fs = require('fs');
const path = require('path');

// 從原始碼抽出一個 function 宣告（數大括號找到結尾）
function extract(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('找不到 ' + name);
  let depth = 0;
  let i = src.indexOf('{', start);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) break;
  }
  return src.slice(start, i + 1);
}

function load(file) {
  const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
  const body = ['escapeRegExp', 'keywordPattern', 'countKeyword'].map((n) => extract(src, n)).join('\n');
  return new Function(body + '\nreturn { countKeyword: countKeyword };')();
}

const impls = { 'index.html': load('index.html'), 'verify.js': load('verify.js') };

const cases = [
  // [關鍵字, 文字, 預期次數, 說明]
  ['NATO', 'NATO jets had to shoot down a Russian drone', 1, '字首是 NATO'],
  ['NATO', 'Deputy Emergency Relief Coordinator, UN OCHA', 0, 'Coordinator 不算（2026-09-24 實例）'],
  ['NATO', 'Senator Smith said', 0, 'Senator 不算'],
  ['NATO', 'anti-NATO protests', 1, '連字號後面算字首'],
  ['NATO', "NATO's summit", 1, '所有格'],
  ['NATO', '(NATO)', 1, '括號'],
  ['NATO', 'NATO NATO,NATO', 3, '連續出現，吃掉前導字元不影響計數'],
  ['drone', 'drone strikes and drones', 2, '後面可以接字母'],
  ['cables', 'el cable submarino Ella, de 6.000 km', 1, 'cables 也算 cable（2026-09-24 實例）'],
  ['cables', 'undersea cables were cut', 1, '複數本身'],
  ['cables', 'applicable law', 0, 'applicable 不算 cable'],
  ['Indo-Pacific partners', 'our Indo-Pacific partner Japan', 1, '片語最後一個字的複數'],
  ['Congress', 'the Congress met', 1, '-ss 結尾不砍'],
  ['status', 'the status quo; a statue', 1, '-us 結尾不砍（不會變成 statu 去命中 statue）'],
  ['news', 'latest news, new policy', 1, '去掉 s 不到 4 個字母不砍（不會變成 new）'],
  ['arms', 'arms sales; the army', 1, '同上（不會變成 arm 去命中 army）'],
  ['Philippines', 'the Philippine coast guard', 1, 'Philippines 也算 Philippine'],
  ['台灣', '關於台灣的報導', 1, '非英文關鍵字不加字首限制'],
  ['the Indo-Pacific', 'security in the Indo-Pacific, and', 1, '片語'],
  ['Chinese', 'the Indochinese peninsula', 0, 'Indochinese 不算'],
  ['Chinese', 'Chinese-made drones', 1, '後面接連字號'],
  ['PRC', "the PRC's position", 1, '縮寫'],
  ['Taiwan Strait', 'across the Taiwan Strait.', 1, '片語'],
  ['cross-Strait', 'cross-Strait relations', 1, '連字號片語'],
  ['Beijing', 'Beijing', 1, '文字開頭'],
  ['South China Sea', 'in the South China Sea', 1, '片語'],
];

let fail = 0;
for (const [kw, text, want, why] of cases) {
  const got = Object.entries(impls).map(([f, m]) => [f, m.countKeyword(text, kw)]);
  const ok = got.every(([, n]) => n === want);
  if (!ok) fail++;
  console.log((ok ? 'OK  ' : 'FAIL') + '  ' + kw.padEnd(22) + ' 預期 ' + want + '  ' +
    got.map(([f, n]) => f + '=' + n).join(' ') + '   ' + why);
}
console.log('\n' + (cases.length - fail) + '/' + cases.length + ' 通過' + (fail ? '，' + fail + ' 失敗' : ''));
process.exit(fail ? 1 : 0);
