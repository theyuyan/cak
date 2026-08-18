# minimal-file-agent（G1 的命令行版）

    npx tsx bin/cak.ts run docs/design/08_AGENT_SPEC.example.yaml \
      --input "读取 workspace/test.txt，然后总结内容。" \
      --workspace examples/minimal-file-agent \
      --mock-script examples/minimal-file-agent/mock-script.json \
      --ledger tmp/ledger.ndjson --verbose

mock 后端按脚本回答（M1 不接真模型）；`--verbose` 打印账本每条事件；`--ledger` 落文件账本（可重启恢复）。
