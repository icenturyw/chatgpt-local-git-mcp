# ChatGPT 接入步骤

## 1. 确认限制

ChatGPT 自定义 MCP/App 需要 ChatGPT 能访问的远程 HTTPS MCP endpoint。`localhost` 通常不能直接使用。

推荐开发方案：

```bash
npm run dev
ngrok http 3000
```

ChatGPT 填：

```text
https://你的-ngrok-域名/mcp
```

## 2. 创建自定义 App / MCP

在 ChatGPT Web：

```text
Settings / Workspace settings
→ Apps
→ Create
→ Developer mode
→ 填 MCP Server URL
→ Scan Tools
→ Create
```

具体入口会随着 ChatGPT 版本变化，以页面实际显示为准。

## 3. 建议测试提示词

```text
使用 Local Git MCP。先 list_repos，确认有哪些仓库。然后对 ai-btms 执行 git_status，只读取文件，不要修改。
```

确认只读能用后，再测试写入：

```text
使用 Local Git MCP 操作 ai-btms。创建本地分支 feat/chatgpt-readme-test，在 README.md 末尾追加一行测试说明，展示 git_diff，不要 commit，等我确认。
```

确认完整流程：

```text
使用 Local Git MCP 操作 ai-btms。创建本地分支 feat/chatgpt-safe-test，修改 README.md，运行 pytest，展示 git_diff。等我确认后 git_add 和 git_commit。最后 prepare_push，只输出命令，不要 push。
```

## 4. 常见问题

### ChatGPT 扫描不到工具

检查：

```bash
curl https://你的域名/healthz
```

再确认：

- 你的 MCP URL 是 `/mcp`，不是 `/healthz`。
- HTTPS 证书有效。
- 服务日志没有报错。
- 如果设置了 `MCP_AUTH_TOKEN`，ChatGPT 是否能发送对应认证。不能的话先关闭 token，改用私有 tunnel 或反代访问控制。

### 写文件失败：expected_sha256 is required

这是安全策略。先让 ChatGPT 调 `read_file`，拿到返回的 `sha256`，再调用 `write_file`。

### 不能修改某个目录

编辑 `config.yaml`：

```yaml
allowedWritePaths:
  - app
  - static
  - tests
  - README.md
```

把需要允许的路径加进去。不要把 `.env`、`.git`、私钥目录加进去。
