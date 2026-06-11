# 本地 Git 连接器改进计划

面向 ChatGPT 代码修改工作流的安全性与可用性增强方案  
版本：v1.0  
日期：2026-06-11

## 执行摘要

本计划基于一次真实的 ChatGPT + 本地 Git MCP 代码修改流程复盘，目标是在不牺牲安全边界的前提下，显著提升连接器的可用性、可诊断性和端到端自动化能力。

- 最核心的问题：连接器可以建分支、改文件、提交，但缺少安全的切换、合并、任务发现和局部编辑能力。
- 最优先的方向：补上 `git_switch` / `prepare_merge` / `git_merge`、`replace_in_file`、`list_tasks`、备份目录管理、`git_diff_summary`。
- 设计原则：所有危险动作必须可审查、可回滚、可最小授权；默认不 push；默认不碰未授权路径。

## 优先改进项

1. 新增 `git_switch` / `prepare_merge` / `git_merge`，完成本地分支合并闭环。
2. 新增 `replace_in_file`，避免大多数场景依赖脆弱的 unified diff。
3. 修复 `repo_tree pathPrefix="."` 空 pathspec 问题。
4. `git_status` 分类或隐藏 `.chatgpt-git-mcp/` 自动备份目录。
5. 新增 `list_tasks`，让模型先发现可运行任务。
6. 新增 `read_file_around_match`，提升大文件上下文读取体验。
7. 新增 `git_diff_summary`，降低大 diff 展示失败概率。

## 路线图

| 阶段 | 周期 | 目标 | 交付物 |
|---|---:|---|---|
| 第 1 阶段 | 1 周 | 修复阻塞点 | repo_tree 修复、list_tasks、status 过滤备份目录、diff_summary |
| 第 2 阶段 | 1-2 周 | 提升编辑体验 | replace_in_file、read_file_around_match、apply_patch 诊断增强 |
| 第 3 阶段 | 1-2 周 | 完成分支闭环 | git_switch、prepare_merge、git_merge、merge 前 diff/冲突检测 |
| 第 4 阶段 | 持续 | 工作流级体验 | git_workflow_status、配置模板、文档与回归测试 |

## 工具接口草案

### replace_in_file

```ts
inputSchema: {
  repo: string,
  path: string,
  expected_sha256: string,
  oldText: string,
  newText: string,
  allowMultiple?: boolean = false
}
```

### prepare_merge

```ts
inputSchema: {
  repo: string,
  targetBranch: string,
  sourceBranch: string
}
```

### git_status 输出扩展

```ts
outputSchema: {
  status: string,
  mcpGenerated: string[],
  cleanIgnoringMcpGenerated: boolean
}
```

## 详细内容

完整方案请查看 DOCX 文档，其中包含问题清单、API 设计、测试计划、风险缓解、验收标准、推荐配置和提示词模板。
