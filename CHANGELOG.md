# 更新日志

## 0.2.2 — 2026-11-06

### 修复

- **启用/禁用开关显示成白块**。关闭态用的是 `--dsw-alias-border-l4`（16% 黑），
  在浅色面板上几乎看不见；宽度 34px、滑块只走 14px，整体读起来像个空矩形而不是开关。

  现已与 DSH 自带的 `ui-primitives` 开关完全对齐：36×20、16px 白色滑块、
  关闭态 `rgba(0,0,0,.12)`、开启态 `--dsw-alias-label-primary`。
  在运行中的桌面端逐字段比对过两个控件的计算样式，结果一致。

- 样式测试新增断言，锁定开关依赖的 token 名，防止再次写回宿主不会渲染的 token。

---

## 0.2.1 — 2026-11-06

### 修复（严重：导致 DSH 无法启动）

- **密码凭证引用格式非法，会让整个 DSH 启动失败**。此前密码认证生成
  `server-connector:<id>:password`，其中含冒号与连字符，而
  `@deepseek-ai/dsh-credentials` 要求所有凭证引用匹配 `/^[A-Za-z_][A-Za-z0-9_]*$/`。
  这条非法引用一旦写入 `servers.json`，下次启动时 `credentials` 插件解析失败；
  由于它是必需插件，整个 Host 起不来——**而且禁用本插件也没用，因为坏值已经在磁盘上**。

  三处修复，缺一不可：
  - 改为生成 `DSH_SERVER_CONNECTOR_<ID>_PASSWORD`，并校验调用方传入的引用，
    使本插件再也无法写入非法值；
  - 加载时迁移**旧格式**，让已经落盘的记录继续可用，而不是把「Host 崩溃」换成
    「插件加载失败」；
  - 迁移后**回写文件**，否则之后复制的文件副本仍带着非法值。已经合法的文件不会被重写。

  只迁移本插件曾经写出的那一种格式；其他非法引用仍然拒绝，因为静默改写可能让记录
  指向另一个密钥。

- 同时修正 README 与设计文档中展示的引用格式（它们此前在教读者写出非法值）。

### 升级说明

升级到 0.2.1 后**无需手动改文件**：插件加载时会自动把旧引用迁移成合法值并回写。

若 DSH 当前因该问题无法启动，先做下面任一操作再启动：

- 编辑 `~/.dsh/server-connector/servers.json`，把
  `"server-connector:srv-01:password"` 改成 `"DSH_SERVER_CONNECTOR_SRV_01_PASSWORD"`
  （`srv-02` 同理）；或
- 直接删除该文件中 `auth.kind` 为 `password` 的服务器记录。

然后安装 0.2.1。

> 迁移只改引用名，**不搬运密钥值**。升级后原密码可能需要重新输入一次
> （取决于该密钥此前是否成功写入 `~/.dsh/.credentials.yaml`）。

---

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
