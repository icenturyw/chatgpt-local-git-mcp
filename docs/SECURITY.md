# 安全说明

这个项目的安全目标是：让 ChatGPT 能辅助开发，但不直接拥有 GitHub 写权限。

## 威胁模型

需要防的主要风险：

1. Prompt injection 诱导模型读取或写入敏感文件。
2. 模型误操作覆盖重要文件。
3. 任意 shell 命令导致服务器被破坏。
4. 把 token、私钥、`.env` 提交到 Git。
5. 模型直接 `git push` 或 `force push`。

## 当前防护

- 路径白名单：只有配置里的 repo 可访问。
- 读写分离：`allowedReadPaths` 和 `allowedWritePaths` 独立。
- 敏感路径黑名单：`.git`、`.env`、私钥、证书、`secrets` 等默认禁用。
- 覆盖保护：已有文件默认必须带 `expected_sha256`。
- 自动备份：写入或 patch 前备份已有文件。
- 命令白名单：`run_task` 只能执行配置里的命令数组。
- 无任意 shell：没有 `execute_shell`。
- 无远程写入：没有 `git_push`。
- 提交保护：`git_commit` 会检查 staged 文件是否都在允许写路径内。

## 不建议做的事

不要在 `allowedTasks` 中配置：

```yaml
command: ["bash", "-lc", "任意命令"]
command: ["git", "push"]
command: ["git", "reset", "--hard"]
command: ["rm", "-rf", "/"]
command: ["curl", "https://example.com/script.sh"]
command: ["ssh", "..."]
command: ["scp", "..."]
```

不要允许写：

```yaml
allowedWritePaths:
  - .
```

除非你非常清楚风险。

## 生产建议

- 使用单独工作区，例如 `/opt/repos`。
- 每次任务使用独立分支。
- 不要直接操作生产部署目录。
- 接入 HTTPS。
- 尽量放在私有网络或安全 tunnel 后面。
- 反代层做访问控制。
- 定期检查 `.chatgpt-git-mcp/backups`。
