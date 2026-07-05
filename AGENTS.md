# 始终以中文回复

## Agent skills

### Issue tracker

Issues（含 PRD）存放于 GitHub Issues（仓库 haoyiqiang/ai-sdk-provider-pi），用 gh CLI 操作；外部 PR 也作为 triage 队列入口。详见 `docs/agents/issue-tracker.md`。

### Triage labels

使用五个标准 triage label：needs-triage / needs-info / ready-for-agent / ready-for-human / wontfix（wontfix 复用仓库现有同名 label）。详见 `docs/agents/triage-labels.md`。

### Domain docs

单一 context 布局：根级 CONTEXT.md + docs/adr/。详见 `docs/agents/domain.md`。