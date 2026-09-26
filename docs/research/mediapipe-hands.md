# 研究：MediaPipe 手部辨識在瀏覽器裡的實際用法與效能

> 對應 issue [#5](https://github.com/yurenju/turca/issues/5)。查證日期 2026-09-26，對照的套件版本是 `@mediapipe/tasks-vision@1.0.1`（npm 上目前的 `latest`）。

## 前提

`initial-research.md` 第 5 節〈辨識方案〉打算這樣做：用 MediaPipe Hand Landmarker 在瀏覽器裡同時追指揮的兩隻手，靠它回報的「左手／右手」分辨哪隻手打拍、哪隻手調音量；第一版只用手腕座標；辨識放在 Web Worker 裡，免得卡住音訊與畫面。文件估計推論在筆電上約 10–20 毫秒。這份研究要確認的是：這幾個假設有沒有官方根據。

## 結論

- **Web Worker：可以。** 從 0.10.35（2026-04）開始，官方套件能直接在 module worker 裡載入；官方的網頁範例就是把每一格畫面轉成 `ImageBitmap` 丟進 worker 推論。更早的版本在 module worker 裡會壞，網路上很多「要自己改套件」的教學都是那時候的。
- **推論時間：官方沒有瀏覽器的數字。** 唯一的官方基準是 Pixel 6 手機（full 模型 CPU 17.12 ms、GPU 12.27 ms），不是筆電；來源也沒寫是在哪個執行環境量的，幾乎可以確定是 Android 原生程式，不是瀏覽器。「筆電 10–20 毫秒」這個估計目前沒有來源支持也沒有來源推翻，只能在 prototype 裡自己量。
- **網頁版只有 full 模型。** 官方發布的 `hand_landmarker.task` 裡面裝的是 full 版的偵測與關鍵點模型，沒有 lite 版的 `.task` 可以直接用。
- **左右手判斷：官方來源互相矛盾，不能照單全收。** 舊版文件說「模型假設輸入是鏡像畫面」，Android／Python 範例也會先把前鏡頭畫面翻過來再送進去；但官方網頁範例直接送沒翻的畫面，而測試資料的標註方式看起來是「沒翻的畫面就回報真實的手」（測試圖只有手背朝鏡頭一種姿勢）。第一個 prototype 要花一分鐘實測，而且設計上最好不要只靠這個標籤。
- **檔案大小：** wasm 約 11.8 MB（brotli 壓縮後傳輸約 3.1 MB），手部模型 7.8 MB。預設從 jsDelivr 與 Google Cloud Storage 載入，也能自己架；每個檔案都在 Cloudflare 單檔 25 MiB 的上限內。
- **替代方案：** Pose Landmarker 直接給左右手腕（身體第 15、16 點），左右由身體骨架判斷、不靠手的形狀，但畫面翻過來時一樣會對調；模型 lite 版 5.8 MB，官方同樣沒有瀏覽器的速度數字；TensorFlow.js 的 handpose 已經三年沒更新，不建議。

下面逐項列出依據。

---

## 1. 能不能在 Web Worker 裡跑

**結論：可以，要用 0.10.35 以後的版本。**

- 官方網頁指南明寫 `detect()` 與 `detectForVideo()` 是同步呼叫、會卡住 UI 執行緒，建議放進 Web Worker。[官方 Web 指南](https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker/web_js)
- **舊版的問題**：套件載入 wasm 的方式是呼叫 `importScripts()`，而在 module worker（`new Worker(url, { type: 'module' })`）裡，`importScripts` 這個名字雖然存在，一呼叫就會丟出 `TypeError`，所以載入失敗。維護者在 issue 裡承認過這件事，當時的建議是改用 classic worker 或自己修改套件。
  [#5479](https://github.com/google-ai-edge/mediapipe/issues/5479)、[#5257](https://github.com/google-ai-edge/mediapipe/issues/5257)、[#5527](https://github.com/google-ai-edge/mediapipe/issues/5527)
- **修好的時間點**：v0.10.35 的 release notes 寫「Allow MP Task files to be use in Vite's workers」。[v0.10.35 release](https://github.com/google-ai-edge/mediapipe/releases/tag/v0.10.35)
  我比對了 npm 上各版本的 `vision_bundle.mjs`：0.10.14 與 0.10.21 只會呼叫 `importScripts()`；0.10.35、1.0.0、1.0.1 改成先試 `importScripts()`，丟出 `TypeError` 時改用 `import()` 載入。[1.0.1 bundle](https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/vision_bundle.mjs)、[0.10.21 bundle](https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/vision_bundle.mjs)
- **官方範例**：維護者在 [#5169](https://github.com/google-ai-edge/mediapipe/issues/5169) 與 [#5527](https://github.com/google-ai-edge/mediapipe/issues/5527) 回覆「This works now」，並指向官方的網頁範例 repo。那裡每個任務都有一個 worker，手部的是 [hand-landmarker.worker.ts](https://github.com/google-ai-edge/mediapipe-samples-web/blob/main/src/workers/hand-landmarker.worker.ts)。做法是：
  - 主執行緒用 `new Worker(..., { type: 'module' })` 開 worker，每一格影像用 `createImageBitmap(video)` 轉成 `ImageBitmap`，以 transferable 的方式 `postMessage` 過去。[base-vision-task.ts](https://github.com/google-ai-edge/mediapipe-samples-web/blob/main/src/components/base-vision-task.ts)、[hand-landmarker.ts](https://github.com/google-ai-edge/mediapipe-samples-web/blob/main/src/tasks/hand-landmarker.ts)
  - worker 裡用 `FilesetResolver.forVisionTasks(wasmPath, true)`（第二個參數代表用 ES module 版的 wasm 載入器），模型先 `fetch` 成 buffer 再用 `modelAssetBuffer` 傳入，然後呼叫 `detectForVideo(bitmap, timestampMs)`，用完 `bitmap.close()`。[base-worker.ts](https://github.com/google-ai-edge/mediapipe-samples-web/blob/main/src/workers/base-worker.ts)
  - 時間戳記用 `performance.now()`，並保證每次都比上一次大（重複時加 1 ms）。
- `detectForVideo()` 收的影像型別是 `TexImageSource`，包含 `ImageBitmap`、`VideoFrame`、`OffscreenCanvas`，所以不需要 DOM 元素。[vision.d.ts](https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/vision.d.ts)（`ImageSource` 型別）
- **OffscreenCanvas**：套件在沒有傳入 canvas 時會自己建 `new OffscreenCanvas(1,1)` 當 WebGL 環境；Safari 要 17 以上才會走這條路，更舊的 Safari 會退回 `document.createElement('canvas')`，在 worker 裡就會失敗。[1.0.1 bundle](https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/vision_bundle.mjs)（`Ph()` 函式）；Safari 17 的支援是 v0.10.13 加的，見 [#5292](https://github.com/google-ai-edge/mediapipe/issues/5292)。
- **worker 裡要避開的東西**：`DrawingUtils`（畫關鍵點的輔助類別）在 worker 裡建構會出錯，因為它檢查 `CanvasRenderingContext2D`，見 [#5257](https://github.com/google-ai-edge/mediapipe/issues/5257) 後段留言。我們本來就該在主執行緒畫圖，只把座標傳回來，所以不受影響。

### GPU delegate 在各瀏覽器

- `baseOptions.delegate` 可設 `"CPU"` 或 `"GPU"`，預設是 CPU。[官方 Web 設定頁](https://developers.google.com/edge/mediapipe/solutions/setup_web)、[vision.d.ts](https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/vision.d.ts)
- GPU 需要 WebGL2。官方範例的 worker 在 GPU 初始化失敗時會自動退回 CPU，並列出常見原因：沒有 OffscreenCanvas、沒有 WebGL2、WebGL context 被收回、瀏覽器用軟體算繪。[base-worker.ts](https://github.com/google-ai-edge/mediapipe-samples-web/blob/main/src/workers/base-worker.ts)。**我們的 prototype 應該照抄這個退回機制。**
- 維護者說過：就算設成 CPU，前後處理有些部分仍假設有 GPU。[#5970](https://github.com/google-ai-edge/mediapipe/issues/5970)
- **官方只測 Chrome 與 Safari。** 設定頁列的支援環境只有「Chrome or Safari browser」，維護者也在 issue 裡說無法保證 Firefox 的表現。[官方 Web 設定頁](https://developers.google.com/edge/mediapipe/solutions/setup_web)、[#4679](https://github.com/google-ai-edge/mediapipe/issues/4679)
- **查不到的**：各瀏覽器上 GPU delegate 在 worker 裡能不能用，官方沒有一張對照表。Firefox 有影像分割任務的 WebGL 格式問題還開著（[#5879](https://github.com/google-ai-edge/mediapipe/issues/5879)），但跟手部任務有沒有關係不確定。這部分只能在 prototype 裡實測。

## 2. 推論延遲與 fps

**結論：官方沒有瀏覽器上的數字，要自己量。**

- 官方唯一的基準是 Pixel 6 上的平均延遲，而且只列 full 模型：CPU 17.12 ms、GPU 12.27 ms。[Hand Landmarker 總覽](https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker)
- 官方 Web 指南沒有任何速度數字。[官方 Web 指南](https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker/web_js)
- 模型卡也只有準確度，沒有速度。[Hand Tracking 模型卡（PDF）](https://storage.googleapis.com/mediapipe-assets/Model%20Card%20Hand%20Tracking%20(Lite_Full)%20with%20Fairness%20Oct%202021.pdf)
- **lite／full 在網頁上沒得選**：官方發布的 `hand_landmarker.task` 解開來是 `hand_detector.tflite`（2,339,878 bytes）與 `hand_landmarks_detector.tflite`（5,478,949 bytes），大小跟 Google 放在 `mediapipe-assets` 的 `palm_detection_full.tflite`（2,339,846）與 `hand_landmark_full.tflite`（5,478,917）只差幾十 bytes，也就是 full 版。lite 版的單獨模型存在（`hand_landmark_lite.tflite`，2,071,408 bytes），但沒有包成 `.task`。[hand_landmarker.task](https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task)、[hand_landmark_lite.tflite](https://storage.googleapis.com/mediapipe-assets/hand_landmark_lite.tflite)
  （這是我下載後比對檔案大小判斷出來的，官方沒有明寫「網頁版是 full」。）
- **影響速度的機制**：VIDEO 模式下，手掌偵測只在追丟時才重跑，其餘時間只跑關鍵點模型，所以兩隻手都穩定在畫面裡時會比較快。官方總覽頁原文是「Hand Landmarker only re-triggers the palm detection model if the hand landmarks model no longer identifies the presence of hands or fails to track the hands within the frame.」[Hand Landmarker 總覽](https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker)
- **量的方法**：官方範例 worker 就在 `detectForVideo` 前後用 `performance.now()` 計時，把 `inferenceTime` 跟結果一起傳回主執行緒。[hand-landmarker.worker.ts](https://github.com/google-ai-edge/mediapipe-samples-web/blob/main/src/workers/hand-landmarker.worker.ts)。prototype 可以直接照做，另外記下每秒收到幾次結果。

## 3. 左右手（handedness）的定義與鏡像

**結論：官方來源互相矛盾。先實測，再決定要不要翻；設計上不要把「分左右手」全押在這個標籤上。**

### 各來源怎麼說

| 來源 | 說法 |
| --- | --- |
| 舊版 Hands 文件（2023 年前的 legacy solution） | 「handedness is determined assuming the input image is mirrored, i.e., taken with a front-facing/selfie camera with images flipped horizontally. If it is not the case, please swap the handedness output in the application.」[hands.md](https://github.com/google-ai-edge/mediapipe/blob/master/docs/solutions/hands.md) |
| 舊版追蹤圖的註解 | 同上的說法。[hand_landmark_tracking_cpu.pbtxt](https://github.com/google-ai-edge/mediapipe/blob/master/mediapipe/modules/hand_landmark/hand_landmark_tracking_cpu.pbtxt) |
| 新版 Tasks 文件（我們要用的） | 只說會輸出左手或右手，**沒提鏡像**。[Hand Landmarker 總覽](https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker)、[官方 Web 指南](https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker/web_js) |
| 新版 Tasks 原始碼 | 標籤直接取自模型輸出，中間沒有任何翻轉。[hand_landmarks_detector_graph.cc](https://github.com/google-ai-edge/mediapipe/blob/master/mediapipe/tasks/cc/vision/hand_landmarker/hand_landmarks_detector_graph.cc) |
| Android 範例 | 用前鏡頭時先把畫面左右翻轉，再送進模型。[HandLandmarkerHelper.kt](https://github.com/google-ai-edge/mediapipe-samples/blob/main/examples/hand_landmarker/android/app/src/main/java/com/google/mediapipe/examples/handlandmarker/HandLandmarkerHelper.kt) |
| Raspberry Pi（Python）範例 | 同樣先 `cv2.flip(image, 1)` 再偵測。[detect.py](https://github.com/google-ai-edge/mediapipe-samples/blob/main/examples/hand_landmarker/raspberry_pi/detect.py) |
| **官方網頁範例** | **沒有翻**，直接 `createImageBitmap(video)` 送進 worker。[base-vision-task.ts](https://github.com/google-ai-edge/mediapipe-samples-web/blob/main/src/components/base-vision-task.ts) |
| 新版 Tasks 測試資料 | `right_hands.jpg` 預期輸出 `Right`，`left_hands.jpg`（前者左右翻轉而成）預期 `Left`。[測試](https://github.com/google-ai-edge/mediapipe/blob/master/mediapipe/tasks/cc/vision/hand_landmarker/hand_landmarks_detector_graph_test.cc)、[right_hands.jpg](https://storage.googleapis.com/mediapipe-assets/right_hands.jpg) |

### 矛盾在哪

我打開 `right_hands.jpg` 看：看得到指甲（所以是手背），手指朝上時大拇指在畫面左邊。這是一隻右手的樣子：沒翻過的照片裡，右手只要是「手背朝鏡頭、手指朝上」，大拇指就在左邊（如果是掌心朝鏡頭，大拇指會在右邊，那是另一種姿勢，但一樣是右手的形狀）。測試要求模型把它標成 `Right`，代表**至少在這個姿勢下，模型對沒翻過的畫面回報的是真實的手**，這跟舊文件「假設輸入是鏡像」正好相反，卻跟官方網頁範例「不翻」一致。

這段推理是我看圖得出的，不是官方的說法；而且測試圖只有手背朝鏡頭這一種姿勢，指揮常會把掌心朝向鏡頭，那種姿勢模型怎麼標，測試資料沒有涵蓋。圖片本身有沒有被翻過，從檔案看不出來，但不影響結論，因為模型看到的就是一隻右手形狀的手。

另外有一則使用者回報，情境是 Gesture Recognizer 的官方 codepen 範例（它內部用的是同一個手部模型）：同一張圖在舊版 tasks-vision 被標成 `Right`，換成新版後變成 `Left`。維護者後來更新了 codepen，是**回報者自己**說「The handedness is now correct」；沒有人說明哪一個標籤才是對的。[#6211](https://github.com/google-ai-edge/mediapipe/issues/6211)。這只是一則使用者回報，但它顯示不同版本之間的行為可能不一樣。

另外，有人提案在 Tasks 加一個 `selfieMode` 選項（開了之後輸出的 x 座標自動鏡像），PR 還沒合併，1.0.1 的型別定義裡也沒有這個選項。[#5900](https://github.com/google-ai-edge/mediapipe/issues/5900)、[PR #6340](https://github.com/google-ai-edge/mediapipe/pull/6340)

### 建議

1. **送進模型的影像不要翻**（照官方網頁範例）。畫面顯示給指揮看的時候再用 CSS `transform: scaleX(-1)` 翻，顯示跟推論分開。
2. prototype 第一件事：指揮舉右手，看回報是 `Right` 還是 `Left`，依結果決定要不要把標籤對調。把這個對調做成一個設定值，換版本時再測一次。
3. 不要只靠標籤。指揮面對鏡頭時，右手大多在畫面的一側（沒翻的畫面裡是左半邊），可以用「標籤＋水平位置」一起判斷，並加上遲滯：一隻手的身分確定後，除非連續好幾格都不一致，否則不要換。

## 4. 模型與 wasm 的大小、從哪裡載入

| 檔案 | 原始大小 | 備註 |
| --- | --- | --- |
| `vision_wasm_internal.wasm`（SIMD 版） | 11,756,954 bytes | jsDelivr 以 brotli 傳輸約 3.1 MB |
| `vision_wasm_module_internal.wasm`（ES module 版，worker 用這個） | 11,756,972 bytes | 同上 |
| `vision_wasm_nosimd_internal.wasm` | 10,960,242 bytes | 不支援 SIMD 的瀏覽器才會用 |
| `vision_bundle.mjs` | 155,439 bytes | JS 主程式 |
| `hand_landmarker.task`（float16） | 7,819,105 bytes | gzip 後約 5.8 MB，壓不太下去 |

來源：[jsDelivr 上的 1.0.1 套件內容](https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/)、[package.json](https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/package.json)、[hand_landmarker.task](https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task)。大小是我用 `curl` 取得的 `Content-Length`，壓縮後大小是 jsDelivr 回應的 `content-length`（brotli）與本機 gzip 的結果。

- **預設載入位置**：官方範例 wasm 從 `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm` 載入，模型從 `https://storage.googleapis.com/mediapipe-models/...` 載入。[官方 Web 指南](https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker/web_js)、[套件 README](https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/README.md)
- **可以自己架**：`FilesetResolver.forVisionTasks(basePath)` 可以指定 wasm 所在的目錄；模型可以給 `modelAssetPath`（網址）或 `modelAssetBuffer`（自己 fetch 的內容）。[vision.d.ts](https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/vision.d.ts)、[官方 Web 設定頁](https://developers.google.com/edge/mediapipe/solutions/setup_web)。官方網頁範例就是把 wasm 放在自己網站的 `/wasm` 底下。[base-worker.ts](https://github.com/google-ai-edge/mediapipe-samples-web/blob/main/src/workers/base-worker.ts)
- **版本要鎖**：官方範例網址用的是 `@latest`，但 JS 與 wasm 必須是同一版，而且 #6211 有使用者回報不同版本的左右手標籤不同。建議鎖定版本，或者乾脆自己架。
- **放在 Cloudflare 上可行**：Cloudflare Workers 的靜態檔案與 Cloudflare Pages 都限制單一檔案 25 MiB，這裡最大的檔案是 11.8 MB 的 wasm，放得下。檔案數量上限是免費方案 20,000 個，遠用不到。[Workers 限制](https://developers.cloudflare.com/workers/platform/limits/#static-assets)、[Pages 限制](https://developers.cloudflare.com/pages/platform/limits/)。要不要自己架，屬於部署的決定。

## 5. 替代方案

只列跟「追手腕、延遲低」有關的差異。

| 方案 | 手腕怎麼拿 | 左右怎麼分 | 模型大小 | 速度資料 | 狀態 |
| --- | --- | --- | --- | --- | --- |
| **Hand Landmarker**（原案） | 21 點中的第 0 點 | 模型的 handedness 標籤（見第 3 節） | 7.8 MB（只有 full） | 只有 Pixel 6 | 維護中 |
| **Pose Landmarker** | 33 點中的 15（左腕）、16（右腕） | 由身體骨架決定，不必靠手的形狀；但畫面翻過來時左右一樣會對調 | lite 5.8 MB、full 9.4 MB、heavy 30.7 MB | 官方總覽頁沒有基準表 | 維護中，同一個套件 |
| **Holistic Landmarker** | 身體＋手＋臉一起 | 同 Pose | 較大 | 無 | 同一個套件 |
| TF.js `@tensorflow-models/handpose` | 21 點 | 只能追一隻手 | 約 12 MB | README 寫 2018 MacBook Pro 40 FPS | 最後發布 0.1.0，2023-08-08 |
| TF.js `@tensorflow-models/hand-pose-detection` | 21 點 | 有 handedness | lite／full 可選 | 無 | 最後發布 2.0.1，2023-07-31 |

來源：[Pose Landmarker 總覽](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker)；Pose 模型大小取自 [lite](https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task)、[full](https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task)、[heavy](https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task) 的 `Content-Length`；[handpose README](https://github.com/tensorflow/tfjs-models/blob/master/handpose/README.md)、[hand-pose-detection README](https://github.com/tensorflow/tfjs-models/blob/master/hand-pose-detection/README.md)；發布日期取自 npm registry 裡各版本的發布時間（[handpose](https://registry.npmjs.org/@tensorflow-models/handpose)、[hand-pose-detection](https://registry.npmjs.org/@tensorflow-models/hand-pose-detection)）。

**我的看法**：

- **Pose Landmarker 值得在 prototype 裡跟 Hand Landmarker 並排試一次。** 我們第一版只要手腕，而 Pose 直接給「左腕、右腕」，左右是從整個身體骨架判斷的，不必猜手的形狀，比較不會因為手的姿勢而標錯。但它**不會**讓鏡像的問題消失：畫面左右翻過來以後，模型看到的是一個「左右對調的人」，右腕一樣會被標成左腕（舊版 Pose 因此有 `selfieMode` 選項，Tasks 版還沒有，見 [#5900](https://github.com/google-ai-edge/mediapipe/issues/5900)）。所以送進去的畫面同樣不要翻，並且實測一次。它有 lite 模型，換起來只改幾行，因為兩者在同一個套件、API 幾乎一樣。要注意的是：Pose 要看到上半身（肩膀）才追得穩，指揮站得離筆電太近時可能不行；官方也沒有寫它對前鏡頭畫面的左右怎麼定義。
- **TF.js 的兩個套件不建議**：最後發布在 2023 年，handpose 只追一隻手；速度數字是舊模型、舊硬體。

## 查不到或需要實測的

- 筆電瀏覽器上的實際推論時間與 fps（官方完全沒有）。
- 各瀏覽器在 worker 裡能不能用 GPU delegate（沒有官方對照表；官方只在 Chrome 與 Safari 上測試過）。
- handedness 在目前版本、網頁、沒翻的前鏡頭畫面下到底回報什麼（官方來源互相矛盾）。
- Pose Landmarker 在瀏覽器上的速度，以及它的左右手在鏡像畫面下的行為。

這四項都可以在右手打拍的 prototype 裡一次量完：同一個 worker、同一段影像，換模型、換 delegate，記錄 `inferenceTime` 與舉右手時的標籤。

## 網路限制

這次研究沒有遇到被擋的網域。
