# AI CLI 可执行增强计划

> 目标：把 `chatgpt-local-git-mcp` 继续增强成一个更适合 AI CLI / ChatGPT 网页端长期操作的安全 Git 写入桥接服务。
>
> 范围排除：不修改 `reposDir` 自动发现仓库的默认读写路径策略，也就是不做“收紧自动发现仓库默认 allowedReadPaths / allowedWritePaths”的第 6 项。

## 仓库信息

```bash
cd /www/code/chatgpt-local-git-mcp
```

项目定位：安全优先的 Remote MCP Server，让 ChatGPT 通过 MCP 读取、修改本地 Git 工作副本，执行白名单任务，创建本地 commit，但不执行 `git push`。

## 总体要求

1. 不执行 `git push`。
2. 不保存 GitHub Token。
3. 不加入任何会直接操作远程仓库的功能。
4. 不修改 `reposDir` 自动发现默认读写路径策略。
5. 所有新增写入类工具必须遵守现有 `allowedWritePaths` / `deniedPaths` 安全规则。
6. 所有改动必须有测试。
7. 修改完成后运行：

```bash
npm run typecheck
npm test
npm run build
```

8. 最后展示：

```bash
git status
git diff
```

9. 等人类确认后再 commit。
10. commit 后只生成手动 push 命令，不执行 push。

## Git 工作流

进入仓库并检查状态：

```bash
cd /www/code/chatgpt-local-git-mcp
git status
git branch --show-current
git log --oneline -5
```

如果工作区不干净，停止并说明问题，不要覆盖本地改动。

创建开发分支：

```bash
git switch -c feat/cli-hardening-workflow
```

如果分支已存在，则切换到该分支：

```bash
git switch feat/cli-hardening-workflow
```

## 第一阶段：补齐白名单任务发现与配置文档

### 目标

完善 `list_tasks` 相关文档，并给项目示例配置增加推荐 `allowedTasks` 示例。

### 修改范围

- `README.md`
- `config.example.yaml`
- 如有必要，调整 `src/tools.ts`

### 具体要求

README 增加推荐流程：

```text
list_repos
git_status
list_tasks
run_task typecheck
run_task test
run_task build
```

README 增加 `allowedTasks` 示例：

```yaml
repos:
  chatgpt-local-git-mcp:
    path: /www/code/chatgpt-local-git-mcp
    allowedReadPaths:
      - .
    allowedWritePaths:
      - src
      - tests
      - docs
      - README.md
      - package.json
      - tsconfig.json
      - tsconfig.test.json
      - config.example.yaml
    allowedTasks:
      typecheck:
        description: Run TypeScript checks.
        command: ["npm", "run", "typecheck"]
      test:
        description: Run unit tests.
        command: ["npm", "test"]
      build:
        description: Build the project.
        command: ["npm", "run", "build"]
```

`config.example.yaml` 中补充 `allowedTasks` 示例，但不要改变 `reposDir` 自动发现的默认策略。

## 第二阶段：主分支写入保护

### 目标

防止 ChatGPT / MCP 在 `main` 或 `master` 上直接写文件、apply patch、stage、commit。

### 修改范围

- `src/types.ts`
- `src/config.ts`
- `src/tools.ts`
- `config.example.yaml`
- `tests/*.test.ts`

### 具体要求

在 `AppConfig.security` 增加：

```ts
protectedBranches: string[];
```

默认值：

```ts
protectedBranches: ['main', 'master'];
```

`config.example.yaml` 增加：

```yaml
security:
  protectedBranches:
    - main
    - master
```

增加工具函数：

```ts
async function ensureWritableBranch(
  config: AppConfig,
  repo: RepoRuntime,
  action: string,
): Promise<void>
```

逻辑：

1. 获取当前分支。
2. 如果当前分支在 `config.security.protectedBranches` 中，抛出 `UserFacingError`。
3. 错误信息要清晰，例如：

