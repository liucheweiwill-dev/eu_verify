# CLAUDE.md

本檔給 Claude Code 及**任何**在此 repo 工作的 AI Agent（Codex 等同樣適用）。
細節與實測數字在 `README.md`；這裡只列「不照做就會出事」的約束，以及它們為什麼存在。

## 這個 repo 是什麼

EU／NATO 輿情蒐集的「搜尋 → 收集 → 驗證」一整頁。驗證的是：Google 回的結果，
關鍵字**真的在正文裡**，還是**只在全站導覽列裡**。

姊妹 repo [eu_monitor](https://github.com/liucheweiwill-dev/eu_monitor) 是每天按的那顆鈕，
刻意保持單檔、零依賴、零第三方——這裡壞掉不應該影響它，所以兩者是分開的程式。
**eu_monitor／eu_verify／NewsSearch 三個 repo 不要合併。**

## 決定一切的一句話

**漏掉（recall）比抓錯（precision）嚴重得多。** 使用者分不出「今天真的只有三則」
和「你只給我看了三則」，而後者正是最不能接受的失敗。由此而來：

- **「無法檢查」≠「未命中」。** 抓不到、被擋、網域不在設定裡的頁，一律歸「無法檢查」並寫出理由。
  不可以算成沒命中，也不可以默默丟掉。
- **「不知道」≠「沒問題」。** 收集狀況只有兩種：✓（確定收完）和 ⚠（其他一切）。
  沒有收集紀錄一律 ⚠。不要加一個看起來無害的「中性」狀態。
- **這是精確度工具，不是召回工具。** 它只能從 Google 給的清單裡剔除假命中，
  不可能知道漏了什麼。不要加任何讓它看起來像在保證完整的字眼或功能。
- 不加自動摘要、自動評分、自動過濾；不把判讀交給 LLM。

## 看起來像沒寫好、其實是刻意的

| 約束 | 為什麼 |
|---|---|
| 判定是「候選頁命中數**超過**同站 404 頁的命中數」，不是直接 grep | 導覽列的字就在每一頁的 HTML 裡，直接 grep 會重犯 Google 的錯 |
| `sites.json` 的 `baselineProbePath` 是固定字串 | 404 頁內容會隨探測路徑微幅變動，換成時間戳會讓基準線每次差 ±1（2026-09-23 實測） |
| 網頁版③經 r.jina.ai 抓取時帶 `X-Return-Format: html` | 預設的 Markdown 模式會吃掉部分命中，基準線與候選頁就不是同一種比法 |
| 抓到 0 筆就大聲失敗：`extract.js` exit 1、`run.cmd` 停下且不覆蓋舊清單、Actions 留言後中止 | Google 改版會弄壞擷取；「安靜地少回幾筆」正是 Google Alerts 被否決的原因 |
| 「貼上並比對」讀不到剪貼簿就停下，不改用框裡的內容 | 框裡可能是上一輪的資料，跑出來會被誤認成這一輪的結果 |
| 「複製正文確認清單」結尾一定附上未列入的筆數與收集狀況 | 清單會被貼到別處，讀的人看不到這頁；不附的話別人會以為那就是全部 |
| Google 的 sitelinks 照收、不排除 | 只會讓清單多幾筆（精確度）；要排除就得寫規則，規則一錯就是漏（召回） |
| 頁尾的「判讀提醒」 | 從 eu_monitor 整段搬來，是它 AGENT_BRIEF §6 的不可破壞約束之一 |
| 關鍵字全空時退化成純 `site:` 查詢 | 是功能不是邊界情況：「這站這段期間所有新東西」。`buildQuery` 的契約與 eu_monitor 一字不差 |
| 時間範圍預設「過去一週」 | Google 收錄有延遲，「過去 24 小時」會漏掉昨天發布、今天才被收錄的文章 |
| `localStorage` 一律包 try/catch | 瀏覽器限制儲存時（例如 `file://`）會直接拋例外，沒包的話整頁失效 |

## 同一件事寫在好幾個地方：改一處就要改全部

沒有建置步驟，書籤又跑在 google.com 上、讀不到這個 repo 的檔案，所以下面這些都是**手動同步**。
漏改一處不會報錯，只會讓幾條路講不一樣的話。

| 改什麼 | 要一起改的地方 |
|---|---|
| 站台網域 | `sites.json`、`extract.js` 的 `TARGETS`、`bookmarklet.html` 的 `TARGETS`、eu_monitor `index.html` 的 `SITES` |
| 預設關鍵字 | `sites.json` ↔ eu_monitor `index.html` 的 `SITES` |
| 判定邏輯 | `index.html`（網頁版）和 `verify.js`（`run.cmd` 與 Actions 共用）**各有一份實作** |
| 收集狀況的 ✓／⚠ 規則 | `index.html`、`verify.js`，以及書籤面板（`bookmarklet.html` 的 `renderSummary`） |
| `#euv` 收集紀錄格式 | `bookmarklet.html` 產生；`index.html`、`extract.js`、`verify.js` 讀。紀錄行不能含 `http(s)://`，否則會被當成網址擷取 |
| 書籤版本號 | `bookmarklet.html` 的 `VERSION`、同一頁的按鈕文字與說明、`index.html` ② 的「收集器 v2」提示 |

另外兩件容易踩的：

- **localStorage key `eu-nato-monitor-v2` 與 eu_monitor 共用**（兩頁同源）。在任一頁改關鍵字，兩邊都生效；
  改了 key 兩邊就脫鉤。也因為存過的值會蓋掉檔案裡的預設值，**預設值漂移很難從畫面上發現**——改預設時兩個 repo 都要改。
- **關鍵字不要隨手改。** 每個字為什麼長這樣（哪些被導覽列污染、哪些片語零命中會退回裸字）
  見 eu_monitor 的 `CLAUDE.md` 與 `docs/AGENT_BRIEF.md` §10。consilium 的 `kw` 沒有證據之前不要動。

## 書籤（bookmarklet.html）

- **程式碼存在使用者的書籤裡。** 更新安裝頁不會改到已經裝好的那顆。改了書籤就要升版本號（見上表），
  並請使用者刪掉舊的、重新拖一次。
- **只連 google.com。** 安裝頁對使用者這樣承諾。要加任何其他連線（例如把 `/goto` 加密連結交給 r.jina.ai 解開），
  先問使用者，並同步改安裝頁的說明。
- **遇到 Google 人機驗證必須立刻停下**，保留已收到的頁，在面板和紀錄上寫明。**不得繞過。**
- 自動翻頁（每頁停 1.5 秒、最多 5 頁）是程式代使用者向 Google 發查詢，使用者知情後才選的（2026-09-23）。
  不要加大頁數、縮短間隔，或擴大成「由程式發第一次查詢」。
- 自動化瀏覽器上的 Google 會回 `/goto?url=…` 加密連結，而且幾分鐘約 15 次查詢就出人機驗證頁。
  測書籤請用模擬的結果頁，不要對真的 Google 反覆測。

## 安全

- **DOM**：使用者內容一律 `textContent`／`createElement`。已經用 `innerHTML` 組字串的地方
  （`index.html` 的結果區、`verify.js` 的報告），每個插入的值都先 `escapeHtml`。
  書籤面板跑在別人的網域上，全用 `textContent`。
- **結果連結的 href**：安全靠擷取時只放行 `http(s)` 加目標網域（`index.html` 的 `normalise`、`extract.js`）。
  `escapeHtml` 擋不住 `javascript:` 網址。`verify.js` 本身不檢查協定，所以 Actions 一定要先過 `extract.js`。
- **Actions**（`.github/workflows/verify.yml`）：
  - issue 內文與手動輸入**一律經 `env:` 傳**，不要用 Actions 運算式直接內插進 `run:`——那是 GitHub Actions 最常見的注入手法。
  - `actions/checkout` 要 `ref: main`。預設會 checkout 事件當下的舊 commit，兩次執行接連發生時，後一次會 push 失敗（2026-09-23 實測）。
  - 不要監聽 `labeled`。帶標籤建立 issue 會讓 `opened`、`labeled` 各觸發一次。
  - issue 觸發只限 repo owner 開、且帶 `verify-request` 標籤。repo 是公開的，拿掉這個檢查，任何人都能動用 Actions 額度。

## run.cmd

- **必須純 ASCII。** `chcp 65001` 加上檔案裡有多位元組字元，cmd.exe 會算錯位置、執行到半行指令。中文訊息一律交給 node 印。
- **不可用 `TMP`／`TEMP`／`PATH`／`CD` 當變數名。** 它們是真的 Windows 環境變數，曾經差點變成刪掉系統 Temp 目錄。
- 行尾由 `.gitattributes` 強制 CRLF，不要拿掉。

## 技術約束與部署

| 項目 | 規定 |
|---|---|
| 依賴 | 零。Node 18+ 內建 `fetch`，不用 `npm install` |
| 建置 | 無，GitHub Pages 直接發布 repo 裡的檔案 |
| 第三方 | 只有網頁版③經 r.jina.ai；①②、`run.cmd`、Actions 都不經第三方 |
| 部署 | GitHub Pages，`main` 分支根目錄，push 即上線 |

要加依賴、建置步驟或新的第三方服務，先問使用者。

- **未經使用者授權不得 push**，每一次都要問。
- **Actions 跑完會 commit `latest-report.html` 到 main**（作者 github-actions[bot]）。所以本機 push 前先 `git pull --rebase`；
  `latest-report.html` 不要手改，下次執行就會被蓋掉。
- repo 是公開的，Pages 也會把 `.md` 發布成網頁。交接紀錄、session 筆記、個人資料不要放進 repo。

## 不要重試的（證據在 README 與 eu_monitor 的 AGENT_BRIEF）

| 想法 | 實測結果 |
|---|---|
| Google `&num=100` 一頁顯示全部 | 已不支援，照樣 10 筆一頁 |
| 三站合成一條查詢、只開一個分頁 | 「約有 0 項結果」，靜默失效、沒有警告 |
| `intext:`／`allintext:` 只搜正文 | 失效，是把查詢打壞，不是過濾 |
| 瀏覽器直接 `fetch()` eeas／nato | CORS 擋死，兩站都沒送 `Access-Control-Allow-Origin` |
| 其他免費 CORS proxy | 2026-09-23 測了 6 個，只剩 r.jina.ai 能用 |
| 用任何自動化方式抓 consilium | curl、會執行 JS 的自動化瀏覽器、Jina 都過不去 |
| 讓程式自己發 Google 查詢 | 幾分鐘約 15 次就出人機驗證頁，而且不得繞過 |

## 改完之後

```bash
node verify.js urls.txt -o regression.out.html   # 已知答案，應為「正文確認 2　只在導覽列 2　無法檢查 1」
```

收集狀況三站都是 ⚠ 是正常的（`urls.txt` 沒有收集紀錄）。
**一定要用 `-o` 另存。** 不指定時會寫到 `search_result.html`，那是 `run.cmd` 給使用者看的報告，
會把使用者最近一次的真實結果蓋掉。`*.out.html` 已在 `.gitignore`。
`-o` 不要寫 `/dev/null`——Windows 上會在當前目錄產生一個叫 `nul` 的檔案。

動到 `index.html`／`bookmarklet.html` 的 script，確認語法能解析；動到預設關鍵字，確認兩個 repo 一致
（假設兩個 repo 放在同一層目錄）：

```bash
node -e "
const fs=require('fs');for(const f of ['index.html','bookmarklet.html']){const h=fs.readFileSync(f,'utf8');
[...h.matchAll(/<script>([\s\S]*?)<\/script>/g)].forEach(m=>{try{new Function(m[1]);console.log('OK   '+f)}catch(e){console.log('FAIL '+f+': '+e.message)}})}"

node -e "
const fs=require('fs');const m=fs.readFileSync('../eu_monitor/index.html','utf8');
const M=eval(m.match(/var SITES = (\[[\s\S]*?\]);/)[1]);const V=JSON.parse(fs.readFileSync('sites.json','utf8')).sites;
M.forEach((s,i)=>console.log((s.domain===V[i].domain&&s.kw===V[i].kw&&s.name===V[i].name?'OK   ':'DIFF ')+s.domain))"
```
