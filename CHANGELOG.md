# 更新日志

## 0.3.0 — 2026-11-09

### 修复

- **设置页的「全局设置」无法修改**。九个键此前一个 `.volatile()` 都没有，而 DSH 0.2.2
  只通过 `volatileForm()` 把插件配置投影成设置表单：一个 volatile 字段都没有时整份
  schema 投影为 `undefined`，`settings.describe()` 不会列出这个 row，
  `ctx.configForms.get('dsh-server-connector')` 永远是 `unavailable`。于是那一块只能
  显示九个只读数字——不是「值来自 profile」，而是**这个 row 从来没被标记成可编辑**。

  现在九键全部 `.volatile()`，设置页用 `ctx.configForms` 渲染真正的表单：改完点保存，
  `mutate(ops, revision)` 一次性写入，**立即生效、不重启、不断开现有连接**。
  可编辑表单拿不到时（旧 Host、或该部署没有这个 row）降级为只读视图并明确说明原因，
  不再渲染一排死掉的输入框。

- **volatile 值必须按 cell 读，否则保存等于没保存**。`.volatile()` 字段解析出来的是
  cosmokit 的 cell 而不是值，loader 直接**原地改写这个 cell** 并发
  `loader/volatile-update`，插件不会被重新挂载、`apply()` 不会再执行一次。
  新增 `lib/config.js` 的 `readConfig()` 作为唯一读取入口（各单元在**用值时**才读），
  并在 `apply()` 里监听 `loader/volatile-update`，把新值转发给已经持有快照的
  `Pool.configure()` / `AuditLog.configure()` / `PendingQueue.configure()`。
  这些 `configure()` 都是原地生效：改超时不会断开连接，关审计不会删掉已有日志，
  改 TTL 只影响之后入队的记录（已入队的截止时间不变）。

### 变更

- **删除确认改为详情页原地两段式**。此前点「删除」只是入队，然后必须切到设置页找到
  那条记录再确认；现在详情页点「删除」会在本页展开确认区：显示目标、后果，勾选确认框后
  「确认删除」才可点。安全模型没变——请求仍然先入队（`DELETE` 只入队返回 202），
  再调用 `POST /pending/:id/confirm` 才真正删除。设置页的待确认区保留，作为异时确认的
  第二入口。

- **更新后面板消失，重启才回来 —— 已按 dsh-context 的做法修好本插件这一半**。
  参照对象不是猜的：同一台机器上 `dsh-context` 更新时面板**先消失后自己回来**，
  而本插件只能重启。差别只有一处——

  `dsh-context` 每次挂载前先问注册表「我这个 id 是不是已经在位」：

  ```js
  function alreadyMounted(ctx, slot, id) {
    const entries = ctx.slots.entries(slot)      // 注册表的读取面
    return entries.some((entry) => entry.options?.id === id)
  }
  // apply() 里
  if (alreadyMounted(ctx, n_, r_)) return
  ```

  本插件此前是**盲注册**。而 DSH 的插槽注册表对同一 id、同一优先级会直接抛：

  ```
  list slot "settings.section" already has an entry with id "server-connector"
  keyed slot "main" already has an entry for key "server-connector"
  ```

  （`ui-slots`：list 比 `options.id`，keyed 比 `options.key`。）这个抛错落在
  `slots.inject` 的回调里，而该注入**一旦抛出就在本 fiber 余生不再重试**——
  于是新代码挂上、入口却没注册，页面要等进程重启才恢复。这正是「先消失、
  重启才回来」在本插件侧的那一环。

  现在三个入口都先查在位情况，在位就原样复用、不再注册；`alreadyMounted()` 同时
  兼容 `entriesOfSlot()` 与 `entries()` 两种读取面，读不到就退回盲注册（旧 Host 仍能工作）。
  回归测试按真实注册表的重复判定（list 比 id、keyed 比 key、拒绝时抛错）搭了替身，
  并断言第二次 `apply()` **一次 register 都不发起**。

  保留上一版的兜底：注册真的失败时只丢那一个入口，不会顺带带走整批插件。

### 文档

- README 与 `docs/design.md` 的 §8.2 / §8.3 / §10 更新为上述行为。

---

## 0.2.3 — 2026-11-06

### 修复

- **深色主题下启用状态的开关显示为一条纯白条**。0.2.2 把滑块写死成白色，而深色主题下
  轨道解析为 `#f9fafb`（近白）——白滑块落在白轨道上，整个控件看起来没有滑块。

  DSH 原生开关的做法是**轨道与滑块成对反转**：轨道用 `--dsw-alias-label-primary`，
  滑块用 `--dsw-alias-label-primary-inverted`。浅色下是深轨道+白滑块，深色下是白轨道+深滑块，
  两种主题都保证对比度。现已改为这一对 token，并在两种主题下实测确认。

- 关闭态轨道改用 `--dsw-alias-border-l4`（深色下自动变为半透明白），滑块用
  `--dsw-alias-label-tertiary`，不再依赖写死的颜色。

---

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