```text
write_file is blocked on protected branch 'main'. Create and switch to a feature branch first.
```

以下工具执行前必须调用 `ensureWritableBranch`：

- `write_file`
- `apply_patch`
- `git_add`
- `git_commit`

测试覆盖：

- 默认 `protectedBranches` 包含 `main` / `master`。
- 当前分支为 `main` 时写入类操作应拒绝。
- 当前分支为 `feat/xxx` 时允许继续。

如果直接集成测试不方便，至少将分支判断逻辑抽成纯函数测试：

```ts
export function isProtectedBranch(branch: string, protectedBranches: string[]): boolean
```

## 第三阶段：增加 patch 诊断工具

### 目标

解决 `apply_patch` 失败时只返回 `corrupt patch at line xx`、不够友好的问题。

### 新增 MCP 工具

```text
validate_patch
```

### 修改范围

- `src/tools.ts`
- `src/git.ts`，如有必要
- `tests/*.test.ts`
- `README.md`

### 工具行为

输入：

```ts
{
  repo: string;
  patch: string;
}
```

输出：

```ts
{
  repo: string;
  touchedPaths: string[];
  allowed: boolean;
  valid: boolean;
  stdout: string;
  stderr: string;
  suggestion: string;
}
```

逻辑：

1. 使用已有 `parsePatchTouchedPaths` 解析 touched paths。
2. 检查 touched paths 是否在 `allowedWritePaths` 内。
3. 写入临时 patch。
4. 运行：

```bash
git apply --check <patch>
```

5. 不真正应用 patch。
6. 如果失败，返回 `stderr` 和建议。
7. 如果成功，返回 `valid: true`。

README 补充推荐流程：

```text
validate_patch
apply_patch
git_diff
```

## 第四阶段：增加更适合 AI 的文本编辑工具

### 目标

减少 AI 手写 unified diff 的失败率。

### 新增 MCP 工具

至少实现：

```text
replace_text
```

可选实现：

```text
insert_after
insert_before
```

### `replace_text` 行为

输入：

```ts
{
  repo: string;
  path: string;
  oldText: string;
  newText: string;
  expected_sha256?: string;
  replaceAll?: boolean;
}
```

要求：

1. 必须遵守 `allowedWritePaths`。
2. 必须拒绝二进制文件。
3. 默认只允许替换唯一一次。
4. 如果 `oldText` 出现 0 次，报错。
5. 如果 `oldText` 出现多次且 `replaceAll !== true`，报错。
6. 覆盖已有文件时遵守 `requireExpectedShaForOverwrite`。
7. 写入前调用 `makeBackup`。
8. 写入后返回新 `sha256`、`bytes`、`backupPath`。

测试覆盖：

- 替换唯一文本成功。
- 未找到 `oldText` 报错。
- `oldText` 出现多次但 `replaceAll` 未开启时报错。
- `replaceAll` 开启时替换全部。
- `sha256 mismatch` 报错。

## 第五阶段：增加审计日志

### 目标

每次关键工具调用都能留下可追踪记录。

### 新增文件

```text
src/audit.ts
```

### 审计日志路径

```text
.chatgpt-git-mcp/audit.log
```

每行一个 JSON。不要存完整文件内容，不要存密钥内容。

### 记录字段

```ts
type AuditEvent = {
  time: string;
  tool: string;
  repo: string;
  branch?: string;
  paths?: string[];
  success: boolean;
  error?: string;
};
```

### 需要记录的工具

- `write_file`
- `replace_text`
- `apply_patch`
- `validate_patch`
- `run_task`
- `git_add`
- `git_commit`
- `prepare_push`
- `restore_backup`

### 要求

1. 成功和失败都记录。
2. 审计日志不能阻塞主流程。如果写 audit log 失败，只 `console.warn`，不要让工具失败。
3. README 增加审计日志说明。

测试覆盖：

- audit event 能追加写入。
- 写入失败不会抛出到主流程。

