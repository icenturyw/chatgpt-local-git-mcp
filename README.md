# ChatGPT Local Git MCP Bridge

一个偏安全的 Remote MCP Server：让 ChatGPT 在网页端通过 MCP 读取、修改你本地/服务器上的 Git 工作副本，执行白名单测试任务，创建**本地 commit**，最后只返回 `git push` 命令，由你自己手动执行。

> 核心原则：**MCP 不保存 GitHub Token，不执行 `git push`，不删除远程分支，不 force push。**

---

## 适合的使用场景

- 你想用 ChatGPT 网页端读项目代码、改代码、跑测试。
- 你不想让 ChatGPT 直接拿 GitHub 写权限。
- 你想把最终的远程交互控制在自己手里：最后人工执行 `git push`。
- 你遇到官方 GitHub Connector 被禁用、权限不稳定或不想冒险。

---

## 工具清单

### 只读工具

| 工具 | 作用 |
|---|---|
| `list_repos` | 查看配置里的仓库 |
| `repo_tree` | 查看仓库文件列表，自动过滤敏感路径 |
| `read_file` | 读取文本文件，返回 `sha256` 用于安全覆盖 |
| `search_code` | 搜索代码文本 |
| `git_status` | 查看当前分支、HEAD、短状态 |
| `git_diff` | 查看改动 diff，提交前审查用 |
| `prepare_push` | 只生成 push 命令，不执行 |

### 写入/执行工具

| 工具 | 作用 | 是否会 push |
|---|---|---:|
| `create_branch` | 创建并切换本地分支 | 否 |
| `write_file` | 写入允许路径下的文本文件 | 否 |
| `apply_patch` | 应用 unified diff patch | 否 |
| `run_task` | 执行白名单任务，比如测试/构建 | 否 |
| `git_add` | stage 指定允许文件 | 否 |
| `git_commit` | 创建本地 commit | 否 |

---

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 创建配置

```bash
cp config.example.yaml config.yaml
```

编辑 `config.yaml`，指定仓库目录（自动发现所有 Git 仓库）：

```yaml
reposDir: /www/code
```

或者手动定义单个仓库：

```yaml
repos:
  ai-btms:
    path: /opt/repos/ai-btms
    defaultBranch: master
    allowedReadPaths:
      - .
    allowedWritePaths:
      - app
      - static
      - tests
      - README.md
```

### 3. 本地启动

```bash
npm run build
npm start
```

默认地址：

```text
http://127.0.0.1:3000/mcp
```

健康检查：

```bash
curl http://127.0.0.1:3000/healthz
```

---

## 接入 ChatGPT

ChatGPT 网页端通常不能直接访问你电脑上的 `localhost`。你需要让 MCP Server 变成一个 HTTPS endpoint。

开发阶段可用：

```bash
ngrok http 3000
```

得到类似：

```text
https://xxxx.ngrok.app
```

在 ChatGPT 开发者模式 / 自定义 App / MCP Server URL 中填写：

```text
https://xxxx.ngrok.app/mcp
```

然后点击扫描工具。

---

## 推荐提示词

接入后，你可以这样对 ChatGPT 说：

```text
使用 Local Git MCP 操作 ai-btms 仓库。先 list_repos 和 git_status，创建本地分支 feat/chatgpt-fix-admin-api，然后读取相关文件，修改代码，运行 pytest，展示 git_diff 给我确认。确认后执行 git_add 和 git_commit。最后只用 prepare_push 输出 push 命令，不要执行 push。
```

---

## 安全策略

默认安全设计：

1. 只能访问 `config.yaml` 中配置的仓库。
2. 禁止访问 `.git`、`.env`、私钥、证书、`secrets`、`node_modules` 等路径。
3. 写文件只能写 `allowedWritePaths` 中允许的路径。
4. 覆盖已有文件默认必须携带 `read_file` 返回的 `sha256`。
5. 写入前自动备份已有文件到：

```text
.chatgpt-git-mcp/backups/<timestamp>/
```

6. `run_task` 只能执行 `config.yaml` 中预先声明的白名单命令。
7. 没有任意 shell 工具。
8. 没有 `git push` 工具。
9. `prepare_push` 只返回命令字符串。
10. `git_commit` 会拒绝提交未授权路径。

---

## Docker 部署

```bash
cp config.example.yaml config.yaml
# 编辑 config.yaml，注意容器内路径

docker compose up -d --build
```

默认把宿主机 `/opt/repos` 挂载到容器 `/opt/repos`：

```yaml
volumes:
  - /opt/repos:/opt/repos
```

---

## Nginx 反代示例

```nginx
server {
    listen 443 ssl http2;
    server_name mcp.example.com;

    ssl_certificate     /etc/nginx/ssl/fullchain.pem;
    ssl_certificate_key /etc/nginx/ssl/privkey.pem;

    client_max_body_size 2m;

    location /mcp {
        proxy_pass http://127.0.0.1:3000/mcp;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
    }

    location /healthz {
        proxy_pass http://127.0.0.1:3000/healthz;
    }
}
```

---

## 典型工作流

```text
1. ChatGPT 调 list_repos
2. ChatGPT 调 git_status
3. ChatGPT 调 create_branch
4. ChatGPT 调 repo_tree / search_code / read_file
5. ChatGPT 调 write_file 或 apply_patch
6. ChatGPT 调 run_task
7. ChatGPT 调 git_diff 展示给你审查
8. 你确认
9. ChatGPT 调 git_add
10. ChatGPT 调 git_commit
11. ChatGPT 调 prepare_push
12. 你手动执行 git push
```

---

## 手动 push 示例

MCP 最后会返回类似：

```bash
git push -u origin feat/chatgpt-fix-admin-api
```

你自己在仓库目录执行：

```bash
cd /opt/repos/ai-btms
git status
git log --oneline -5
git push -u origin feat/chatgpt-fix-admin-api
```

---

## 注意事项

- 这个项目不会也不应该保存 GitHub Token。
- 如果你把 MCP endpoint 暴露到公网，必须使用 HTTPS，并且建议放在私有网络、隧道或反代访问控制后面。
- 不要把生产环境真实业务目录直接暴露给 MCP。建议使用专门的工作区，例如 `/opt/repos`。
- 不建议允许 MCP 操作 `.env`、数据库文件、证书、私钥、部署脚本中的生产密钥。
- `run_task` 不要配置危险命令，例如 `rm -rf`、`curl | bash`、`ssh`、`scp`、`git push`、`git reset --hard`。

---

## License

MIT
