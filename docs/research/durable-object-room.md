# 研究：用 Durable Object 當房間的即時中樞，對校時與延遲的影響

對應 issue：[#4](https://github.com/yurenju/turca/issues/4)。查證日期：2026-09-26。只用一手來源（Cloudflare 官方文件、官方 changelog、workerd 原始碼）。

## 前提

`initial-research.md` 第 4 節打算讓每個**房間**對應一個 Cloudflare Durable Object（以下簡稱 DO：Cloudflare 上一種「有固定身分、單執行緒、自帶儲存」的 Worker，同一個名字在全世界只會有一個實體在跑）。它負責三件事：轉送 WebSocket 訊息、當校時的基準、記住各**座位**的狀態。

校時的做法類似 NTP：座位送出自己的時間 t0，伺服器記下收到的時間 t1、回覆的時間 t2，座位收到時是 t3；往返延遲是 (t3 − t0) − (t2 − t1)，時差估計是 ((t1 − t0) + (t2 − t3)) / 2。量很多次、只留往返最短的幾次。這個做法要成立，需要兩件事：伺服器讀得到一個夠準的時鐘，而且去程和回程的耗時大致對稱。

幾個名詞：

- **休眠（hibernation）**：DO 閒置時被移出記憶體，但它接受的 WebSocket 連線不會斷；下一則訊息進來時重新執行 constructor 再處理。
- **Hibernation WebSocket API**：用 `ctx.acceptWebSocket()` 接受連線、用 `webSocketMessage()` 收訊息的那組 API；只有用這組，DO 才能在連線還開著時休眠。
- **location hint**：建立 DO 時可以給的「希望放在哪一區」的提示。
- **I/O**：網路請求、儲存讀寫、收到一則新訊息這類「等外部」的事件。

## 結論

**DO 可以當校時基準，但不能把它當成一台一般的 NTP 伺服器來寫。** `Date.now()` 在部署後只在 I/O 發生時才前進，每則訊息進來時會重新對一次時，所以在 `webSocketMessage()` 開頭讀到的就是「這則訊息開始被處理的時間」，精度是毫秒；伺服器的 t1 和 t2 會是同一個值，這對 NTP 式的算法沒有壞處。會造成誤差的是另外三件事：訊息在 DO 裡排隊的時間、從休眠醒來時 constructor 的執行時間、以及 DO 換機器時時鐘跳動，三者都會讓去回程不對稱，只能靠「只取往返最短的幾次」和持續重新估計來壓。連線數、訊息大小、每秒訊息數都遠遠用不完。**免費方案夠做 prototype，但能不能撐小規模公開使用，取決於一個官方文件沒寫清楚的點**：「20 則收到的 WebSocket 訊息算 1 次請求」這條規則是否也適用免費方案的每日 100,000 次上限。

## 重點發現

### 1. `Date.now()` 只在 I/O 後前進，毫秒精度；精細計時的開關是實驗性的、不能部署

- 官方文件：部署到 Cloudflare 後，`Date.now()` 與 `performance.now()` 都「只在 I/O 發生之後才前進」，一段純計算前後讀到的值完全相同；`performance.timeOrigin` 固定是 0。本機用 wrangler 開發時則不凍結，會照常前進。[Performance and timers](https://developers.cloudflare.com/workers/runtime-apis/performance/)、[Security model — Step 1](https://developers.cloudflare.com/workers/reference/security-model/#step-1-disallow-timers-and-multi-threading)
- workerd 原始碼：每一個送進 DO（原始碼裡叫 actor）的請求在開始處理時都會呼叫 `syncTime()` 重新對時，然後才執行 constructor（如果需要）與處理函式。[io-context.c++ L281–L289](https://github.com/cloudflare/workerd/blob/1481f440b0dc69fee8dcfd2e1995fac5f88f2f88/src/workerd/io/io-context.c++#L281-L289)。Hibernation API 的每一則 WebSocket 訊息也是用同一條路徑送進來的（[hibernatable-web-socket.c++ L45–L53](https://github.com/cloudflare/workerd/blob/1481f440b0dc69fee8dcfd2e1995fac5f88f2f88/src/workerd/api/hibernatable-web-socket.c%2B%2B#L45-L53)）。
- workerd 原始碼裡有一個 `precise_timers` 旗標，開了之後 `Date.now()` 會讀真正的系統時鐘，捨入到 3 毫秒。[io-context.c++ L1057–L1069](https://github.com/cloudflare/workerd/blob/1481f440b0dc69fee8dcfd2e1995fac5f88f2f88/src/workerd/io/io-context.c++#L1057-L1069)。但它被標為 `$experimental`（[compatibility-date.capnp L1261–L1266](https://github.com/cloudflare/workerd/blob/1481f440b0dc69fee8dcfd2e1995fac5f88f2f88/src/workerd/io/compatibility-date.capnp#L1261-L1266)），而同一個檔案寫明實驗性旗標「除了 Cloudflare 員工的測試帳號，不能用在部署到 Cloudflare 的 Worker」（[L66–L71](https://github.com/cloudflare/workerd/blob/1481f440b0dc69fee8dcfd2e1995fac5f88f2f88/src/workerd/io/compatibility-date.capnp#L66-L71)）。官方的相容旗標文件沒有列出它。**所以我們不能靠它。**

**對校時的影響**：

- 在 `webSocketMessage()` 開頭讀 `Date.now()`，得到的是這則訊息開始處理的時間，可以直接當 t1；處理過程不做 I/O 的話，回覆前再讀一次還是同一個值，所以 t2 = t1。NTP 式算法本來就把 (t2 − t1) 扣掉，這不會產生誤差。
- 真正的誤差來源是：時間在「開始處理」那一刻凍結，但訊息實際送出是處理完之後。處理本身若只花零點幾毫秒，影響可以忽略；若處理函式很重、或剛從休眠醒來要先跑 constructor（constructor 在對時之後才執行），這段時間會全部算到回程，造成去回程不對稱。**校時訊息的處理要盡量短，constructor 要盡量輕。**
- 另一個誤差來源是排隊：DO 是單執行緒，如果前一則訊息還在處理，校時訊息要等；這段等待發生在對時之前，會全算到去程。「只取往返最短的幾次」可以濾掉大部分。
- 本機開發時時鐘不凍結，行為和線上不同，校時邏輯要在部署後的環境驗證。

### 2. 伺服器時鐘本身準不準：官方沒有數字

- 官方文件沒有說明 DO 所在機器的系統時鐘和 UTC 的誤差範圍。我們其實不需要它對得準 UTC，只需要「同一個房間的所有座位都對同一個時鐘」。
- 但官方也寫明 DO 會「在健康的伺服器之間搬移」（[What are Durable Objects](https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/)），被完全逐出記憶體後也可能在別台機器上重新啟動（[Lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)）。換機器之後，基準時鐘可能跳一下，跳多少官方沒寫。

**對校時的影響**：座位端不能只在開場校一次，演奏中要持續重新估計時差，並且能察覺「時差突然變了一截」的情況，而不是把它平均進去。這個跳動的幅度需要實測。

### 3. 休眠：連線不會斷；演奏期間本來就不會休眠；自動回覆幫不了校時

- DO 在**所有**條件都成立、而且 10 秒內沒有任何請求或事件時才會休眠。條件包括：沒有 `setTimeout`／`setInterval`、沒有進行中的 `fetch()`、沒有用標準 WebSocket API（`ws.accept()`）、沒有對外的 TCP 或 WebSocket 連線。休眠時 WebSocket 連線保持開著，下一個事件來時重跑 constructor。[Lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)、[Use WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- 不符合休眠條件的 DO，閒置 70–140 秒後會被完全逐出。[Lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)
- 協定層的 ping frame 由執行環境自動回 pong，不會叫醒 DO；`setWebSocketAutoResponse()` 可以設定一組固定的「收到某字串就回某字串」，也不會叫醒 DO、不計費。[Use WebSockets — Automatic ping/pong](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)、[State API](https://developers.cloudflare.com/durable-objects/api/state/#setwebsocketautoresponse)
- **從休眠醒來要多久：官方文件沒有數字。**

**對校時與延遲的影響**：

- 自動回覆的內容是固定字串，不能帶伺服器時間；瀏覽器的 JavaScript 也送不出協定層的 ping frame。所以**校時訊息一定會進到 `webSocketMessage()`**，會叫醒 DO、會計費。
- 演奏時指揮端每秒送 20–30 次音量值，DO 永遠不會閒置 10 秒，不會休眠，不需要額外做什麼。要在「等待開始」這段也保持清醒，可以讓座位每幾秒送一則校時訊息；用 `setInterval` 也行，但它會讓 DO 進入「不能休眠」的狀態，閒置時間也照算時長費用。
- 休眠後的第一則訊息會多出喚醒時間，量到的往返會偏長，會被「只取最短幾次」自然濾掉；建議開演前先密集校一輪，讓 DO 醒著。

### 4. DO 放在哪、延遲大概多少

- 預設在「第一次 `get()` 的請求」附近的機房建立，不一定是同一個機房；**建好之後目前不會搬家**。location hint 只有第一次 `get()` 有效，而且只是盡力而為。可用的區域有 `wnam`、`enam`、`sam`、`weur`、`eeur`、`apac`、`apac-ne`、`apac-se`、`oc`、`afr`、`me`。[Data location](https://developers.cloudflare.com/durable-objects/reference/data-location/)
- 官方建議不要加 hint，除非真的需要，讓 DO 建在發起請求的附近延遲最低。[changelog 2026-06-19：apac-ne／apac-se](https://developers.cloudflare.com/changelog/post/2026-06-19-apac-ne-apac-se-location-hints/)
- 使用者的連線先到最近的 Cloudflare 機房跑 Worker，再轉到 DO 所在的機房。[Containers architecture — Worker to Durable Object](https://developers.cloudflare.com/containers/concepts/architecture/)
- **同一個 Wi-Fi 下四台裝置到 DO 的延遲範圍：官方沒有提供數字，查不到。** 官方 data location 頁連到的 where.durableobjects.live 是社群維護的網站，不算一手來源，沒有採用。

**對校時與延遲的影響**：讓指揮端開房時的那個請求去建立 DO（例如開房請求直接 `get()`），DO 就會落在指揮端附近；同一個 Wi-Fi 的座位走同一條網路出去，理論上到的是同一個入口機房，路徑相近。校時要的是往返「穩定且對稱」，不是絕對值低；絕對延遲影響的是「指揮端的手勢多久傳到座位」，因為要走 指揮端 → DO → 座位 兩段。實際數字要在台灣實測。

### 5. 連線數、訊息大小、每秒訊息數：遠遠用不完

| 項目 | 限制 | 來源 |
| --- | --- | --- |
| 每個 DO 的 WebSocket 連線（Hibernation API） | 32,768 條，實際受 CPU 與記憶體限制 | [State API — acceptWebSocket](https://developers.cloudflare.com/durable-objects/api/state/#acceptwebsocket) |
| 收到的 WebSocket 訊息大小 | 32 MiB（2025-10-31 從 1 MiB 調高） | [Limits](https://developers.cloudflare.com/durable-objects/platform/limits/)、[changelog](https://developers.cloudflare.com/changelog/post/2025-10-31-increased-websocket-message-size-limit/) |
| 每個 DO 每秒請求數 | 軟性上限約 1,000 次；超過會先排隊、再回 overloaded 錯誤 | [Limits — FAQ](https://developers.cloudflare.com/durable-objects/platform/limits/) |
| 每次請求（含每則 WebSocket 訊息）的 CPU 時間 | 預設 30 秒，可調到 5 分鐘 | [Limits](https://developers.cloudflare.com/durable-objects/platform/limits/) |
| 自動回覆字串長度 | 請求與回覆各 2,048 字元 | [State API](https://developers.cloudflare.com/durable-objects/api/state/#setwebsocketautoresponse) |

**對延遲的影響**：指揮端每秒 20–30 次，加上幾個座位每秒一次校時，是上限的百分之幾。官方提醒每則訊息都有固定的切換開銷，大量小訊息會拖慢 DO，建議把多個邏輯訊息打包成一個 frame（例如每 50–100 毫秒送一次）。[Use WebSockets — Batch messages](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)。我們的量不需要打包，但如果要省免費額度（見下一節），把音量值降到每秒 10 次左右、或每次打包多個聲部，是最直接的做法。

### 6. 免費方案與付費方案

| | 免費方案 | 付費方案（Workers Paid，月費最低 5 美元） |
| --- | --- | --- |
| DO 請求數 | 每天 100,000 次 | 每月 100 萬次，之後每百萬次 0.15 美元 |
| DO 時長 | 每天 13,000 GB-s | 每月 400,000 GB-s，之後每百萬 GB-s 12.50 美元 |
| 可用的 DO 種類 | 只能用 SQLite 儲存的 DO | 都可以 |
| Worker 請求（建立 WebSocket 會先經過 Worker） | 每天 100,000 次，每次 CPU 10 毫秒 | 無上限 |

來源：[DO Pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)、[Workers Limits](https://developers.cloudflare.com/workers/platform/limits/)。免費額度用完後，該類操作直接失敗；每天 00:00 UTC（台灣早上 8 點）重置。

怎麼算：

- 建立一條 WebSocket 算 1 次請求。DO 送出去的訊息、收到的協定層 ping 都**不收費**。收到的訊息以 **20 則算 1 次請求**。[DO Pricing 註 2](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- 用 Hibernation API 時，時長只算「真的在執行處理函式」的時間，閒置而可休眠的時間不算；時長固定按 128 MB 計。用 `ws.accept()` 或 `setInterval` 讓 DO 不能休眠，則整段連線時間都算。[DO Pricing 註 4、FAQ](https://developers.cloudflare.com/durable-objects/platform/pricing/#when-does-a-durable-object-incur-duration-charges)
- 自動回覆不計時長。[DO Pricing 註 3](https://developers.cloudflare.com/durable-objects/platform/pricing/)

粗估一個正在演奏的房間（指揮端每秒 25 則音量值，4 個座位各每秒 1 則校時，約每秒 30 則收到的訊息，一小時約 108,000 則）：

- **如果 20:1 適用免費方案**：一小時約 5,400 次請求，每天 100,000 次約可撐 **18 個「房間小時」**。
- **如果不適用**：一小時就是 108,000 次，**不到 1 個房間小時就用完當天額度**。
- 時長：假設每則訊息處理 1 毫秒，一小時約 108 秒 × 0.125 GB ≈ 13.5 GB-s，每天 13,000 GB-s 綽綽有餘。

⚠️ **查不到／來源不明確**：價格表把 20:1 的註腳掛在付費方案那一欄的說明文字裡，免費方案那一欄只寫「100,000 / day」，沒有說收到的 WebSocket 訊息怎麼算。這一點決定免費方案能撐 18 小時還是不到 1 小時，**要部署後看 dashboard 的用量實測，或去問 Cloudflare**。

**結論**：做 prototype 免費方案一定夠。小規模公開使用，如果 20:1 適用，一天十幾場演出沒問題；如果不適用，要把音量值降頻或改付費方案（以上面的量，付費方案一個房間小時約 108,000 / 20 = 5,400 次請求，每月 100 萬次內含額度約 185 個房間小時，超過的部分很便宜）。

## 對後續實作的建議

1. 用 Hibernation API（`ctx.acceptWebSocket()`），不要用 `ws.accept()`，也不要用 `setInterval` 保持清醒。
2. 校時訊息在 `webSocketMessage()` 最前面讀 `Date.now()`，處理完立刻回覆，中間不做儲存讀寫之類的 I/O；constructor 保持輕量。
3. 座位端持續校時、只取往返最短的幾次，並能偵測時差突然跳動（DO 換機器）。
4. 開房請求直接建立 DO，讓它落在指揮端附近；不加 location hint。
5. 部署後第一件事：量台灣的往返延遲與抖動、確認免費方案下 20:1 是否適用。

## 沒查到的事

- 從休眠醒來要多久：官方沒有數字。
- 同一個 Wi-Fi 下到 DO 的延遲範圍：官方沒有數字，要實測。
- DO 所在機器的時鐘準度、換機器時時鐘會跳多少：官方沒有說明。
- 免費方案的每日請求上限是否套用 20:1：文件沒寫清楚。

<details>
<summary>查證用到的原始資料</summary>

- Cloudflare 文件：[Performance and timers](https://developers.cloudflare.com/workers/runtime-apis/performance/)、[Security model](https://developers.cloudflare.com/workers/reference/security-model/)、[Durable Object Lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)、[Use WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)、[State API](https://developers.cloudflare.com/durable-objects/api/state/)、[Data location](https://developers.cloudflare.com/durable-objects/reference/data-location/)、[DO Limits](https://developers.cloudflare.com/durable-objects/platform/limits/)、[DO Pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)、[Workers Limits](https://developers.cloudflare.com/workers/platform/limits/)、[Compatibility flags](https://developers.cloudflare.com/workers/configuration/compatibility-flags/)、[Containers architecture](https://developers.cloudflare.com/containers/concepts/architecture/)、[What are Durable Objects](https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/)
- Cloudflare changelog：[2025-10-31 WebSocket 訊息上限 32 MiB](https://developers.cloudflare.com/changelog/post/2025-10-31-increased-websocket-message-size-limit/)、[2026-06-19 apac-ne／apac-se](https://developers.cloudflare.com/changelog/post/2026-06-19-apac-ne-apac-se-location-hints/)、[2026-06-19 對外連線讓 DO 保持清醒](https://developers.cloudflare.com/changelog/post/2026-06-19-outbound-connections-keep-dos-alive/)
- workerd 原始碼（commit `1481f440b0dc69fee8dcfd2e1995fac5f88f2f88`）：`src/workerd/io/io-context.c++`（`IncomingRequest::delivered()` 的 `syncTime()`、`IoContext::now()` 的 `preciseTimers` 分支）、`src/workerd/io/compatibility-date.capnp`（`preciseTimers` 與 `experimental` 註記）、`src/workerd/api/hibernatable-web-socket.c++`

</details>