## 第六阶段：增加备份查看与恢复工具

### 目标

目前已有自动备份，但缺少恢复入口。增加可用的恢复闭环。

### 新增 MCP 工具

```text
list_backups
restore_backup
```

### `list_backups` 输出

```ts
{
  repo: string;
  backups: Array<{
    id: string;
    path: string;
    files: string[];
  }>;
}
```

### `restore_backup` 输入

```ts
{
  repo: string;
  backupId: string;
  paths?: string[];
}
```

### `restore_backup` 要求

1. `backupId` 只能是 `.chatgpt-git-mcp/backups` 下的目录名。
2. 禁止路径穿越。
3. 恢复的文件必须仍然满足 `allowedWritePaths`。
4. 恢复前也要备份当前文件。
5. 恢复后返回 `restoredPaths` 和 `backupPath`。
6. 恢复后建议用户查看 `git_diff`。

测试覆盖：

- 能列出备份。
- 能恢复指定文件。
- 非法 `backupId` 被拒绝。
- 越权路径被拒绝。

## 第七阶段：增加 `git_diff_summary`

### 目标

给人类确认 diff 时更友好。

### 新增 MCP 工具

```text
git_diff_summary
```

### 输出示例

```json
{
  "repo": "chatgpt-local-git-mcp",
  "files": [
    {
      "path": "src/tools.ts",
      "added": 30,
      "deleted": 2
    }
  ],
  "riskHints": [
    "No remote operation detected.",
    "No denied path modified.",
    "Review changes before git_add/git_commit."
  ]
}
```

### 实现要求

1. 基于 `git diff --numstat`。
2. 支持 `staged` 参数。
3. 支持 `paths` 参数。
4. 过滤 denied paths。
5. 不需要 AI 总结代码语义，只做结构化摘要即可。

## 第八阶段：增加 PR 文案生成工具

### 目标

不直接创建 PR，但生成可复制的 PR 标题和内容。

### 新增 MCP 工具

```text
prepare_pr_text
```

### 输出

```ts
{
  title: string;
  body: string;
}
```

body 包含：

```md
## Summary

- ...

## Test Plan

- npm run typecheck
- npm test
- npm run build

## Safety

- No git push was performed by MCP.
- Human review required before pushing.
```

要求：

1. 结合当前 `git_diff_summary`。
2. 不访问远程。
3. 不创建 PR。

## 第九阶段：测试与验收

完成所有代码后执行：

```bash
npm run typecheck
npm test
npm run build
```

如果失败：

1. 修复失败。
2. 再次运行。
3. 直到通过。

然后展示：

```bash
git status
git diff
```

不要自动 commit，等待人类确认。

## 第十阶段：提交要求

人类确认 diff 后，再执行：

```bash
git add README.md config.example.yaml package.json src tests docs tsconfig.test.json
git commit -m "feat: harden MCP workflow and recovery tools"
```

提交后展示：

```bash
git status
git log --oneline -5
```

最后只生成 push 命令：

```bash
git push -u origin feat/cli-hardening-workflow
```

不要执行 push。

## 验收清单

- [ ] 不修改 `reposDir` 自动发现默认读写策略。
- [ ] `list_tasks` 有 README 用法说明。
- [ ] `allowedTasks` 有示例配置。
- [ ] `main/master` 写入保护生效。
- [ ] `validate_patch` 能诊断 patch 是否可应用。
- [ ] `replace_text` 能安全替换文本。
- [ ] 审计日志可记录关键操作。
- [ ] `list_backups` 可列出备份。
- [ ] `restore_backup` 可恢复备份。
- [ ] `git_diff_summary` 可输出结构化 diff 摘要。
- [ ] `prepare_pr_text` 可生成 PR 文案。
- [ ] `npm run typecheck` 通过。
- [ ] `npm test` 通过。
- [ ] `npm run build` 通过。
- [ ] 最后不 push，只输出 push 命令。
