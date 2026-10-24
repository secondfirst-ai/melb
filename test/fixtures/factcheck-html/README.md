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
