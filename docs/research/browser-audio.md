# 研究：座位裝置的瀏覽器音訊行為

對應 issue：[#3](https://github.com/yurenju/turca/issues/3)　查證日期：2026-09-26

## 背景

每個**座位**（房間裡負責演奏的一台手機或電腦）用 Web Audio 播放取樣音色，跟其他座位對齊到 10–30 毫秒以內。`initial-research.md` 的做法建立在四個還沒查證的假設上：

1. Safari 對 Opus 的 `decodeAudioData` 支援不穩，所以優先用 AAC（.m4a）。
2. 用 `AudioContext.outputLatency` 扣掉各機的輸出延遲。
3. iOS 要使用者點一下才能啟用音訊。
4. 用 Wake Lock API 讓螢幕不熄，避免音訊被暫停。

要測的瀏覽器：iOS Safari、Android Chrome、桌面 Chrome／Safari／Firefox。

幾個名詞：

- **`decodeAudioData`**：把一整個音檔（放在 `ArrayBuffer` 裡）解碼成 Web Audio 可以直接播的 PCM 資料。
- **`AudioContext`**：Web Audio 的播放環境，有自己的時鐘 `currentTime`，狀態有 `suspended`（暫停）、`running`（播放中）、`closed`，Safari 另外還有 `interrupted`（被系統打斷）。
- **使用者啟用（user activation）**：HTML 標準裡「使用者剛剛真的操作過這個頁面」的狀態，分成「暫時的」（操作後幾秒內）與「黏著的」（操作過一次之後就一直成立）。
- **Wake Lock**：Screen Wake Lock API，網頁可以要求螢幕不要變暗或鎖定。

## 結論一覽

| 假設 | 結果 | 一句話 |
| --- | --- | --- |
| 1. Opus 在 Safari 不穩，優先 AAC | **有條件成立** | `decodeAudioData` 解 WebM 裡的 Opus 是 2021 年 7 月才補上的，Safari 18.4 起也能解 Ogg 裡的 Opus；但 iOS 上用 `canPlayType()` 偵測 Opus 曾經回報「不支援」而實際解得開，偵測不可靠。AAC 在我們要測的瀏覽器上全都能解，所以「用 AAC」仍是最省事的選擇。 |
| 2. `outputLatency` 可以拿來扣延遲 | **有條件成立** | 目前五個目標瀏覽器都有實作（Safari 要 18.4 以上），但規格只說它是「估計值」，Chromium 回報的是平台音訊回呼的緩衝大小，會隨時變動。拿來扣可以，但要留一個手動校正的旋鈕。 |
| 3. iOS 要使用者點一下才能啟用音訊 | **成立（Chrome 也一樣；Firefox 沒查）** | 規格規定 `AudioContext` 要有使用者啟用才能從暫停轉為播放，Chrome 與 Safari 都照做。另外 iOS 有兩個研究文件沒提到的坑：靜音開關會讓 Web Audio 沒聲音，以及鎖屏／切走之後 context 會變成 `interrupted`。 |
| 4. Wake Lock 可以防止熄屏，因此音訊不會被暫停 | **部分成立** | 前半句成立：iOS 16.4 起可以防自動熄屏（加到主畫面的網頁要 18.4 起）。但頁面一被切到背景 wake lock 就自動解除，低電量時也可能被解除，擋不住使用者自己切走或按鎖屏鍵。後半句「螢幕不熄，音訊就不會被暫停」沒有找到官方文件佐證，要實測。 |

## 1. `decodeAudioData` 的格式支援

**規格**：`decodeAudioData` 能解的格式等於 `<audio>` 元素能播的格式，由內容嗅探決定，不看副檔名。
來源：[Web Audio API 規格，decodeAudioData](https://webaudio.github.io/web-audio-api/#dom-baseaudiocontext-decodeaudiodata)

| 格式 | Chrome（桌面／Android） | Safari（macOS／iOS） | Firefox |
| --- | --- | --- | --- |
| MP3 | 可 | 可 | 可 |
| AAC（.m4a） | 可（僅 Google Chrome，Chromium 自行編譯版不含） | 可 | 可，但靠作業系統的解碼器 |
| Opus in WebM | 可 | 2021-07 起的 WebKit（見下，iOS 上偵測不可靠） | 可 |
| Opus in Ogg | 可 | Safari 18.4 起（macOS 15.4／iOS 18.4） | 可 |

來源：

- Chrome：[chromium.org Audio/Video](https://www.chromium.org/audio-video/) 列出 Chromium 與 Chrome 都支援 MP3、Opus、Vorbis，容器有 MP4、Ogg、WebM；AAC 屬於「只有 Google Chrome 有」的專利編碼。
- Safari 15 加入 WebM 裡的 Opus：[Safari 15 Release Notes](https://developer.apple.com/documentation/safari-release-notes/safari-15-release-notes)（原文："Added support for the Opus audio codec in WebM containers."）
- 背景：Safari 15 測試版一開始只有 `<audio>` 能播 WebM Opus，`decodeAudioData` 解不了，而網頁都靠 `canPlayType()` 判斷，結果用 WebM Opus 的 Web Audio 網頁全部沒聲音（[WebKit Bug 226922](https://bugs.webkit.org/show_bug.cgi?id=226922)）。那張票在 2021-06-21 合入的修正（r279103）**沒有修好解碼**，只是讓 `canPlayType()` 暫時對 Opus／Vorbis 回報「不支援」。
- 真正讓 `decodeAudioData` 能解 WebM Opus 的是 [WebKit Bug 227110](https://bugs.webkit.org/show_bug.cgi?id=227110)「[WebAudio] Add webm/opus container support」，2021-07-28 合入（r280416），並附一個開關 `webMWebAudioEnabled` 讓各平台決定要不要開。照時間推應該在 Safari 15 正式版內，但沒有逐版確認。
- iOS 上偵測不可靠：[WebKit Bug 238546](https://bugs.webkit.org/show_bug.cgi?id=238546)（至今狀態仍是 NEW）回報 Safari 15.4 在 macOS 上三者一致，但在 iPadOS 15.4 上 `canPlayType()` 說不支援、`<audio>` 播不了，`decodeAudioData` 卻解得開；iOS 16.1 仍一樣。回報者 2024-03 留言說 Safari 17.4 起 iOS 與 macOS「終於一致」，但這是回報者自己的觀察，WebKit 沒有回覆確認。
- Safari 18.4 加入 Ogg 容器的 Opus 與 Vorbis（macOS Sequoia 15.4、iOS／iPadOS 18.4）：[WebKit Features in Safari 18.4](https://webkit.org/blog/16574/webkit-features-in-safari-18-4/)
- Firefox 的 AAC 依作業系統：[MDN Web audio codec guide](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Audio_codecs)。這一項只有 MDN 的整理，沒追到 Mozilla 的一手來源。

**判讀**：「Safari 對 Opus 不穩」這句話到現在仍有一半是對的：解碼本身已經支援，但 iOS 上 `canPlayType()` 的回答跟 `decodeAudioData` 實際能不能解曾經對不起來，所以**不能用 `canPlayType()` 決定要不要載 Opus**。AAC 與 MP3 在所有目標瀏覽器都能解，所以研究文件「優先 AAC」的選擇不必改，理由改成「AAC 不必看版本、也不必偵測」。若之後想用 Opus 省流量，做法是先拿一小段 Opus 丟給 `decodeAudioData` 試解，失敗就改載 AAC。

⚠️ **來源互相矛盾**：MDN 的 codec 指南仍寫 Safari 的 Opus「只能在 CAF 容器、只能用 audio 元素」，這已經被 Safari 15 與 18.4 的官方說明推翻，以 Apple／WebKit 的來源為準。

## 2. `outputLatency`、`baseLatency`、`getOutputTimestamp()`

**規格定義**（[Web Audio API](https://webaudio.github.io/web-audio-api/#dom-audiocontext-outputlatency)）：

- `baseLatency`：`AudioContext` 把音訊從 destination 交給系統音訊的處理延遲（秒）。
- `outputLatency`：**估計的**輸出延遲，從瀏覽器要求系統播放一個緩衝，到那個緩衝的第一個取樣真的被輸出裝置處理為止。
- `getOutputTimestamp()`：回傳 `{contextTime, performanceTime}`，把 `AudioContext` 的時鐘對應到 `performance.now()` 的時鐘，而且是「正在被輸出的那一刻」。

**實作版本**（依 [MDN browser-compat-data](https://github.com/mdn/browser-compat-data/blob/main/api/AudioContext.json)，再追到各家一手紀錄）：

| | Chrome／Android Chrome | Firefox | Safari／iOS Safari |
| --- | --- | --- | --- |
| `baseLatency` | 58 | 70 | 14.1（iOS 14.5） |
| `outputLatency` | 102 | 70 | **18.4**（iOS 18.4） |
| `getOutputTimestamp()` | 57 | 70 | 14.1（iOS 14.5） |

BCD 的 iOS Safari 欄位寫的是「同桌面版」，桌面 Safari 14.1 對應的是 iOS 14.5。

- Firefox：[Bug 1324552](https://bugzilla.mozilla.org/show_bug.cgi?id=1324552)（baseLatency／outputLatency）、[Bug 1324545](https://bugzilla.mozilla.org/show_bug.cgi?id=1324545)（getOutputTimestamp），在 Firefox 70 發布。開啟防指紋（resistFingerprinting）時改回報該作業系統最常見的值：[Bug 1564422](https://bugzilla.mozilla.org/show_bug.cgi?id=1564422)。
- Chrome：[Intent to Ship: AudioContext.outputLatency](https://groups.google.com/a/chromium.org/g/blink-dev/c/dTQniJNVVMY)。⚠️ 這份 intent 寫的預計版本是 Chrome 98，BCD 記的是 102，版本號兩邊不一致；不影響結論（現行版本都有）。
- Safari：WebKit 在 2025-01-14 合入 "[WebAudio] Implement AudioContext::outputLatency"（[Bug 285826](https://bugs.webkit.org/show_bug.cgi?id=285826)，[commit 郵件](https://www.mail-archive.com/webkit-changes@lists.webkit.org/msg224878.html)），只實作了 Cocoa 平台（macOS／iOS）。

**回報的值代表什麼、準不準**：

- Chromium 的 intent 原文："outputLatency is the buffer size of the platform-provided audio callback, so the value is inherently platform-specific."，並舉例 macOS 128 frames、Windows 10ms、Android 96 frames。也就是說在 Chromium 上它反映的是緩衝大小，**不保證包含硬體或藍牙那一段的延遲**。
- 規格 issue [WebAudio/web-audio-api#2563](https://github.com/WebAudio/web-audio-api/issues/2563) 指出這個值在播放中、或輸出裝置切換時會變，Chromium 上「can change all the time」，偶爾讀一次不一定有代表性。
- WebKit 原始碼（[AudioContext.cpp](https://github.com/WebKit/webkit/blob/main/Source/WebCore/Modules/webaudio/AudioContext.cpp)）：context 沒在播放時 `outputLatency` 回 0；啟用防指紋的雜訊政策時固定回 `512 / sampleRate`。所以**要在 `running` 之後才讀**，而且讀到的值可能是假的固定值。
- Firefox 防指紋模式同樣會回報假值（Bug 1564422）。

**判讀**：五個目標瀏覽器的現行版本都拿得到值，所以研究文件第 4 節「扣掉 `outputLatency`」可以照做，但它是估計值，各家定義的範圍不一樣。對 10–30 ms 的目標，建議：

1. 用 `getOutputTimestamp()` 把 `AudioContext` 時鐘對到 `performance.now()`（這是規格設計來做這件事的），再減 `outputLatency`。
2. 在播放中定期重讀，不要只讀一次。
3. **每個座位留一個手動偏移量**（例如入場時讓使用者對著節拍聲調一下），因為平台回報的值可能不含藍牙或硬體延遲、也可能被防指紋改成固定值。

Safari 18.4 以前的 iOS 沒有 `outputLatency`，要用 `'outputLatency' in AudioContext.prototype` 偵測，沒有時只能靠手動偏移。`baseLatency` 不能拿來代替：依規格它只算到「交給系統音訊」為止，不含之後到喇叭的那一段，而那一段正是 `outputLatency` 要量的。

## 3. iOS Safari 的音訊啟用、靜音開關、背景與鎖屏

### 啟用規則

- **規格**：`AudioContext` 只有在頁面具有「黏著的使用者啟用」時，才允許從 `suspended` 轉為 `running`。[Web Audio API，allowed to start](https://webaudio.github.io/web-audio-api/#allowed-to-start)
- **哪些操作算數**：HTML 標準列的是 `keydown`（Esc 與瀏覽器保留快捷鍵除外）、`mousedown`、滑鼠的 `pointerdown`、非滑鼠的 `pointerup`、`touchend`。注意手機上是**手指離開**（`touchend`／`pointerup`）才算，`touchstart` 不算。[HTML Standard，activation-triggering input event](https://html.spec.whatwg.org/multipage/interaction.html#activation-triggering-input-event)
- **WebKit 實作**：`willBeginPlayback()` 在「主框架有過使用者互動」或「視窗具有暫時的使用者啟用」時放行（[AudioContext.cpp](https://github.com/WebKit/webkit/blob/main/Source/WebCore/Modules/webaudio/AudioContext.cpp)）。Safari 16.4 修正為 Web Audio 只需要暫時的使用者啟用（[WebKit Features in Safari 16.4](https://webkit.org/blog/13966/webkit-features-in-safari-16-4/)，原文："Fixed only requiring a transient user activation for Web Audio rendering"）。
- **Chrome**：在使用者操作前建立的 `AudioContext` 會是 `suspended`，要在操作後呼叫 `resume()`。[Chrome Autoplay policy](https://developer.chrome.com/blog/autoplay)

- **Firefox**：沒查。沒有找到 Mozilla 對 Web Audio 自動播放限制的一手說明（試過在 Firefox 原始碼的偏好設定檔裡找相關設定，沒抓到）。

**判讀**：成立，Chrome 與 Safari 都一樣，不是 iOS 特有；Firefox 沒查，但入場按鈕本來就是使用者操作，照規格做不會有差。研究文件「用入場的『加入』按鈕順便處理」是對的：在那個按鈕的 click 處理裡建立或 `resume()` 那個 `AudioContext`。

### 靜音開關（研究文件沒提到）

- iPhone 的靜音開關打開時，Web Audio **沒有聲音**，但 `<audio>`／`<video>` 照常有聲音。WebKit 工程師解釋：Web Audio 的音訊類型預設是 `ambient`，所以跟著靜音開關走；解法是設定 `navigator.audioSession.type = "playback"`。[WebKit Bug 237322](https://bugs.webkit.org/show_bug.cgi?id=237322)
- `navigator.audioSession` 來自 W3C 的 [Audio Session API](https://w3c.github.io/audio-session/)，目前是 Editor's Draft，定義了 `playback`、`ambient`、`auto` 等類型。
- ⚠️ **版本來源不一致**：Safari 16.4 的說明寫「支援 AudioSession Web API 的一部分」（[Safari 16.4](https://webkit.org/blog/13966/webkit-features-in-safari-16-4/)），WebKit 237322 裡的工程師則說「從 iOS 17 起」可以用它解決靜音開關的問題。保守起見以 iOS 17 為準，並先判斷 `navigator.audioSession` 存在再設定。「iOS 17 起有效」只出自這一則 bug 留言，沒有 Apple 的正式說明，**要在實機上打開靜音開關確認**。

**判讀**：這是新的風險，要加進風險表。對策是入場時設定 `navigator.audioSession.type = "playback"`；對 iOS 17 以前的裝置只能請使用者關掉靜音開關。

### 切到背景或鎖屏

- iOS Safari 在頁面被切走、鎖屏時，會把 `AudioContext` 轉成 Safari 特有的 `interrupted` 狀態（WebKit 的 layout test [audiocontext-state-interrupted.html](https://github.com/WebKit/webkit/blob/main/LayoutTests/webaudio/audiocontext-state-interrupted.html) 驗的就是這個狀態，以及打斷結束後 `resume()` 才會完成）。這個狀態還沒進 Web Audio 正式規格，微軟提了 [AudioContext Interrupted State explainer](https://github.com/MicrosoftEdge/MSEdgeExplainers/blob/main/AudioContextInterruptedState/explainer.md) 要把它標準化。
- 有開發者回報 iOS 上 context 卡在 `interrupted`，使用者操作後呼叫 `resume()` 也回不來，規格 repo 的 issue 至今沒有 WebKit 回覆：[WebAudio/web-audio-api#2585](https://github.com/WebAudio/web-audio-api/issues/2585)。
- [WebKit Bug 237878](https://bugs.webkit.org/show_bug.cgi?id=237878)（「頁面在背景時 iOS 暫停 AudioContext」）2022 年已修，但該 bug 的情境是 context 沒直接拿來播放（例如 WebRTC）；留言裡有人回報 iOS 16.3 仍有問題。跟我們「保持前景」的做法關係不大。

**判讀**：研究文件「保持前景」的方向沒錯，但程式要處理 `interrupted`：監聽 `statechange`，回到前景時顯示一個「點一下繼續」的按鈕並 `resume()`，同時重新做一次時鐘校正。理由是推論，還沒驗證：規格說 `suspend()` 會讓 `currentTime` 停止前進（[Web Audio API，suspend()](https://webaudio.github.io/web-audio-api/#dom-audiocontext-suspend)），但 `interrupted` 不在規格裡，打斷期間 `currentTime` 會不會停沒有找到來源，要實測（鎖屏前後各讀一次 `currentTime` 與 `performance.now()`）。不管停不停，重新校正都不會錯。

## 4. Screen Wake Lock

**支援**（依 [MDN browser-compat-data](https://github.com/mdn/browser-compat-data/blob/main/api/WakeLock.json)，再追到一手來源）：

| | 版本 |
| --- | --- |
| Chrome／Android Chrome | 84 |
| Firefox | 126 |
| Safari（macOS） | 16.4 |
| iOS Safari（瀏覽器內） | 16.4 |
| iOS 加到主畫面的網頁 | 18.4 |

- Safari 16.4 加入 Screen Wake Lock：[WebKit Features in Safari 16.4](https://webkit.org/blog/13966/webkit-features-in-safari-16-4/)
- 加到主畫面的網頁在 iOS 18.4 以前**不能用**，2025-03-31 隨 iOS 18.4 修好：[WebKit Bug 254545](https://bugs.webkit.org/show_bug.cgi?id=254545)、[Safari 18.4](https://webkit.org/blog/16574/webkit-features-in-safari-18-4/)

**限制**（[Screen Wake Lock API 規格](https://w3c.github.io/screen-wake-lock/)）：

- 頁面是隱藏狀態（`visibilityState === "hidden"`）時 `request()` 直接被拒；頁面變成隱藏時，已拿到的 lock 會**自動解除**，回到前景要重新 request。
- 受 permissions policy `screen-wake-lock` 管，iframe 裡要另外開放。
- 瀏覽器可以因為低電量、省電模式等原因主動解除。

**判讀**：部分成立。「防止熄屏」成立，可以擋掉「放著不動螢幕自己熄掉」這個情況，這正是演奏中最常見的。「螢幕不熄，音訊就不會被暫停」這半句沒有找到官方文件直接佐證：上面第 3 節查到的是切走、鎖屏會讓 `AudioContext` 變成 `interrupted`，但沒有文件說「螢幕亮著、頁面在前景」時音訊一定不會被打斷（例如來電）。要實測。但它擋不住使用者自己按鎖屏或切 app，也擋不住省電模式。所以要：監聽 `release` 事件與 `visibilitychange`，回到前景時重新 request；入場時提醒使用者關掉省電模式。

## 對同步播放 prototype 的影響

研究文件的做法都不必推翻，要補的是：

1. 音檔用 AAC（.m4a）即可，理由改寫成「全平台不看版本都能解」。不要用 `canPlayType()` 決定載不載 Opus。
2. 延遲補償用 `getOutputTimestamp()` + `outputLatency`，**加上每座位的手動偏移**；iOS 18.4 以前沒有 `outputLatency`。
3. 入場按鈕裡：建立／`resume()` `AudioContext`、設 `navigator.audioSession.type = "playback"`、request wake lock。
4. 處理 `interrupted` 與 wake lock 被解除：回前景時重新 resume、重新 request、重新校正時鐘。
5. 風險表新增「iOS 靜音開關會讓 Web Audio 沒聲音」。

## 沒查到或沒有一手來源的

- **Firefox 的 AAC 依作業系統**：只查到 MDN 的整理；Mozilla 的 SUMO 說明頁抓取時載入失敗（頁面本身的錯誤，不是網路被擋），沒追到 Mozilla 原始碼。Firefox 桌面版只是次要目標，影響小。
- **各瀏覽器 `outputLatency` 實測準確度**：沒找到任何一家 bug tracker 裡「值不準」的具體 bug，也沒有官方公布的實測誤差。只能從定義推論 Chromium 回報的只是緩衝大小。這一項要在 prototype 裡實測（手機喇叭 vs 藍牙耳機各量一次）。
- **WebKit `outputLatency` 在 iOS 的計算公式**：commit 只看得到改了哪些檔（`AudioSessionIOS` 等），沒追到確切公式，不確定是否包含藍牙延遲。
- **Firefox 的使用者啟用規則**：沒查，理由見第 3 節。
- **Wake Lock 開著時音訊會不會被暫停**：沒有來源，要在 iOS 與 Android 實機上放著播幾分鐘確認。
- **`interrupted` 期間 `currentTime` 會不會停**：沒有來源，見第 3 節。
- **`navigator.audioSession` 在 iOS 17 起能否讓靜音開關失效**：只有 WebKit 237322 的一則留言，要實機確認。
- **Android Chrome 切到背景時 `AudioContext` 的行為**：沒查到官方文件；我們的做法是保持前景，暫不影響。
