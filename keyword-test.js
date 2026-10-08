#!/usr/bin/env node
//
// keyword-test.js — 判定規則的測試。不連網、零依賴。
//
// 用法：  node keyword-test.js
//
// 關鍵字比對（keywordPattern／countKeyword）、PDF 判斷（isPdfUrl）、理事會文件合併
// （councilDocKey／groupCouncilDocs）、日期提示（firstDate）、語言與分區（pageLang／urlLang／
// sectionOf）在 index.html 和 verify.js 各有一份，兩邊必須一模一樣。
// 這裡從兩個檔案各自抽出那幾個函式，用同一批案例跑，任何一邊答錯、或兩邊答案
// 不一樣，都會 exit 1。規則為什麼長這樣見 README「比對規則」。

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

// 從原始碼抽出一個變數宣告（`NAME = ` 之後：物件就數大括號，其他取到行尾）
function extractVar(src, name) {
  const at = src.search(new RegExp('(var|const) ' + name + ' = '));
  if (at < 0) throw new Error('找不到 ' + name);
  const start = src.indexOf('=', at) + 2;
  let end;
  if (src[start] === '{') {
    let depth = 0;
    for (end = start; end < src.length; end++) {
      if (src[end] === '{') depth++;
      else if (src[end] === '}' && --depth === 0) break;
    }
    end++;
  } else {
    end = src.indexOf('\n', start);
  }
  return 'var ' + name + ' = ' + src.slice(start, end).replace(/;\s*$/, '') + ';';
}

const VARS = ['DATE_RE', 'STOPWORDS'];
const FNS = ['escapeRegExp', 'keywordPattern', 'countKeyword', 'isPdfUrl', 'councilDocKey', 'groupCouncilDocs',
  'datesIn', 'firstDate', 'stopwordCounts', 'declaredLang', 'pageLang', 'urlLang', 'sectionOf'];

