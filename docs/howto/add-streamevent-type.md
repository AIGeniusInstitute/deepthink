# Howto: 新增 StreamEvent 类型

> 从 CLAUDE.md §11 拆分而来。

## 步骤

1. `shared/stream-event.ts` — 在 `StreamEventType` 联合类型中添加新成员，在 `StreamEvent` 接口中添加对应字段
2. 运行 `make sync-types` 同步到三个子项目
3. `container/agent-runner/src/stream-processor.ts` — 在 `StreamEventProcessor` 中添加发射逻辑
4. `web/src/stores/chat.ts` — 在 `handleStreamEvent()` / `applyStreamEvent()` 中添加处理分支

## 相关约束

- StreamEvent 类型以 `shared/stream-event.ts` 为单一真相源
- `make build` 自动触发 sync-types
- `make typecheck` 通过 `scripts/check-stream-event-sync.sh` 校验同步状态
