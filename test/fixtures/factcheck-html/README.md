# HTML factcheck 离线材料

以下 `.txt` 是 2026-10-25 从公开页面抓取、用现有 `scripts/html-text.py` 提取后截取的相关正文片段，每页最多 25 词，保留大小写。测试只读这些文件，不联网；它们用于复现指定的匹配场景，不表示保存了整页。

| 文件 | 出处 |
| --- | --- |
| xero.txt | https://www.xero.com/au/pricing-plans/ |
| xero-ai.txt | https://www.xero.com/au/ai-in-accounting/ |
| xero-reconcile.txt | https://www.xero.com/au/accounting-software/reconcile-bank-transactions/ |
| microsoftFAQ.txt | https://support.microsoft.com/en-au/microsoft-copilot/privacy-faq-for-microsoft-copilot |
| microsoftControls.txt | https://support.microsoft.com/en-au/microsoft-copilot/microsoft-copilot-privacy-controls |
| gemini.txt | https://support.google.com/gemini/answer/13594961?hl=en |
| digitalSolutions.txt | https://www.melbourneinnovation.com.au/digital-solutions |

`xero-guide-before.html` 由 Jian 给的 `case1-guide04-before-884e583.html` 原样复制。

`acceptance-excerpts.json` 是 Jian 的 `cases.md` 明确给出的两段出处文字，冻结验收语义，不冒充本次公开网页快照：

- 验收 3 给的是 `Keep activity`，本次 Google 正文里已出现 `Keep Activity`。
- 验收 5 给的原话句尾是句号，本次 Microsoft FAQ 是逗号并接 `unless you choose to opt back in`。

因此测试既核对这两段约定的近似/完全匹配结果，也对本次抓取的片段另测目前的实际结果。以后替换片段时，应确认是出处变动还是算法回归。

## 2026-10-26：三类误报（单 52cc34）

- `tradify-aud.txt`：从 https://www.tradifyhq.com/au/pricing 的 HTTP 正文抽出的三处澳元价格和 Plus 原话，按行拼接。指南 https://melb.si/guides/ai-quoting-rostering-ordering-australia 引的是 `/pricing`；本次该全球入口从当前网络返回 USD，不能冒充澳元。澳洲入口实际返回 `$48 AUD` / `$52 AUD` / `$62 AUD`，用于冻结本单澳元写法场景。
- `review-date.html`：上述指南末段单独的 `As of 26 October 2026.` 引用句，保留为最小 HTML fixture，不包含其他事实句。
- `deputy-http.html`：https://www.deputy.com/au/pricing 的 HTTP 正文目前能读到 `Deputy AIINTRODUCTORY FREEPrice…` 的拼接片段，原话没有独立词边界。fixture 用 div 包住这段实际正文，并保留空 script 标记表示原页存在脚本，不复制整页 JS，不声称这是原 HTML 的连续字节片段。
- `deputy-rendered.txt`：Jian 在 BRIEF 指定的期望原话，供假 OfficeReader 模拟渲染后补读；**未用真实 CDP 抓取**。Wen 真跑时仍要确认实际 DOM 是否给出独立原话。测试的长正文填充在测试代码里生成，不混进公开出处快照。

新增公开出处片段每站不超过 25 词。所有测试离线，不联网、不调模型、不连接办公室浏览器。

## 10-26 退回修正：Deputy 是文字粘连

Wen 真实 OfficeReader 读取确认 HTTP 和浏览器均为同一段粘连文字，不是缺少 JS 渲染。`deputy-joined.txt` 直接从本单 `deputy-live.txt` 提取 `monthly instalments` 到 `Features` 的原始片段（10 词）；它与 `deputy-http.html` 一起验证两句多词原话无需浏览器即可命中。匹配时只放宽相邻字母，不移除引文内部空格，不放宽单词或带数字/金额的引文。

渲染回退的 mock 改用测试代码内明确构造的缺原话 HTML shell，保留原回退行为的覆盖；不再拿实际 Deputy 粘连片段假设成“渲染后才有”。`deputy-rendered.txt` 仍只是前一轮约定的假渲染输入。旧来源说明保留用于追溯，以本节修正为准。

prices-2026-10-28.json保存每周价格报告里的原句与原页首段（2026-10-28），没有再次抓取。报告的Giday首段未包含50c：测试明确另接一条合成50c价格行；ChatGPT/Claude渲染价格、等待及锁均用合成fixture，不代表实时网站。
