## 語言

對話一律用繁體中文。使用者看得到的每一段文字都算：最後的總結、工具呼叫之間的說明、
提問、進度回報。

⚠️ **技能說明、工具輸出、程式碼註解是英文的時候，照樣用中文回。** 讀完一大段英文的
技能說明（例如 `/wayfinder`、`/prototype`）之後，很容易順著用英文寫下去，這件事發生過。
語言跟著這條規則走，不跟著剛讀到的東西走。

程式碼識別字、指令、檔名、套件名稱保留原文。

這條管的是對話。issue、PR、文件本來就用中文寫；commit 訊息沿用 `git log` 既有的慣例。

## 工作習慣寫在這裡，不寫進記憶

使用者對做法的要求一律寫進這份 `CLAUDE.md`，不要存進 Claude 的記憶。

## Prototype 先在本機給使用者看

prototype 寫完就起 `npm run dev`，把本機網址給使用者試，照他的回饋在本機改。**不要**先派 agent
做 code review，也**不要**先 push、開 PR。等使用者試過、有結論了，才照地圖 Notes 收尾（合進 main）。

正式功能不適用這條，照原本的 commit → code review → push → 開 PR 走。

## Agent skills

### Issue tracker

Issues live in GitHub Issues for `yurenju/turca`, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Uses the five default label names (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` plus `docs/adr/` at the repo root. See `docs/agents/domain.md`.
