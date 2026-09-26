# 研究：從 OpenScore 挑弦樂四重奏，用 music21 轉成拍數 JSON

對應 issue：[yurenju/turca#6](https://github.com/yurenju/turca/issues/6)。查證日期 2026-09-26。

## 前提與結論

第一版的曲目是我們預先轉好的：從 OpenScore 拿 CC0 授權的 MusicXML，用 music21 解析，每個聲部輸出一份以「拍數」為單位的 JSON（格式見 `initial-research.md` 第 2 節）。這份文件查的是這條路走不走得通，以及哪些地方 music21 不會幫我們做好。

**結論：走得通，但有三件事一定要自己補，否則各聲部會對不齊。**

1. OpenScore 的一個檔是**整首四重奏（所有樂章接在一起）**，要先自己切成單一樂章再展開反覆，不然反覆會跳回第一樂章。切的時候要連第一/第二結尾的括號（`RepeatBracket`）一起帶過去，否則結尾會展開錯（見 3.2 第 7 點）。
2. music21 的 `expandRepeats()` 是**每個聲部各自展開**，而 Fine（結束處）、D.C.（從頭再來）這些記號在抽查的 5 個檔裡都只標在第一小提琴上，結果第一小提琴展開了、其他三個聲部沒展開，長度直接不一樣。
3. 小步舞曲常見的「Menuetto D.C.」這種文字 music21 認不出來（它只比對固定幾種寫法），檔案裡其實有機器可讀的 `<sound dacapo="yes"/>`，但 music21 的 MusicXML 讀取器沒讀這個屬性。

簡單的反覆（`||: :||`）、連結線合併、取得每個音的位置（以四分音符為單位）這幾件事，music21 都做得好。第一/第二結尾在括號有帶到的情況下也正確（只實測一個樂章）。

## 名詞

- **曲目 (Piece)**、**聲部 (Part)**、**拍數對照 (Tempo Map)**：見 repo 根目錄 `CONTEXT.md`。
- **樂章**：一首四重奏通常有三、四個樂章，各有自己的速度與反覆記號。OpenScore 把它們放在同一個檔裡。
- **offset / quarterLength**：music21 的時間單位，1 = 一個四分音符，不管拍號是什麼。
- **反覆展開**：把譜上的 `||: :||`、第一/第二結尾、D.C.（從頭再來）、D.S.（從記號處再來）、Fine（結束處）、Coda（尾奏）照演奏順序攤平成一條直線。
- **連結線 (tie)**：把兩個同音高的音連成一個長音；轉成播放資料時要合併成一個音。

---

## 1. OpenScore 的弦樂四重奏收藏

| 項目 | 結果 | 來源 |
| --- | --- | --- |
| 在哪裡 | MuseScore 上的 [OpenScore String Quartets](https://musescore.com/openscore-string-quartets) 帳號；GitHub 上有官方鏡像 [OpenScore/StringQuartets](https://github.com/OpenScore/StringQuartets)（README：「Mirror of https://musescore.com/openscore-string-quartets.」） | [README](https://github.com/OpenScore/StringQuartets/blob/9be3df2ace482130fe031b9e8a647cdf112ed243/README.md) |
| 授權 | CC0。README：「These scores are released under Creative Commons Zero (CC0).」另外請求公開使用時標註 OpenScore String Quartets 並附連結（這是請求，不是授權條件）。 | 同上 |
| 收錄量 | `data/scores.tsv` 列了 197 筆，多數是「long 19th century」作曲家，海頓、莫札特、貝多芬、德弗札克、孟德爾頌等都有。 | [data/scores.tsv](https://github.com/OpenScore/StringQuartets/blob/9be3df2ace482130fe031b9e8a647cdf112ed243/data/scores.tsv) |
| 格式 | README 說檔案是 `.mscx`（MuseScore 未壓縮格式），但實際 repo 樹裡除了 122 個 `.mscx`、74 個 `.mscz`，還有 **196 個 `.mxl`**（壓縮的 MusicXML），另附總譜與各聲部 PDF。**README 與實際內容不一致**，以實際檔案為準：MusicXML 可以直接從 GitHub 拿，不必經過 MuseScore 網站。 | `gh api repos/OpenScore/StringQuartets/git/trees/main?recursive=1`（commit `9be3df2`） |
| `.mxl` 的來源 | 抽查的檔案 `<software>` 是 MuseScore 3.6.2 或 MuseScore Studio 4.7.4，`<encoding-date>` 是 2026-08 到 2026-09，看起來是 repo 維護者批次轉出的。 | 實際解開 `.mxl` 檢查 |
| 檔案大小 | 整首四重奏的 `.mxl` 約 67–250 KB，解壓後 1.4–6.4 MB。 | 實測 |
| **一個檔 = 整首** | 每個 `.mxl` 含所有樂章，樂章之間靠小節號從 1（或弱起的 0）重新開始來分。music21 讀進來是一條連續的長譜。 | 實測（見第 3.1 節） |

下載網址格式（實測可用）：

```
https://raw.githubusercontent.com/OpenScore/StringQuartets/main/scores/<作曲家>/<作品>/sq<id>.mxl
```

## 2. 候選曲目

挑選條件：單一樂章 2–6 分鐘、反覆結構單純、沒有移調樂器（弦樂四重奏本來就沒有）、三連音與裝飾音不多。「長度」是展開反覆後的四分音符數除以檔案裡的速度（MuseScore 的播放速度，換算成每分鐘四分音符數），只是估計值。

| # | 曲目（樂章） | 檔案 | 拍號 | 反覆 | 展開後長度 | 速度 | 約略時間 | 為什麼選它 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 海頓 Op.76 No.3「皇帝」第二樂章 Poco adagio; cantabile（主題與變奏） | [sq20428156.mxl](https://github.com/OpenScore/StringQuartets/blob/9be3df2ace482130fe031b9e8a647cdf112ed243/scores/Haydn,_Joseph/String_Quartet_in_C_major,_Hob.III77,_Op.76_No.3/sq20428156.mxl) | 2/2 | **沒有** | 418 | ♩=80 | 5.2 分 | 最單純：沒有任何反覆，旋律有名。主題在四個聲部間輪流出現，很適合展示「多台裝置各演一部分」。有弱起小節（第 0 小節）。 |
| 2 | 莫札特 K.157 第三樂章 Presto | [sq9199617.mxl](https://github.com/OpenScore/StringQuartets/blob/9be3df2ace482130fe031b9e8a647cdf112ed243/scores/Mozart,_Wolfgang_Amadeus/String_Quartet_No.4_in_C_major,_K.157/sq9199617.mxl) | 2/4 | 一個 `:||` | 284 | ♩=187 | 1.5 分 | 短，用來測第一個反覆沒有開頭記號的情況（music21 會回到樂章開頭，這裡是對的）。 |
| 3 | 海頓 Op.1 No.1「狩獵」第一樂章 Presto | [sq8461409.mxl](https://github.com/OpenScore/StringQuartets/blob/9be3df2ace482130fe031b9e8a647cdf112ed243/scores/Haydn,_Joseph/String_Quartet_in_B-flat_major_(%E2%80%9CLa_Chasse%E2%80%9D),_Hob._III1,_Op.1_No.1/sq8461409.mxl) | 6/8 | 前後兩段各反覆一次 | 372 | ♩=187 | 2.0 分 | 短、音符少（四聲部共 977 個），但有 6/8 拍與弱起，可以順便確認「拍數」的定義。 |
| 4 | 莫札特 K.156 第二樂章 Adagio | [sq22643731.mxl](https://github.com/OpenScore/StringQuartets/blob/9be3df2ace482130fe031b9e8a647cdf112ed243/scores/Mozart,_Wolfgang_Amadeus/String_Quartet_No.3_in_G_major,_K.156_(K._134b)/sq22643731.mxl) | 4/4 | 前後兩段各反覆一次 | 296 | ♩=71 | 4.2 分 | 慢板、只有 37 小節，指揮手勢控制速度時最有感覺。 |
| 5 | 莫札特 K.156 第三樂章 Tempo di Menuetto | 同上 | 3/4 | 四段反覆＋「Menuetto da capo senza Ritornello」＋ Fine | 480（修正後） | ♩=120 | 4.0 分 | 刻意挑的**難題**：小步舞曲＋中段＋從頭再來到 Fine。拿來驗證第 4 節的補救做法。 |
| 備選 | 德弗札克 Op.96「美國」第二樂章 Lento | [sq8885439.mxl](https://github.com/OpenScore/StringQuartets/blob/9be3df2ace482130fe031b9e8a647cdf112ed243/scores/Dvo%C5%99%C3%A1k,_Anton%C3%ADn/String_Quartet_No.12,_Op.96_(%E2%80%9CAmerican%E2%80%9D)/sq8885439.mxl) | 6/8 | 沒有 | 291 | ♩=56（♪=112） | 5.2 分 | 有名、沒反覆，但和弦（123 個）與三連音較多、中途有速度變化，當第二批。 |

實測時四個聲部都讀得到（Violin 1、Violin 2、Viola、Violoncello），`transposition` 全部是 `None`。

## 3. music21 能與不能

實測環境：`pip install music21` 裝到的 **10.5.0**（也是 GitHub 最新 release [v10.5.0](https://github.com/cuthbertLab/music21/releases/tag/v10.5.0)），以下原始碼連結都指向這個 tag。

### 總表

| 項目 | music21 做得到嗎 | 我們要補什麼 |
| --- | --- | --- |
| 讀 `.mxl` | ✅ `converter.parse()` 直接讀 | — |
| 切樂章 | ❌ 沒有這個概念 | 依小節號重新從 1／0 開始的位置切開，並把第一/第二結尾的括號一起帶過去 |
| `||: :||` | ✅ 單一樂章內正確 | 開頭沒有 `||:` 時會回到**整段 stream 的開頭**，所以一定要先切樂章 |
| 第一/第二結尾 | ✅ 括號有帶到時正確（只實測一個樂章） | 括號掛在聲部層級，逐小節複製會弄丟 |
| 各聲部 `divisions` 不同 | ✅ 讀檔時就換算成四分音符 | — |
| D.C. / D.S. / Fine / Coda | ⚠️ 部分 | 只認固定文字；只認一個跳躍指令；每個聲部各自判斷 → 要自己把記號補到每個聲部 |
| 連結線合併 `stripTies()` | ✅ | 要在展開反覆**之後**做 |
| 移調 `toSoundingPitch()` | ✅（四重奏用不到） | 呼叫一次保險即可 |
| 每個音的位置 | ✅ `flatten()` 後的 `offset`，單位是四分音符 | 三連音會出現分數，要轉成小數；定義「拍」= 四分音符 |
| 速度 | ✅ `MetronomeMark.getQuarterBPM()` | 只在第一小提琴聲部；`.text` 可能是 music21 自己補的，不是譜上的字 |
| 排練記號 | ✅ `RehearsalMark` 讀得到 | 古典曲目大多沒有，要自己產生（例如用小節號） |
| 力度（vel） | ⚠️ `note.volume.velocity` 是 `None` | 用 `volume.getRealized()` 從前面的力度記號推，或自己對照 |
| 裝飾音 | ⚠️ 讀得到，但長度是 0 | 自己決定播不播、給多長 |

### 3.1 一個檔是整首，要先切樂章

music21 把整首四重奏讀成一條長譜。實測 10 個檔案，除了 Wolf《Italian Serenade》（本來就只有一個樂章），其他 9 個都能從「小節號變小」的位置切出正確的樂章數。抽查其中 5 個檔，每個樂章第一小節都有 `I.`、`II.` 這類文字。

**不先切的後果**：直接對整首呼叫 `expandRepeats()`，海頓「狩獵」從 807 個四分音符變成 18946（23 倍），海頓 Op.74 No.3 從 1653 變成 12516。原因是 music21 遇到沒有對應開頭的 `:||` 時會跳回整段 stream 的開頭，也就是第一樂章（見 3.2）。切成單一樂章後長度都回到合理範圍，但「長度合理」不代表順序對，有第一/第二結尾的樂章要另外檢查（見 3.2 第 7 點）。

**各聲部 `divisions` 不一致不是問題**：MusicXML 用 `<divisions>` 表示「一個四分音符切成幾份」，每個聲部可以不同。music21 讀檔時每個聲部各自記住目前的 `divisions`（[xmlToM21.py L5866-L5881](https://github.com/cuthbertLab/music21/blob/v10.5.0/music21/musicxml/xmlToM21.py#L5866-L5881)），再把每個音的 `<duration>` 除以它換成四分音符（[L3735-L3739](https://github.com/cuthbertLab/music21/blob/v10.5.0/music21/musicxml/xmlToM21.py#L3735-L3739)），所以讀進來之後所有聲部都是同一個單位。實測過的樂章（莫札特 K.157 第一樂章、海頓「狩獵」第一樂章）四個聲部展開後總長都一致。

### 3.2 `expandRepeats()`：簡單反覆可以，跳躍要小心

**做得到的**（單一樂章內，實測）：

- 莫札特 K.157 第一樂章 `:|| ||: :||`：504 → 1008，前後兩段各反覆一次，正確。
- 莫札特 K.156 第三樂章四段反覆：小節順序 `1-14 1-36 15-46 37-62 47-62`，就是每段各彈兩次，正確。
- 沒有開頭 `||:` 的第一個 `:||` 會回到開頭。原始碼 [`repeatBarsAreCoherent()`](https://github.com/cuthbertLab/music21/blob/v10.5.0/music21/repeat.py#L900-L948) 的註解寫「we have an acceptable case where the first repeat is omitted」。

**做不到或會出錯的**：

1. **每個聲部各自展開。** `Score.expandRepeats()` 對每個 part 分別呼叫 `p.expandRepeats()`（[stream/base.py L13981-L14014](https://github.com/cuthbertLab/music21/blob/v10.5.0/music21/stream/base.py#L13981-L14014)）。但 MuseScore 匯出的 Fine、D.C. 只掛在第一小提琴上。實測德弗札克 Op.96 第三樂章（Da Capo al Fine）：

   | 聲部 | 展開前 | 展開後 |
   | --- | --- | --- |
   | Violin 1（有 Fine 與 D.C.） | 588 | **732** |
   | Violin 2 / Viola / Cello（沒有） | 588 | **588** |

   直接用的話，第一小提琴會比其他人多彈 48 小節。反覆小節線（`||: :||`）每個聲部都有，所以沒這個問題。

2. **只認得固定寫法。** 文字記號靠 [`isValidText()`](https://github.com/cuthbertLab/music21/blob/v10.5.0/music21/repeat.py#L161-L177) 比對：去掉空白與句點、轉小寫後要**完全相等**。可接受的寫法列在 [repeat.py L206-L393](https://github.com/cuthbertLab/music21/blob/v10.5.0/music21/repeat.py#L206-L393)，例如 `Da Capo`、`D.C.`、`Da Capo al fine`、`D.C. al fine`、`Dal Segno`、`D.S. al Coda`、`fine`、`Coda`、`to Coda`、`Segno`。實測 OpenScore 檔案裡的：
   - `Da Capo al Fine`（德弗札克）→ ✅ 認得
   - `M. D. C.`（海頓「狩獵」）→ ❌ 當一般文字
   - `Menuetto D.C.`（海頓「皇帝」）→ ❌
   - `Menuetto da capo senza Ritornello`（莫札特 K.156）→ ❌

   認不出來時 music21 不會報錯，只是**不跳**，所以小步舞曲會少彈最後那一段。

3. **`<sound dacapo="yes"/>` 沒被讀。** 上面認不出來的那幾個，MusicXML 裡其實都同時有 `<sound dacapo="yes"/>` 與 `<sound fine="yes"/>`（實測四個檔都有）。但 music21 的 [`setSound()`](https://github.com/cuthbertLab/music21/blob/v10.5.0/music21/musicxml/xmlSoundParser.py#L58-L92) 註解寫明「Presently only handles `<sound tempo='x'>` events」，`dacapo`、`dalsegno`、`fine`、`tocoda`、`segno`、`coda` 都還是 `TODO`。`<segno>`、`<coda>` 這兩個**符號**元素則有讀（[xmlToM21.py L5606-L5616](https://github.com/cuthbertLab/music21/blob/v10.5.0/music21/musicxml/xmlToM21.py#L5606-L5616)）。

4. **一段裡只能有一個跳躍指令。** [`_daCapoOrSegno()`](https://github.com/cuthbertLab/music21/blob/v10.5.0/music21/repeat.py#L950-L969) 只有在 D.C. 類剛好一個、或 D.S. 類剛好一個時才處理，原始碼註解「for now, only accepting one segno」；多於一個就當作沒有。[`_daCapoIsCoherent()`](https://github.com/cuthbertLab/music21/blob/v10.5.0/music21/repeat.py#L1000-L1025) 另外要求：D.C. al Fine 要剛好一個 Fine，D.C. al Coda 要剛好兩個 Coda 記號，不符合就丟 `ExpanderException`。整首多樂章的檔常有兩個以上的 D.C.，這也是一定要先切樂章的理由。

5. **D.C. 之後不再反覆。** `DaCapo` 等跳躍指令的 `repeatAfterJump` 預設是 `False`（[repeat.py L254-L268](https://github.com/cuthbertLab/music21/blob/v10.5.0/music21/repeat.py#L254-L268)），也就是從頭再來時跳過反覆，這正好符合小步舞曲的慣例（senza ritornello）。

6. **反覆記號不成對時會展開錯。** 海頓「狩獵」第二樂章（小步舞曲＋中段）的中段只有 `:||` 沒有 `||:`，music21 回到樂章開頭而不是中段開頭，展開出來的順序是 `1-10 1-34 11-48 1-10 …`，不是演奏者會彈的順序。music21 上還開著的 [#1713](https://github.com/cuthbertLab/music21/issues/1713) 是同樣的情況，一位留言者（不是維護者）認為這種譜「is a gray area, not really a bug」，維護者沒有表態。另一張還開著的 [#1502](https://github.com/cuthbertLab/music21/issues/1502) 原本回報 `expandRepeats()` 跑非常久，回報者後來發現是譜本身少了 `||:`，補上後就跑得完；維護者 mscuthbert 在那裡的說法是每個 `:||` 都要有自己對應的開頭（樂曲開頭算一個隱含的開頭）。所以這種譜比較像是要先修譜或先檢查，不能指望 music21 猜對。我們的候選樂章每個都在幾秒內展開完。

7. **切樂章時要把第一/第二結尾的括號帶過去。** 結尾括號（`spanner.RepeatBracket`）不在小節裡，而是掛在整個聲部上。只把小節一個個 `deepcopy` 到新的 `Score`，括號就不見了：海頓「皇帝」第一個聲部原本有 6 個括號，這樣切完剩 0。這時展開的總長（507.5 → 1003.5）看起來合理，但第一結尾被彈了兩次，順序是錯的。

   把原聲部裡屬於這個樂章的括號，依小節位置對應到複製後的小節重新建一個，再展開，順序就對了：`0-43 43X1-43X3 0-119 119X4-119X6 45-121`：第一次彈第一結尾（43X1–43X3），反覆時跳過它、接第二結尾（第 44 小節）一路到 119；後半段同理，第二次跳過 119X4–119X6、接第 120 小節。

   小節號重複（好幾個 43、119）是 MuseScore 本來就有的：同一小節被拆成幾段時會加上 `numberSuffix`（`X1`、`X2`…），不是 music21 產生的。

   這次只在這一個樂章上核對過。5 個候選樂章都沒有結尾括號，不受影響；抽查的檔裡有括號的是「皇帝」第一、四樂章與「狩獵」第四樂章。

### 3.3 D.C. / D.S. / Coda 支援程度

music21 定義的類別（[repeat.py](https://github.com/cuthbertLab/music21/blob/v10.5.0/music21/repeat.py#L180-L393)）：

- 位置記號：`Segno`、`Coda`、`Fine`
- 跳躍指令：`DaCapo`、`DaCapoAlFine`、`DaCapoAlCoda`、`AlSegno`、`DalSegno`、`DalSegnoAlFine`、`DalSegnoAlCoda`

在限制條件內（一段只有一個指令、記號數量對得上、文字寫法完全符合）這些都會展開。實測德弗札克 Op.96 第三樂章 `Da Capo al Fine` 從 196 小節展開成 244 小節（196＋回到開頭彈到第 48 小節的 Fine），正確，只是其他聲部沒跟上（見 3.2 第 1 點）。D.S.／Coda 的實際曲目這次沒有遇到，沒實測。

### 3.4 補救做法

在單一樂章上做這兩步之後再 `expandRepeats()`：

1. 找到 MusicXML 裡帶 `<sound dacapo="yes"/>` 的那個文字，換成 `repeat.DaCapoAlFine()`（樂章裡有 `<sound fine="yes"/>` 時）或 `repeat.DaCapo()`。
   - ⚠️ **這一步的正式做法還沒實測。** 實測時用的是簡化版：只看樂章最後一小節，文字裡有 `capo` 或 `d.c` 就換掉。music21 讀檔時把 `<sound>` 的這些屬性丟掉了，要靠 `<sound dacapo>` 定位，得另外解析 XML，再依小節與位置對回 music21 的物件。這段對應還沒寫過。
2. 把第一小提琴上所有 `RepeatExpression`（Fine、Coda、Segno、D.C. …）複製到其他三個聲部的同一個小節、同一個位置。

實測結果（D.C. 用上面說的簡化版找）：

| 樂章 | 補救前 | 補救後 | 對不對 |
| --- | --- | --- | --- |
| 莫札特 K.156 第三樂章 | 四個聲部都是 372，D.C. 沒展開 | 四個聲部都是 480（`… 47-62` 後接 36 小節從頭再來，不再反覆） | ✅ 124＋36＝160 小節 × 3 拍 |
| 德弗札克 Op.96 第三樂章 | 第一小提琴 732，其他 588 | 四個聲部都是 732 | ✅ |

注意：展開後 D.C. 那段的小節會被**重新編號**（例如 63-98），不能拿小節號回頭對照原譜。

「反覆記號不成對」（3.2 第 6 點）這次沒有補救，候選清單先避開這種樂章（海頓「狩獵」只選第一樂章）。

### 3.5 `stripTies()`：連結線合併

[stream/base.py L7168-L7190](https://github.com/cuthbertLab/music21/blob/v10.5.0/music21/stream/base.py#L7168-L7190)：把連在一起的音合成一個，長度加總。文件裡寫明限制：「Presently, this only works if tied notes are sequential in the same voice」，也就是只處理同一個聲部內同一條旋律線（MusicXML 的 `<voice>`）裡前後相鄰的音。實測莫札特 K.157 第一樂章中提琴開頭被合成一個 6.5 拍的長音，正確。

順序上要**先展開反覆、再合併連結線**：連結線可能跨進第一/第二結尾，先合併的話展開時會切錯。

### 3.6 `toSoundingPitch()`：移調

[stream/base.py L5388](https://github.com/cuthbertLab/music21/blob/v10.5.0/music21/stream/base.py#L5388)：「If not at sounding pitch, transpose all Pitch elements to sounding pitch」，會看樂器與八度記號（Ottava）。如果整份譜都不知道是不是實際音高，就不動。弦樂四重奏四個聲部都沒有移調（實測 `transposition` 全是 `None`），第一版其實用不到，但呼叫一次沒有壞處，也能處理譜上的 8va。

### 3.7 取得每個音的位置

`part.flatten().notes` 之後每個音的 `.offset` 就是從樂章開頭算起的位置，單位是四分音符，`.quarterLength` 是長度，`.pitches` 裡的 `.midi` 是 MIDI 音高（和弦會有好幾個）。實測取出的中間形式（還不是最終格式）：

```json
[{"beat": 0.0, "dur": 1.5, "pitch": [60]}, {"beat": 1.5, "dur": 0.5, "pitch": [62]}, {"beat": 2.0, "dur": 1.0, "pitch": [64]}]
```

寫成 `initial-research.md` 的格式時，和弦要拆成好幾筆、每筆一個 `pitch` 數字，並補上 `vel`（見 3.9），例如 `{ "beat": 1.5, "dur": 0.5, "pitch": 62, "vel": 80 }`。

幾個要注意的地方：

- **「拍」要定義成四分音符。** music21 的單位永遠是四分音符，跟拍號無關。6/8 拍（候選 3）的一小節是 3 個單位，2/2 拍（候選 1）的一小節是 4 個單位。JSON 裡的 `beat` 與 `defaultBpm` 都用四分音符最省事，但拍數對照與指揮手勢那邊要知道「一拍」不一定是指揮打的一下。
- **三連音的位置是分數**（`Fraction`），寫進 JSON 前要轉成小數。
- **弱起小節**：樂章從第 0 小節開始的話，第一個音的位置是 0，不是從一個完整小節算起（海頓「狩獵」第一樂章的弱起只有半拍多）。
- **裝飾音**的 `quarterLength` 是 0（實測 K.157 第一樂章第一小提琴展開後有 92 個）。

### 3.8 速度與排練記號

- **速度**：MuseScore 匯出的速度文字（例如 `Presto`）與播放速度 `<sound tempo="187"/>` 是分開的。music21 把前者讀成 `TextExpression`，後者讀成 `MetronomeMark`（[xmlToM21.py L5549-L5560](https://github.com/cuthbertLab/music21/blob/v10.5.0/music21/musicxml/xmlToM21.py#L5549-L5560)）。用 `getQuarterBPM()`（[tempo.py L605](https://github.com/cuthbertLab/music21/blob/v10.5.0/music21/tempo.py#L605)）可以換算成每分鐘四分音符數，例如德弗札克第二樂章的「♪=112」會換成 56。
  - `MetronomeMark.text` 可能是 music21 自己依數字補上的義大利文（[tempo.py L467-L477](https://github.com/cuthbertLab/music21/blob/v10.5.0/music21/tempo.py#L467-L477)，`textImplicit=True`），實測莫札特 K.157 那個 ♩=120 被標成 `animato`，譜上並沒有這個字。要顯示譜上的速度字請讀 `TextExpression`。
  - 速度記號只在第一小提琴聲部，其他聲部找不到。
  - 這個數字是 OpenScore 編輯者設的播放速度，不一定是作曲家的標記。
- **排練記號**：MusicXML 的 `<rehearsal>` 會讀成 `expressions.RehearsalMark`（[xmlToM21.py L5625-L5629](https://github.com/cuthbertLab/music21/blob/v10.5.0/music21/musicxml/xmlToM21.py#L5625-L5629)），`.content` 是文字。實測整份檔讀到的數量（可能含各聲部重複的）：Wolf《Italian Serenade》37 個（A、B、C…），德弗札克 Op.96 51 個（1、2、3…），但**其他 8 個古典曲目檔一個都沒有**。JSON 的 `marks` 大多得自己產生，例如用樂章內的小節號或反覆段落的開頭。

### 3.9 力度

實測 `note.volume.velocity` 全部是 `None`：music21 不會自動把 `p`、`f` 這些記號換成每個音的力度。[`Volume.getRealized()`](https://github.com/cuthbertLab/music21/blob/v10.5.0/music21/volume.py#L165-L272) 會往前找最近的力度記號（`Dynamic`）與奏法記號，算出 0–1 之間的值，可以乘 127 當 `vel`。從原始碼看它只看力度記號與奏法，**沒看到處理漸強、漸弱的楔形記號**，這部分沒實測。

## 4. 我們要自己處理的清單

照處理順序：

1. 下載 `.mxl`，用小節號重新開始的位置切出單一樂章，並把屬於這個樂章的第一/第二結尾括號（`RepeatBracket`）對應到新的小節上一起帶過去。
2. 在每個樂章裡：另外解析 XML 找出帶 `<sound dacapo>` 的位置，把那段文字換成 music21 的 `DaCapo`／`DaCapoAlFine`；再把第一小提琴上**所有** `RepeatExpression`（D.C.、D.S. 這類跳躍指令，加上 Fine、Segno、Coda 這類位置記號）複製到其他聲部。只複製 D.C. 不複製 Fine 的話，其他聲部會有 `DaCapoAlFine` 卻沒有 Fine，music21 會丟 `ExpanderException`。
3. `expandRepeats()`，並檢查四個聲部展開後的長度相同（不同就代表還有沒補到的記號）。
4. `stripTies()`、`toSoundingPitch()`。
5. 每個聲部 `flatten().notes` → `beat`（轉小數）、`dur`、`pitch`（和弦拆開）、`vel`（`getRealized()`）。裝飾音另外處理。
6. 從第一小提琴取 `MetronomeMark` 當 `defaultBpm` 與中途的速度變化；`marks` 用 `RehearsalMark`，沒有就自己產生。
7. 反覆記號不成對的樂章（3.2 第 6 點）先不收，或人工指定展開順序。

另外有一個要決定的事：**一個「曲目」對應一個樂章還是整首四重奏**。檔案是整首，但速度、反覆都是以樂章為單位，而且一首四重奏常超過 20 分鐘。建議第一版一個曲目 = 一個樂章。

## 5. Verovio 比較

Verovio 是研究文件提到的另一條路（在指揮端用 WebAssembly 即時轉換）。這次用 `pip install verovio` 裝到的 6.3.0 實際跑了一次，並讀了它的 MusicXML 讀取器原始碼。

| 項目 | Verovio | 來源 |
| --- | --- | --- |
| 時間資訊輸出 | `renderToTimemap()` 回傳事件清單，每筆有 `qstamp`（四分音符為單位的位置）、`tstamp`（毫秒）、`tempo`、`on`／`off`（這個時間點開始／結束的音的 id），`includeMeasures` 選項會加上 `measureOn` | [Output formats](https://book.verovio.org/toolkit-reference/output-formats.html#timemap)、[Toolkit methods](https://book.verovio.org/toolkit-reference/toolkit-methods.html) |
| 音高 | timemap 只有 id，要再對每個 id 呼叫 `getMIDIValuesForElement()`（要先 `renderToMIDI()`）才拿得到 `pitch`、`duration`。實測可行，回傳 `{'pitch': 74, 'time': 0, 'duration': 608}` | 同上 |
| 分聲部 | timemap 是整份譜合在一起，要自己用 id 查它屬於哪個聲部 | 實測 |
| 反覆展開 | MusicXML 讀取時會建立展開順序（expansion），`renderToExpansionMap()` 可以看到每個原始音被展開成幾份（`xxx-rend2`、`xxx-rend3` …） | 實測；[iomusxml.cpp `CreateExpansion()`](https://github.com/rism-digital/verovio/blob/3120890a5adcee6f8ac7e5ce03974867315adc2a/src/iomusxml.cpp#L1323) |
| D.C. / D.S. / Fine / Coda | **讀 `<sound>` 的 `dacapo`、`dalsegno`、`tocoda`、`fine`、`segno`、`coda` 屬性**，不靠文字比對。這正好是 music21 缺的那塊 | [iomusxml.cpp L4178-L4226](https://github.com/rism-digital/verovio/blob/3120890a5adcee6f8ac7e5ce03974867315adc2a/src/iomusxml.cpp#L4178-L4226) |
| 多樂章檔 | ❌ 一樣會出問題。實測莫札特 K.156 整份檔：timemap 最後一個 `qstamp` 是 2094，而三個樂章各自正確展開後加總應為 1316（540＋296＋480）；第一樂章第一個音在展開表裡出現 4 份。推測是第三樂章的 D.C. 跳回整份檔的開頭，**原因沒有追到底** | 實測 |

**判斷**：Verovio 在「認得 D.C.」這點比 music21 好，但輸出的形狀（整份譜一條時間線＋音的 id）離我們要的「每個聲部一份音符清單」比較遠，而且一樣要先切樂章。第一版在建置時用 music21 加上第 3.4 節的補救比較直接；「上傳任意 MusicXML」那一版如果要在瀏覽器裡轉，再回頭評估 Verovio。

## 6. 沒查到或沒驗證的

- **OpenScore 官網 `openscore.cc`** 沒讀到，OpenScore 的說明改以 GitHub 官方鏡像的 README 為準。
- **MuseScore 網站 `musescore.com`** 對程式抓取回 403，沒讀到 OpenScore 帳號頁本身的說明。檔案與授權都以 GitHub 鏡像為準，README 自稱是該帳號的官方鏡像。
- **music21 線上文件**：WebFetch 抓到的模組說明頁內容不完整，所以改讀原始碼與 docstring（這就是線上文件的來源），連結都指向 v10.5.0 tag。
- D.S.／Coda 跳躍沒有找到實際曲目測試，只有讀原始碼。
- 第一/第二結尾只在海頓「皇帝」第一樂章核對過（3.2 第 7 點）。
- 楔形記號（漸強、漸弱）對力度的影響沒實測。
- Verovio 在單一樂章上的展開結果有沒有正確，沒有測（要先把 MusicXML 切成單一樂章的檔案）。

<details>
<summary>實測方式</summary>

- 在 scratch 目錄的 venv 裡 `pip install music21 verovio`（music21 10.5.0、Verovio 6.3.0），從 GitHub raw 下載 10 個 `.mxl`：海頓 Op.1 No.1、Op.64 No.5、Op.74 No.3、Op.76 No.3，莫札特 K.155、K.156、K.157，舒伯特 D.18，德弗札克 Op.96，Wolf《Italian Serenade》。
- 切樂章：取第一個聲部的小節清單，在 `number` 比前一個小的位置切開，四個聲部用同樣的索引範圍各自 `deepcopy` 小節，組成新的 `Score`。這樣切會弄丟結尾括號（3.2 第 7 點），核對「皇帝」第一樂章時另外把括號重建回去。
- 檢查展開結果：把展開後第一個聲部的小節號寫成連續區段（例如 `1-14 1-36 15-46`），跟譜上的反覆位置人工比對。
- 補救做法的程式碼重點：

```python
from music21 import repeat, expressions, stream
import copy

p0m = list(mv.parts[0].getElementsByClass(stream.Measure))
last = p0m[-1]
for te in list(last.getElementsByClass(expressions.TextExpression)):
    if 'capo' in te.content.lower() or 'd.c' in te.content.lower():
        last.remove(te)
        last.insert(0, repeat.DaCapoAlFine())
for p in mv.parts[1:]:
    pm = list(p.getElementsByClass(stream.Measure))
    for i, m in enumerate(p0m):
        for x in m.getElementsByClass(repeat.RepeatExpression):
            pm[i].insert(x.offset, copy.deepcopy(x))
expanded = mv.expandRepeats()
```

  這段是驗證用的，用文字找 D.C.；正式版應該改成看 MusicXML 裡的 `<sound dacapo="yes"/>`。

</details>
