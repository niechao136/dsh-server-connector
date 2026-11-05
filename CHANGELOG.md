# 更新日志

## 0.2.0 — 2026-11-05

### 新增

- **每台服务器独立的启用/禁用开关**。禁用后 `srv_list` 与系统提示都不再列出该服务器，
  任何 `srv_*` 调用返回 `SERVER_DISABLED`；面板里该行置灰并标注「已禁用」，随时可恢复。
  已连接的服务器必须先断开才能禁用。切换不走待确认区，写审计 `server-enabled` / `server-disabled`。
- **每台服务器独立的自定义高危规则**。在详情页给单台机器补规则（正则 + `confirm`/`block`），
  与内置 20 条走同一套判定。保存时六道校验：长度、可编译、不匹配空串、拒绝嵌套量词（ReDoS）、
  必须命中至少一条样例、id 不冲突。配套 **试跑** 接口，逐条报告样例是否命中且不写盘。
- `POST /server-connector/servers/:id/rules/preview` 等四条自定义规则路由。

### 修复

- **长任务读取报「belongs to another session」**。`srv_job_output` / `srv_job_kill` 把调用者
  算成 `undefined` 而非本次调用的会话，导致本会话发起的后台任务对自己也不可见。
  测试替身此前忽略归属参数，因此没有暴露该问题；现已补上同等的归属校验与回归测试。
- **Windows 上私钥认证无法提交**。表单与路由都要求私钥路径以 `/` 开头，
  使 `C:\…` 与 UNC 路径一律被拒；现已接受盘符与 UNC 路径（`defaultWorkDir` 仍要求 POSIX，
  因为它是远端路径）。

### 文档

- 设计规格从 `2026-11-04-server-connector-plugin-design.md` 改名为 `docs/design.md`，
  并补入自定义规则（§4.4）与启用开关相关章节。
- README 重写安装章节，覆盖 npm、GitHub Release tarball、GitHub 源码、本地 checkout 四条渠道。

### 兼容性

- `servers.json` 向前兼容：缺少 `enabled` 字段的旧记录按**启用**加载，缺少 `customRules`
  的按空列表加载。
- 无破坏性变更。

---

## 0.1.0 — 2026-11-05

首个公开发布版本。

- 六个 `srv_*` 工具：`srv_list` / `srv_connect` / `srv_exec` / `srv_job_output` /
  `srv_job_kill` / `srv_policy_check`。
- 内置 20 条高危命令规则（8 条 block、12 条 confirm），逐台可调。
- SSH 连接池、主机指纹校验、审计日志（JSONL）、两段式危险操作确认。
- 侧边栏「服务器」面板、服务器表单、设置页。
