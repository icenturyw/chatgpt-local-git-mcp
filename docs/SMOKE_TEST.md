# Smoke Test

本项目在打包前已做基础烟测：

- `npm install`
- `npm run build`
- 使用临时 Git 仓库启动 MCP Server
- 使用 MCP TypeScript Client 连接 `/mcp`
- `list_repos` 成功
- `read_file` 成功返回 `sha256`
- `create_branch` 成功创建本地分支
- `write_file` 成功写入允许文件
- `git_diff` 成功返回 diff
- `git_add` 成功 stage
- `git_commit` 成功创建本地 commit
- `prepare_push` 成功返回命令字符串，未执行 push

烟测命令结果摘要：

```text
tools: 13
repo: sample
local commit created
push command generated: git push -u origin feat/smoke
```
