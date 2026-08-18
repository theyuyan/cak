# Golden E2E fixtures（G1–G8）

判据来源：`docs/design/06_RUNTIME_LOOP.md §8`、`09_TEST_ACCEPTANCE.md §2`。
每个 fixture 含：Agent Spec 引用 · 输入 · **Mock 后端脚本**（按调用序号给固定响应）· 夹具动作（如审批方写 grant）· **期望事件类型序列**（账本里 `type` 的有序子序列，允许中间夹 `bundle.composed` / `usage.recorded` 之类噪音事件，除非 `strict: true`）· 期望结论。

约定：
- `mockBackend.script[i]` 是第 i 次 `model.generate@1` 调用的响应；`toolCalls[].handle` 用符号名（`$h.file`），运行器按 Spec `grants` 顺序解析为真实 handleId。
- 事件序列里 `…` 表示"任意其他事件"；`×N` 表示重复。
- 两次运行除 `ts` / `seq` / 随机 id 外账本必须相同（`repeatable: true`）。