function load(file) {
  const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
  const body = VARS.map((n) => extractVar(src, n)).concat(FNS.map((n) => extract(src, n))).join('\n');
  return new Function(body + '\nreturn { ' + FNS.map((n) => n + ': ' + n).join(', ') + ' };')();
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
let total = 0;
for (const [kw, text, want, why] of cases) {
  const got = Object.entries(impls).map(([f, m]) => [f, m.countKeyword(text, kw)]);
  const ok = got.every(([, n]) => n === want);
  total++;
  if (!ok) fail++;
  console.log((ok ? 'OK  ' : 'FAIL') + '  ' + kw.padEnd(22) + ' 預期 ' + want + '  ' +
    got.map(([f, n]) => f + '=' + n).join(' ') + '   ' + why);
}

// ---- PDF 判斷與理事會文件合併 ----
// 每一案：[說明, 函式名, 參數, 預期結果]；兩份實作都要給出跟預期一模一樣的結果。
const DOC = 'https://data.consilium.europa.eu/doc/document/ST-13528-2026-INIT/';
const r = (url) => ({ url: url, state: 'unknown', reason: 'x' });
const structural = [
  ['理事會 PDF（/pdf 結尾）', 'isPdfUrl', [DOC + 'en/pdf'], true],
  ['.PDF 結尾（大小寫不拘）', 'isPdfUrl', ['https://www.eeas.europa.eu/sites/default/files/a.PDF'], true],
  ['一般網頁', 'isPdfUrl', ['https://www.eeas.europa.eu/eeas/foo_en'], false],
  ['路徑中間有 pdf 不算', 'isPdfUrl', ['https://www.nato.int/pdfs/foo.htm'], false],
  ['理事會文件的編號與語言', 'councilDocKey', [DOC + 'DE/pdf'], { id: 'ST-13528-2026-INIT', lang: 'de' }],
  ['www.consilium 的網頁不是文件', 'councilDocKey', ['https://www.consilium.europa.eu/en/policies/sanctions-against-russia/'], null],
  ['同一份文件的三種語言合併成一筆，en 排第一、其他照原順序；別的網址原樣留著',
    'groupCouncilDocs',
    [[r('https://www.eeas.europa.eu/a_en'), r(DOC + 'de/pdf'), r(DOC + 'en/pdf'),
      r('https://data.consilium.europa.eu/doc/document/PE-46-2026-INIT/ro/pdf'), r(DOC + 'fr/pdf')]],
    [r('https://www.eeas.europa.eu/a_en'),
      Object.assign(r(DOC + 'en/pdf'), {
        docId: 'ST-13528-2026-INIT',
        langs: [{ lang: 'en', url: DOC + 'en/pdf' }, { lang: 'de', url: DOC + 'de/pdf' }, { lang: 'fr', url: DOC + 'fr/pdf' }],
        lang: 'en',
        title: 'ST-13528-2026-INIT（理事會文件，3 種語言）',
      }),
      Object.assign(r('https://data.consilium.europa.eu/doc/document/PE-46-2026-INIT/ro/pdf'), {
        docId: 'PE-46-2026-INIT',
        langs: [{ lang: 'ro', url: 'https://data.consilium.europa.eu/doc/document/PE-46-2026-INIT/ro/pdf' }],
        lang: 'ro',
        title: 'PE-46-2026-INIT（理事會文件）',
      })]],

  // ---- 日期提示：第一個不在 404 頁上的日期 ----
  ['EEAS：跳過導覽列的 14 July 2015，取標題下的文章日期，不取頁尾「相關報導」較新的日期',
    'firstDate', ['Menu JCPOA in Vienna on 14 July 2015 Title 22.09.2026 Speech on 22 September 2026 STORY 05.10.2026',
      ['14 july 2015']], '22.09.2026'],
  ['頁面上沒有日期', 'firstDate', ['no date here, only 2026 and 15 countries 2026', []], ''],
  ['法文月份', 'firstDate', ['publié le 23 septembre 2026 à Bruxelles', []], '23 septembre 2026'],
  ['西班牙文月份（含 de）', 'firstDate', ['Bruselas, 22 de septiembre de 2026', []], '22 de septiembre de 2026'],
  ['美式寫法', 'firstDate', ['Washington, September 23, 2026 —', []], 'September 23, 2026'],
  ['縮寫月份加句點', 'firstDate', ['Event 23 Sep. 2026 Chicago', []], '23 Sep. 2026'],
  ['ISO 日期', 'firstDate', ['updated 2026-09-22T10:00', []], '2026-09-22'],
  ['404 頁的日期正規化成小寫、單一空白', 'datesIn', ['in Vienna on 14  July 2015.'], ['14 july 2015']],

  // ---- 語言 ----
  ['<html lang> 取主要語言', 'declaredLang', ['<html lang="es" dir="ltr" prefix="og: x">'], 'es'],
  ['en-GB 算 en', 'declaredLang', ['<html lang="en-GB">'], 'en'],
  ['單引號、lang 不在第一個', 'declaredLang', ["<html dir='ltr' lang='fr'>"], 'fr'],
  ['沒標語言', 'declaredLang', ['<html>'], ''],
  ['NATO /fr/ 網址的英文逐字稿：標示 fr，但英文常用字多出四千多個 → 算英文', 'pageLang',
    ['fr', { en: 4565, es: 7, fr: 208, de: 0 }, { en: 253, es: 7, fr: 0, de: 0 }], 'en'],
  ['EEAS 西班牙文頁：標示 es，正文也是西班牙文 → es', 'pageLang',
    ['es', { en: 366, es: 162, fr: 0, de: 0 }, { en: 366, es: 1, fr: 0, de: 0 }], 'es'],
  ['標示非英文、但扣完基準線全是 0（判斷不出來）→ 留在英文', 'pageLang',
    ['fr', { en: 200, es: 0, fr: 0, de: 0 }, { en: 366, es: 1, fr: 0, de: 0 }], 'en'],
  ['標示 en 一律英文', 'pageLang', ['en', { en: 0, es: 500, fr: 0, de: 0 }, null], 'en'],
  ['沒標語言一律英文', 'pageLang', ['', { en: 0, es: 500, fr: 0, de: 0 }, null], 'en'],
  ['理事會文件看網址的語言代碼', 'urlLang', ['https://data.consilium.europa.eu/doc/document/PE-46-2026-INIT/ro/pdf'], 'ro'],
  ['consilium 網頁看 /xx/ 路徑', 'urlLang', ['https://www.consilium.europa.eu/fr/press/press-releases/'], 'fr'],
  ['其他站的網址不猜語言', 'urlLang', ['https://www.eeas.europa.eu/eeas/foo_es'], ''],
  ['英文頁面照它的判定分區', 'sectionOf', [{ state: 'confirmed', lang: 'en', url: 'https://www.eeas.europa.eu/a_en' }], 'confirmed'],
  ['非英文頁面一律「其他」，就算有正文命中', 'sectionOf', [{ state: 'confirmed', lang: 'es', url: 'https://www.eeas.europa.eu/a_es' }], 'foreign'],
  ['沒抓頁面的非英文理事會文件也歸「其他」', 'sectionOf', [{ state: 'unknown', url: 'https://data.consilium.europa.eu/doc/document/PE-46-2026-INIT/ro/pdf' }], 'foreign'],
  ['語言不明的無法檢查留在主列表', 'sectionOf', [{ state: 'unknown', url: 'https://www.nato.int/fr/x' }], 'unknown'],
];

// 比較時不管欄位順序
const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.keys(x).sort().reduce((o, key) => { o[key] = x[key]; return o; }, {}) : x));

for (const [why, fn, args, want] of structural) {
  const got = Object.entries(impls).map(([f, m]) => [f, canon(m[fn].apply(null, args))]);
  const ok = got.every(([, g]) => g === canon(want));
  total++;
  if (!ok) fail++;
  console.log((ok ? 'OK  ' : 'FAIL') + '  ' + fn.padEnd(22) + ' ' + why +
    (ok ? '' : '\n        預期 ' + canon(want) + '\n' + got.map(([f, g]) => '        ' + f + ' ' + g).join('\n')));
}

console.log('\n' + (total - fail) + '/' + total + ' 通過' + (fail ? '，' + fail + ' 失敗' : ''));
process.exit(fail ? 1 : 0);
