# ChatGPT Local Git MCP Bridge 扩展开发计划

> 范围说明：本计划不包含“收紧自动发现仓库的默认读写路径”这一项，保留现有自动发现模式的默认行为。

## 开发原则

1. 保持核心安全边界：不保存 GitHub Token，不执行 git push，不 force push。
2. 所有写入动作必须可审查、可测试、可回滚。
3. 新功能优先通过 MCP 工具暴露，Web 管理面板放在后续阶段。
4. 每一步都先在本地分支完成，展示 git diff 后再提交。

## 第一期：基础可用性与测试闭环

目标：让 MCP 基础工具更稳定，开发流程可测试。

- [x] 修复 `repo_tree` 在仓库根目录调用时传入空 pathspec 的问题。
- [x] 增加 `list_tasks` 工具，用于查看当前仓库允许执行的白名单任务。
- [x] 增加 Node 内置 test runner 测试脚本。
- [x] 增加基础安全函数与 `repo_tree` 参数构造测试。
- [ ] 增加受保护分支写入保护，默认保护 `main` / `master`。

验收方式：

```bash
npm run typecheck
npm test
```

## 第二期：审计、回滚与审查辅助

目标：让 ChatGPT 修改代码后的风险更可控。

- [ ] 增加审计日志：记录工具名、仓库、分支、路径、结果、时间。
- [ ] 增加 `list_backups` 工具：列出 `.chatgpt-git-mcp/backups` 下的备份。
- [ ] 增加 `restore_backup` 工具：按备份时间恢复指定文件。
- [ ] 增加 `git_diff_summary` 工具：输出修改文件、变更摘要、风险提示。
- [ ] 增加 `prepare_pr_text` 工具：生成 PR 标题、Summary、Test Plan。

验收方式：

```bash
npm run typecheck
npm test
```

手动验证：

1. 修改一个允许写入的文件。
2. 查看 audit log。
3. 查看 backup 列表。
4. 恢复 backup。
5. 查看 diff summary 与 PR 文案。

## 第三期：Web 管理面板

目标：给人类用户一个可视化控制台，不改变 MCP 的核心安全边界。

- [ ] 增加 `/admin` 静态页面。
- [ ] 展示仓库列表、当前分支、HEAD、工作区状态。
- [ ] 展示 allowedTasks、protectedBranches、server 状态。
- [ ] 展示最近审计日志。
- [ ] 展示备份列表。
- [ ] 只提供查看与复制命令能力，不直接执行 push。

验收方式：

```bash
npm run build
npm start
```

浏览器访问：

```text
http://127.0.0.1:3000/admin
```
