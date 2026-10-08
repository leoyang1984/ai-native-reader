# 安静的阅读助手 / A quieter reading companion

Reader v0.1.6 · 2026-10-08

## 改变 / Changes

- 回答正文不再被要求例行说明检索范围、未命中的笔记/想法/Vault。只有缺口影响本次问题时，提示模型用至多一句具体说明，并回答可回答的部分。
- 同一书籍和章节范围内，已说明的限制不重复；换书、换章或出现新的相关缺口时，才重新简要说明。读者主动询问资料范围时仍如实回答。
- 默认只显示“原文依据 · N”或“参考依据 · N”。点击展开可查看原文摘录、补充资料种类、匹配和使用数量、检索覆盖限制以及原文回跳。没有引文时显示“资料范围”。
- 正文摘录与笔记/Vault 检索覆盖分别说明。补充资料未命中或索引未完成不代表书内正文缺失；当前发送的是有限摘录，不能宣称已提供整章全文。
- 检索匹配数量指 Reader 找到的补充资料候选，使用数量指发送的补充资料，不代表回答已引用的数量。引文数量由来源折叠区标题另行显示。
- 共享提示适用于 Codex 与 pi。发送模型的检索范围描述不包含本机 Vault 目录地址。

Answers no longer receive a standing instruction to append retrieval disclaimers or list missing notes, ideas and Vault materials. Models are asked to mention a gap in at most one sentence only if it affects this question. Already explained limitations should not be repeated within the same book/chapter scope, unless the scope changes or a new relevant gap appears. Explicit questions about coverage are still answered honestly.

The existing Sources disclosure is collapsed by default. Open it for book excerpt coverage, supplementary materials, matched/sent counts, limitations, citations and navigation. Without citations, a Material scope disclosure remains available. Supplementary retrieval coverage and book excerpts are described separately: a partial Vault search does not mean book text is missing, and bounded excerpts are not a verified complete chapter. Match/sent counts describe supplementary candidates and supplied items; the citation count is separate. The shared prompt applies to Codex and pi, and model-visible coverage omits private Vault directory locations.

## 保留与边界 / Scope

旧回答正文保持原样，不通过关键词删句或改写历史；旧回复下的界面检索说明也移至折叠区。现有对话协议和指令契约版本保持兼容，更新后重连助手，后续回复使用新的每轮提示，无需清空对话。

资料限制的措辞由模型生成，新规则减少模板提醒，但无法保证所有模型始终遵循；不会事后截删可能影响判断的内容。真实资料不足、断线、回答失败、停止和引用有效性校验仍保留。

Past answer text is preserved; it is not trimmed by keyword matching. Its UI retrieval metadata moves into the disclosure too. Conversation contracts remain compatible; reconnect after updating to use the new per-turn guidance without clearing history. Generated wording still depends on the model, so compliance cannot be guaranteed. Important evidence gaps, connection failures, cancellation and citation validation remain available.

## 交付检查 / Delivery checks

本次完成源码审查、前端及原生构建、公开源码扫描和发行包完整性检查。未新增或运行实现测试，未发送真实模型问题；新规则的真实模型回复与完整桌面交互尚未验收。

Source review, frontend/native builds, public-source scanning and release integrity checks are performed. No implementation tests or live model prompts were run; live wording and full desktop interaction have not been revalidated.
