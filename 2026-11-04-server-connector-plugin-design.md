# dsh-server-connector 插件设计规格

日期：2026-11-04
状态：已批准（分节评审通过）
目标仓库：新建独立仓库（本规格不提交到 dev-ops-mcp）

---

## 1. 背景与目标

现有 `dev-ops-mcp` 是一个「面向 AI 的运维执行中枢」：FastAPI + SQLite + Next.js 控制台 + Docker 部署，
通过 MCP 暴露 `execute_action` / `get_task_status` 等工具，AI 客户端（Claude、Cursor）以 `X-API-Key` 认证，
服务端以专用低权限用户回连宿主机执行脚本。

新插件 `dsh-server-connector` 的目标是**只保留「访问服务器执行命令」这一核心能力**，改造成一个
DeepSeek Harness（DSH）原生插件，彻底去掉 Docker、SQLite、独立 Web 控制台与自动化调度。

### 1.1 保留什么 / 去掉什么

| dev-ops-mcp 现有 | dsh-server-connector |
|---|---|
| FastAPI + SQLite + Docker Compose | 全部去掉；注册表为 `$DSH_HOME/server-connector/servers.json` |
| Next.js Web 控制台 | 换成 DSH 侧边栏面板（Client 半） |
| API Key + scope + 项目白名单 | 去掉；本机会话本身即授权边界 |
| 项目 / 命令模板 / 自动化调度 | 全部去掉（自由命令 + 内置高危策略目录） |
| `execute_action` + `get_task_status` 两段轮询 | `srv_exec` 一次调用；长命令转 `ctx.jobs` 增量读取 |
| `requires_confirm` 布尔标志 | 高危策略三级（block/confirm/allow）+ DSH 原生 `ctx.approval` |
| `AuditLog` 数据库表 | JSONL 文件 `$DSH_HOME/server-connector/audit.log` |
| 会话绑定服务器 | **不做**；每次调用显式传 `server` |

### 1.2 非目标

- 不做文件读写 / 上传 / 本地镜像同步工具（用 `cat` / `tee` 走 `srv_exec` 即可）。
- 不做 SFTP 文件浏览、端口转发、远端 DSH 界面挂载（`dsh-remote` 已覆盖，重复实现无收益）。
- 不做多跳跳板机 / ProxyJump（v1 单跳直连；后续需要再扩展）。
- 不做 GSSAPI / Kerberos（选 `ssh2` 的已知限制）。
- 不做团队共享、多用户权限体系（单机单人插件）。

---

## 2. 架构

### 2.1 整体形态

标准 DSH bundle，Host 半 + Client 半，安装到当前 profile（本机为 `desktop`）。
包名 `dsh-server-connector`，插件行 id 同为 `dsh-server-connector`。

```
┌──────────────────────────────────────────────────────┐
│  Client 半（lib/client.js）                          │
│  ├─ sidebar.panellist  → 侧边栏「服务器」图标          │
│  ├─ main (key="server-connector") → 服务器主面板       │
│  └─ settings.section   → 全局设置 + 待确认区           │
└───────────────────────┬──────────────────────────────┘
                        │  JSON over ctx.webServer 路由
┌───────────────────────▼──────────────────────────────┐
│  Host 半（lib/index.js）                              │
│  ├─ registry.js   服务器注册表（JSON，非 SQLite）      │
│  ├─ credentials  密码/passphrase → ctx.credentials     │
│  ├─ pool.js       SSH 连接池（每服务器一条长连接）      │
│  ├─ policy.js    内置高危命令目录 + 每服务器策略         │
│  ├─ tools.js      agent 工具（srv_*）                  │
│  ├─ jobs         长命令异步输出（ctx.jobs）            │
│  ├─ pending.js   危险操作待确认队列                    │
│  └─ audit.js     执行审计日志（JSONL）                 │
└──────────────────────────────────────────────────────┘
```

### 2.2 单元职责

每个单元有单一职责，可独立理解与测试：

- **registry**：只负责服务器记录（连接四字段 + 每服务器高危策略 + 元数据）的增删改查。不认识 SSH。
- **pool**：只负责「给一条服务器记录 → 一个可用连接 / 一个带类型的错误」。不认识策略。
- **policy**：纯函数 `(command, serverPolicy) → {decision, matchedRule}`。不碰网络、不碰 IO。
- **tools**：编排上述三者，是唯一对模型可见的面。
- **pending**：危险操作的两段式队列，不执行任何副作用。
- **audit**：追加写 + 尾部读取，不参与决策。
- **client**：只做 UI 与表单，通过 JSON 路由读写 registry。

### 2.3 技术底座（已核实的 DSH 扩展点）

| 能力 | DSH 服务 | 用法 |
|---|---|---|
| 注册模型工具 | `ctx.tools.register(ToolDefinition)` | 6 个 `srv_*` 工具 |
| 系统提示注入 | `ctx.systemPrompt.section({name, order, text})` | 服务器列表 + 高危策略摘要 |
| 用户审批 | `ctx.approval.request({agent, toolName, reason})` | 高危命令确认 |
| 后台任务 | `ctx.jobs.start(JobSpec)` | 长命令 + 增量输出环 |
| 凭据存储 | `ctx.credentials.set(ref, value)` / `resolve(ref)` | 密码、passphrase |
| HTTP 路由 | `ctx.webServer.register(route)` | 面板读写接口 |

范本：本机已装 `dsh-remote@0.8.72`（`$DSH_PROFILE_DIR/node_modules/dsh-remote`），
其 `lib/index.js` 使用 `export const inject = ['tools','systemPrompt']` +
`ctx.tools.register(defineTool(...))` + `ctx.systemPrompt.section(...)` +
`webServer` JSON 路由喂 `lib/client.js`，与本设计骨架一致。

**关键约束**：`Config` 必须是 `@deepseek-ai/schemastery` 的 schema，**不能用 zod**
（dsh-remote 源码注释明确记录：`zod rejects the undefined row config`，Loader 会拒绝该行）。

---

## 3. 数据模型

### 3.1 服务器记录（`servers.json`）

```jsonc
{
  "version": 1,
  "servers": [{
    "id": "srv-01",                    // 稳定标识，工具调用用它
    "name": "生产机-A",                 // 展示名，唯一
    "host": "10.0.0.5",
    "port": 22,
    "username": "devops",
    "auth": { "kind": "key", "privateKeyPath": "/root/.ssh/id_rsa" },
    // 或 { "kind": "password", "credentialRef": "server-connector:srv-01:password" }
    // 或 { "kind": "agent" }
    "hostKeyMode": "accept-new",       // accept-new | verify | off
    "defaultWorkDir": "/srv/app",
    "policy": {                        // 逐条高危策略；未列出的走内置默认
      "rm-recursive": "block",
      "service-restart": "confirm"
    },
    "disabledRules": ["docker-prune"], // 彻底停用的规则 id；修改必须走待确认区
    "createdAt": "2026-11-04T09:00:00Z",
    "lastConnectedAt": "2026-11-04T09:20:00Z"
  }]
}
```

**用 `id` 而非名字作为稳定寻址键**：名字可改，改名不应让模型记住的调用失效。

### 3.2 主机指纹（`known_hosts.json`）

```jsonc
{ "srv-01": { "hash": "<sha256 base64>", "firstSeen": "...", "algorithm": "ssh-ed25519" } }
```

### 3.3 待确认队列（`pending.json`）

```jsonc
{
  "version": 1,
  "pending": [{
    "id": "pend-01",
    "kind": "delete-server" | "disable-hostkey" | "disable-rule",
    "serverId": "srv-01",
    "requestedAt": "2026-11-04T09:20:11Z",
    "expiresAt": "2026-11-05T09:20:11Z",   // requestedAt + 24h
    "snapshot": { /* delete-server 时保存完整服务器记录，便于取消时无变化 */ }
  }]
}
```

### 3.4 审计（`audit.log`，JSONL）

```jsonc
{"ts":"2026-11-04T09:20:11Z","sessionId":"...","serverId":"srv-01","serverName":"生产机-A",
 "command":"systemctl restart app","decision":"confirm","policyRule":"service-restart",
 "approved":true,"exitCode":0,"durationMs":1200,"truncated":false}
```

block 事件也写一行，`approved:null`、`exitCode:null`。
另有一类 `event` 字段用于非执行事件（`hostkey-disabled`、`server-deleted`）。

### 3.5 文件布局

```
$DSH_HOME/server-connector/
├── servers.json
├── known_hosts.json
├── pending.json
└── audit.log
```

---

## 4. 高危策略引擎

### 4.1 内置规则目录（只读，约 20 条）

每条 `{ id, label, pattern, defaultDecision, description }`：

| id | 匹配 | 默认 |
|---|---|---|
| `rm-recursive` | `rm -rf` / `rm -r` | block |
| `dd-write` | `dd of=/dev/` / `mkfs` | block |
| `db-drop` | `DROP DATABASE` / `TRUNCATE` | block |
| `fork-bomb` | `:(){ :\|:& };:` | block |
| `shutdown` | `shutdown` / `poweroff` | block |
| `reboot` | `reboot` | block |
| `chmod-root` | `chmod -R` 落在系统路径 | confirm |
| `chown-root` | `chown -R` 落在系统路径 | confirm |
| `service-stop` | `systemctl stop` / `disable` | confirm |
| `service-restart` | `systemctl restart` / `docker restart` | confirm |
| `docker-prune` | `docker (system )?prune` / `docker rm -f` | confirm |
| `curl-pipe-sh` | `curl … \| (ba)?sh` | confirm |
| `kill-all` | `kill -9 -1` / `pkill -9` | confirm |
| `passwd-edit` | 写 `/etc/passwd` / `/etc/shadow` | block |
| `crontab-edit` | `crontab -r` / 写 `/etc/cron*` | confirm |
| `iptables-flush` | `iptables -F` | confirm |
| `git-force-push` | `git push --force` / `-f` | confirm |
| `history-clear` | `history -c` / 清 `~/.bash_history` | confirm |
| `truncate-log` | `> /var/log/*` / `truncate -s 0` | confirm |
| `sudoers-edit` | 写 `/etc/sudoers*` | block |

### 4.2 判定语义

1. 把命令行按 `&&`、`||`、`;`、`|`、换行拆成**子命令**，**每个子命令都过一遍规则**
   （不能只匹配第一段 —— 否则 `echo ok && rm -rf /` 会漏判）。
2. 命中多条时取**最严**的：`block > confirm > allow`。
3. 服务器 `policy` 可覆盖默认，但 **`block` 不能降级为 `allow`**，只能显式降为 `confirm`。
4. 要彻底放开某条规则，只能把该规则 id 加入服务器的 `disabledRules`（例如
   `"disabledRules": ["rm-recursive"]`）。该字段的任何修改**必须走待确认区**（第 8.3 节），
   并在审计写一条 `rule-disabled` 事件。被停用的规则在 `srv_policy_check` 与 `srv_exec`
   中都视为不存在 —— 两者复用同一个纯函数，故结论始终一致。
5. 未命中任何规则 → `allow`。
6. 判定是**纯函数**，`srv_policy_check` 直接复用它，保证「预检」与「执行」结论一致。

### 4.3 明确的安全边界声明

**这是遏制，不是安全边界。** 正则拦不住 `python -c "import shutil; shutil.rmtree('/')"`
或 `base64 -d | sh`。真正的硬边界在远端：
专用低权限用户 + sudo 白名单（即现有 `mcp-init.sh` 已经在做的事）。
本规格不承诺「插件能阻止一切破坏性操作」，只承诺「已知模式会被拦下或被要求确认」。

---

## 5. Agent 工具面

### 5.1 工具清单（6 个，`srv_` 前缀）

| 工具 | 参数 | 作用 |
|---|---|---|
| `srv_list` | — | 列出服务器：`id` / `name` / `host` / `defaultWorkDir` / 是否已连接 |
| `srv_connect` | `server` | 建立/复用连接，返回远端信息（平台、shell、sudo 可用性） |
| `srv_exec` | `server`, `command`, `cwd?`, `timeoutMs?`, `async?` | 执行命令 |
| `srv_job_output` | `jobId` | 增量读输出，返回 `next` 偏移 |
| `srv_job_kill` | `jobId` | 取消运行中的命令 |
| `srv_policy_check` | `server`, `command` | 纯判定 allow/confirm/block，**不执行** |

`jobId` 自带服务器归属，故 `srv_job_output` / `srv_job_kill` 不需要 `server` 参数。

### 5.2 server 参数解析（容错优先）

1. 精确匹配 `id` → 命中
2. 精确匹配 `name` → 命中
3. 唯一前缀匹配 → 命中
4. 零命中 → `UNKNOWN_SERVER`，错误消息**列出全部可用服务器**
5. 多命中 → `AMBIGUOUS_SERVER`，错误消息列出候选

目的：模型即使记错名字，也能靠错误消息一轮自纠，无需用户介入。

### 5.3 系统提示注入

`ctx.systemPrompt.section()` 注入，**仅在已配置服务器存在时**出现：

```
可运维服务器（调用 srv_exec 时必须传 server）：
- srv-01  生产机-A   devops@10.0.0.5:22   默认目录 /srv/app
- srv-02  测试机-B   devops@10.0.0.6:22   默认目录 /srv/app
高危策略：rm-recursive=block、service-restart=confirm（可用 srv_policy_check 预检）
```

超过 8 台时只列前 8 台 + `…另有 N 台，调用 srv_list 查看全部`，避免撑上下文。
服务器列表是进程级配置，故该段对所有会话可见（去掉会话绑定后的必然取舍）。

### 5.4 输出处理

- **同步**：`exitCode` + stdout + stderr；超 `maxOutputChars`（默认 200000）截断并标 `TRUNCATED`。
- **异步**：`async: true` 或同步耗时超过 `syncTimeoutMs`（默认 20s）→ 转 `ctx.jobs`。
  `srv_job_output` 按字节偏移增量读取；ring 有界，读慢了返回 `lossy: true` + spill 文件路径。
- **超时**：`timeoutMs`（默认 60000），到点由**远端 watchdog 杀进程组**（见 7.3）。

### 5.5 错误类型

`CONNECT_FAILED` / `HOST_KEY_UNKNOWN` / `AUTH_FAILED` / `POLICY_BLOCKED` /
`POLICY_DENIED_BY_USER` / `TIMEOUT` / `EXIT_NONZERO` / `UNKNOWN_SERVER` / `AMBIGUOUS_SERVER` /
`NO_CREDENTIAL`。每种都带一句可执行的下一步提示。

---

## 6. 安全层与审批流

### 6.1 三道闸门

```
srv_exec(command)
   │
   ├─① 策略判定  policy.check(command, server.policy)
   │     → block    : 立即返回 POLICY_BLOCKED，不连接、不执行
   │     → confirm  : 进入 ②
   │     → allow    : 进入 ③
   │
   ├─② 用户审批  ctx.approval.request({agent, toolName:'srv_exec', reason})
   │     → 'allowed-once' : 进入 ③
   │     → 'rejected'/'cancelled'/'unavailable' : 返回 POLICY_DENIED_BY_USER
   │
   └─③ 执行     连接池取连接 → 执行 → 审计 → 返回
```

审批走 DSH 原生 `ctx.approval`（不自造 token）：

- 会话策略 `ask` → 弹确认框，用户点允许才执行。
- 会话策略 `never` → **自动拒绝**（DSH fail-closed 行为），返回 `POLICY_DENIED_BY_USER`，
  错误消息明说「当前会话审批策略为 never，高危命令无法确认」。
- `reason` 携带命中规则 id、服务器名、完整命令原文。

**约束**：`ctx.approval.request` 要求当前有打开的 turn，否则 reject。
`srv_exec` 是工具调用，天然在 turn 内；但**面板的「测试连接」不在 turn 内**，
故它走独立 HTTP 路由且不做高危判定。

### 6.2 审计

- 每次 `srv_exec` **必写一行**，无论 allow / confirm / block。
- 追加写，不自动轮转；可选 `auditMaxBytes` 超限时轮转一次。
- 面板只读尾部 N 条，不全量加载。

**取舍**：相对 AuditLog 表失去查询/聚合能力，只能 grep；换来零依赖、零迁移、可直接 `tail -f`。

### 6.3 凭据

- 密码 / passphrase → `ctx.credentials.set(ref, value)`，ref 形如 `server-connector:srv-01:password`。
- `servers.json` 只存 `credentialRef`，**永不存明文**。
- 表单提交密码 → HTTP 路由 → `credentials.set`；回显只显示「已设置/未设置」。
- 私钥路径存 `servers.json`（路径非秘密），密钥内容由 `ssh2` 自行读文件。

### 6.4 主机密钥

| `hostKeyMode` | 行为 |
|---|---|
| `accept-new`（默认） | 首次连接把指纹记入 `known_hosts.json`；之后指纹变了**拒绝连接**并报 `HOST_KEY_UNKNOWN` |
| `verify` | 只认已有指纹，未知主机直接拒绝 |
| `off` | 跳过校验（明确标注不安全；保存此值必须走待确认区） |

---

## 7. SSH 传输层

### 7.1 选型：`ssh2`

| 方案 | 取舍 |
|---|---|
| **`ssh2`（选它）** | 纯 JS 单依赖、跨平台一致、连接池可控、后续可扩展 SFTP/转发；不支持 GSSAPI/Kerberos |
| 本机 `ssh` 命令 | 支持 `~/.ssh/config` 全部特性与 Kerberos；但每条命令新建连接，stdout 解析与转义更脆弱 |

理由：现有 `dev-ops-mcp` 的 `src/utils/executor.py#L35` 用
`escaped = remote_cmd.replace("'", "'\\\\''")` 手工转义本地 shell 参数，是长期 bug 源。
`ssh2` 直接传 `command` 字符串，转义由库处理。

### 7.2 连接池

```
Pool
├─ per-server: { conn, lastUsed, alive }
├─ get(serverId) → 复用活连接；失效则重建（仅一次）
└─ idleTimeout: 10 分钟无使用自动关闭
```

- 每服务器**一条长连接**（非每命令一条），省握手开销。
- 连接失效 → `srv_exec` 自动重连**一次**；再失败返回 `CONNECT_FAILED`。不做无限重试。
- 同一服务器的命令**串行**（单 Channel 队列），不同服务器可并行。
  沿用现有 `is_project_locked` 的「避免并发冲突」思路，粒度改为服务器。

### 7.3 执行与超时（本规格的技术关键点）

- **不申请 PTY**（`pty: false`）：命令式执行不需要终端，避免 `\r\n` 与颜色转义码污染输出。
  （现有 `src/utils/ssh_client.py` 的 `invoke_shell` 属交互终端场景，那条路径留给面板测试连接。）
- **cwd**：`cd '<cwd>' && <command>`，在**远端**拼接，不经过本地 shell，故只需处理远端 shell 语义。
- **超时必须杀远端进程组**。`ssh2` 的 `stream.signal('KILL')` 只杀 channel 内进程，杀不掉子进程。
  故在远端前置 watchdog：

```sh
exec 2>&1
sh -c '<command>' & child=$!
( sleep <timeout>; kill -KILL -$child 2>/dev/null ) & watchdog=$!
wait $child; rc=$?
kill $watchdog 2>/dev/null
exit $rc
```

**这是对现有实现的实质性修正**：`src/utils/executor.py#L113` 的
`os.killpg(os.getpgid(process.pid), SIGKILL)` 杀的是**本地 ssh 客户端进程组**，
远端真正的子进程可能仍存活（SSH 断开通常触发 SIGHUP，但不保证）。

### 7.4 主机密钥校验

用 `ssh2` 的 `hostVerifier` 回调：

```js
hostVerifier: (keyHash, callback) => {
  const known = knownHosts.get(serverId)
  if (!known) {
    if (mode === 'accept-new') { knownHosts.set(serverId, keyHash); callback(true) }
    else callback(false)          // verify 模式拒绝未知主机
  } else {
    callback(known === keyHash)   // 指纹变更 → false → HOST_KEY_UNKNOWN
  }
}
```

### 7.5 错误归一

| ssh2 现象 | 归一 | 提示 |
|---|---|---|
| `ECONNREFUSED` / `ETIMEDOUT` | `CONNECT_FAILED` | 检查主机/端口、远端 sshd 是否运行 |
| `All configured authentication methods failed` | `AUTH_FAILED` | 检查用户名/密钥/密码 |
| `hostVerifier` false 且已有指纹 | `HOST_KEY_UNKNOWN` | 指纹变更，确认无误后在面板信任新指纹 |
| `hostVerifier` false 且无指纹（verify 模式） | `HOST_KEY_UNKNOWN` | 主机未受信，改用 accept-new 或手动添加 |

---

## 8. 侧边栏 UI（Client 半）

### 8.1 挂载点（均来自已确认的 live Slot 树）

| Slot | 类型 | 用途 |
|---|---|---|
| `sidebar.panellist` | list | 左侧栏「服务器」图标 |
| `main`（`key: "server-connector"`） | keyed | 服务器列表 / 详情 / 表单（`conversation` 已被占用，其余 key 空闲） |
| `settings.section` | list | 全局设置 + 待确认区 |

### 8.2 主面板

```
┌─ 服务器 ──────────────────────────── [+ 新增] ─┐
│  ● 生产机-A          devops@10.0.0.5:22        │
│    /srv/app          [已连接] [测试] [编辑]     │
│  ○ 测试机-B          devops@10.0.0.6:22        │
│    /srv/app          [未连接] [测试] [编辑]     │
└────────────────────────────────────────────────┘
```

`●` 绿点 = 连接池有活连接；`○` 灰点 = 无。
点进一行 → 详情页：连接四字段只读、高危策略表、最近 20 条审计、[删除]。

### 8.3 待确认区（危险操作两段式）

| 触发操作 | 立即行为 | 待确认记录 |
|---|---|---|
| 删除服务器 | 服务器**仍存在、仍可用** | `{kind:'delete-server', serverId, requestedAt, snapshot}` |
| `hostKeyMode` 改为 `off` | 该服务器**仍按原策略连接** | `{kind:'disable-hostkey', serverId, requestedAt}` |
| 停用某条高危规则（加入 `disabledRules`） | 该规则**仍生效** | `{kind:'disable-rule', serverId, ruleId, requestedAt}` |

待确认区位于 `settings.section` 的「待确认操作」页，顶部显示红色计数徽章：

```
删除服务器「生产机-A」        申请于 11-04 17:20    [确认执行]  [取消]
关闭主机密钥校验「测试机-B」   申请于 11-04 17:22    [确认执行]  [取消]
```

状态机：

```
无记录 ──用户点删除/选off──► pending ──[确认执行]──► applied（执行 + 审计留痕）
                                  └──[取消] 或 24h 过期──► discarded
```

- 过期：24 小时后自动丢弃（进程启动时与每次读写时各检查一次）。
- 确认删除：真删 `servers.json` 记录 + 删对应 credentials + 断开连接池，
  并在审计写一条 `server-deleted` 事件。
- 确认 off：改 `hostKeyMode` 并在审计写一条 `hostkey-disabled` 事件。
- 确认停用规则：把 `ruleId` 加入 `disabledRules` 并在审计写一条 `rule-disabled` 事件。
- 取消：删记录，服务器保持原状。

**理由**：浏览器 confirm 是「点一下就没了」的瞬时决策，误点不可挽回；
待确认区把决策延迟到用户回到设置页、看到完整上下文（申请时间、目标、后果）时再做，且中途可取消。
代价是多一次跳转。

### 8.4 表单字段

| 字段 | 控件 | 校验 |
|---|---|---|
| 名称 | 文本框 | 非空、唯一 |
| 主机 / 端口 | 文本框 + 数字 | 端口 1–65535 |
| 用户名 | 文本框 | 非空 |
| 认证方式 | 单选：私钥 / 密码 / SSH agent | — |
| 私钥路径 | 文本框（仅「私钥」） | 绝对路径、文件存在 |
| 密码 | 密码框（仅「密码」） | 只写不回显；已设置显示「已设置」 |
| 主机密钥策略 | 下拉 accept-new / verify / off | 选 `off` → **写入待确认区**，不立即生效 |
| 默认工作目录 | 文本框 | 绝对路径 |
| 高危策略 | 表格，每行一个内置规则 + 四选一（allow / confirm / block / 停用） | `block` 只能改 `confirm`，不能直接改 `allow`；选「停用」→ **写入待确认区**，不立即生效 |

### 8.5 HTTP 路由（`ctx.webServer.register`）

| 方法 + 路径 | 作用 |
|---|---|
| `GET /server-connector/servers` | 列表（不含凭据） |
| `POST /server-connector/servers` | 新增 |
| `PUT /server-connector/servers/:id` | 更新 |
| `DELETE /server-connector/servers/:id` | **删除请求 → 入队** |
| `POST /server-connector/test` | 测试连接（不在 turn 内，不做高危判定） |
| `POST /server-connector/connect/:id` | 主动建立连接 |
| `POST /server-connector/disconnect/:id` | 断开 |
| `GET /server-connector/audit?limit=20` | 审计尾部 |
| `GET /server-connector/pending` | 待确认列表 |
| `POST /server-connector/pending/:id/confirm` | 确认执行 |
| `POST /server-connector/pending/:id/cancel` | 取消 |

路由与 GUI 同一信任边界（DSH `webServer` 已受连接层鉴权保护）。

---

## 9. 打包、安装与验证

### 9.1 包结构

```
dsh-server-connector/
├── package.json
├── cordis.patch.yml
├── lib/
│   ├── index.js      # export name/Config/inject/apply
│   ├── registry.js
│   ├── pool.js
│   ├── policy.js
│   ├── tools.js
│   ├── audit.js
│   ├── pending.js
│   ├── routes.js
│   └── client.js
├── locale/{zh,en}.json
└── icon.svg
```

### 9.2 package.json 的 `dsh` 段

```jsonc
"dsh": {
  "engines": { "dsh": ">=0.1.0-rc.6 <0.3.0" },
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": {
    "inject": ["@deepseek-ai/dsh-client-ui-renderer", "@deepseek-ai/dsh-client-locale"],
    "platform": "web"
  }
}
```

### 9.3 cordis.patch.yml

```yaml
- insert:
    - id: dsh-server-connector
      name: 'dsh-server-connector'
```

### 9.4 Host 半出口

```js
export const name = 'dsh-server-connector'
export const inject = ['tools', 'systemPrompt']   // 硬依赖
export const Config = z.object({ /* schemastery */ })
export function apply(ctx, config) { /* ... */ }
```

`credentials` / `jobs` / `webServer` 用**可选注入**（`ctx.get('...')`），缺失时降级：

- 无 credentials → 仅允许私钥/agent 认证。
- 无 jobs → 强制同步执行 + 硬超时。

### 9.5 安装

```bash
plugin_manager install_bundle  target=<abs path to dsh-server-connector>
```

装完读返回的 `application` 与 `warnings` 判断是否生效，再用 `cordis_inspect_query` 确认新行存在
（**不用** `list_plugins`，因为那需要额外审批且不反映 Config 状态）。

### 9.6 验证清单

| 层 | 怎么验 | 通过标准 |
|---|---|---|
| 插件装载 | `Config.listConfigs` 过滤包名 | 出现该行，状态 `schema` |
| 工具注册 | `Tool.listTools` | 6 个 `srv_*` 出现在列表 |
| Slot 注册 | `Slots.listSubTree` root=`sidebar.panellist` | 出现我们的 id |
| 连接 | 面板「测试」连真实服务器 | 返回平台 + shell + 耗时 |
| 执行 | `srv_exec` 跑 `echo hi` | exitCode 0，stdout `hi` |
| 策略 | `srv_exec` 跑 `rm -rf /tmp/sc-test` | 返回 `POLICY_BLOCKED`，且目录**未被删除** |
| 审批 | 会话策略 `ask` 下跑 `systemctl restart x` | 弹确认框；拒绝后返回 `POLICY_DENIED_BY_USER` |
| 审批 fail-closed | 会话策略 `never` 下同上 | 直接返回 `POLICY_DENIED_BY_USER`，不弹框 |
| 超时杀进程组 | `timeoutMs=2000` 跑 `sleep 300 & wait` | 2 秒返回 `TIMEOUT`；远端 `ps` 确认无残留进程 |
| 增量输出 | 长命令 → `jobId` → 连读两次 `srv_job_output` | 第二次只返回新增字节，`next` 递增 |
| 审计 | 上述操作后读 `audit.log` | 每行一个 JSON，含 block 记录 |
| 待确认 | 面板点删除 → 查 `pending` | 服务器仍在；确认后消失 |
| 停用规则 | 面板停用 `rm-recursive` → 查 `pending` | 规则仍生效（`srv_policy_check` 仍返回 block）；确认后规则消失 |
| 指纹变更 | 手动改 `known_hosts.json` 的 hash | 连接被拒，报 `HOST_KEY_UNKNOWN` |

**「超时杀进程组」必须用远端 `ps` 验证** —— 这是第 7.3 节 watchdog 是否真生效的唯一证据。

### 9.7 里程碑

| 里程碑 | 内容 | 验收 |
|---|---|---|
| **M1** | registry + pool + `srv_list`/`srv_connect`/`srv_exec`（同步） | 无 UI 情况下用工具跑通一条命令 |
| **M2** | policy + approval + audit + 异步 jobs | 高危拦截/审批/审计/增量输出全部可验 |
| **M3** | Client 半：侧边栏 + 主面板 + 表单 | 面板能增删改服务器、测试连接 |
| **M4** | 待确认区 + 设置页 | 删除与 off 走两段式 |

**M1 之后即可用**；M3/M4 是体验层。该顺序保证核心执行能力最先被验证，UI 不掩盖传输层问题。

---

## 10. 全局配置（`Config` schema）

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `connectTimeoutMs` | number | 15000 | SSH 连接超时 |
| `commandTimeoutMs` | number | 60000 | 单条命令默认超时（工具参数可覆盖） |
| `syncTimeoutMs` | number | 20000 | 超过此时长自动转异步 job |
| `maxOutputChars` | number | 200000 | 同步输出上限，超出截断标 `TRUNCATED` |
| `idleTimeoutMs` | number | 600000 | 连接池空闲关闭 |
| `auditEnabled` | boolean | true | 是否写审计 |
| `auditMaxBytes` | number | 0 | 0 = 不轮转；>0 超限轮转一次 |
| `pendingTtlHours` | number | 24 | 待确认记录过期时间 |
| `maxListedServers` | number | 8 | 系统提示里最多列几台服务器 |

---

## 11. 风险与已知限制

| 风险 | 说明 | 缓解 |
|---|---|---|
| 正则策略不是安全边界 | 拦不住 `python -c "shutil.rmtree(...)"`、`base64 -d \| sh` | 远端专用低权限用户 + sudo 白名单（沿用 `mcp-init.sh` 思路） |
| 无 Kerberos/GSSAPI | 选 `ssh2` 的代价 | 需要时后续加 openssh 后端（参考 dsh-remote 的 `backend` 配置） |
| 无跳板机 | v1 单跳直连 | 后续扩展 `proxy` 配置 |
| `ctx.approval` 依赖 turn | 面板操作无法复用 | 面板危险操作改走待确认区（第 8.3 节） |
| 审计无查询能力 | 只能 grep | 可接受；需要时另做分析脚本 |
| 系统提示对所有会话可见 | 去掉会话绑定后的取舍 | 超过 8 台时折叠 |

---

## 12. 与现有 dev-ops-mcp 的关系

新插件**不依赖**、**不修改**现有仓库。两者可并存：

- 现有 `dev-ops-mcp` 继续服务于 Claude / Cursor 等外部 MCP 客户端。
- `dsh-server-connector` 服务于 DSH 内的 agent。

本规格中两处对现有代码的**实质性修正建议**（若日后维护现有仓库）：

1. `src/utils/executor.py#L32-L49` 的 `StrictHostKeyChecking=no` 应改为 `accept-new` + `known_hosts`。
2. `src/utils/executor.py#L113` 的 `os.killpg` 只杀本地 ssh 客户端进程组，远端子进程可能残留；
   应改为远端 watchdog（见第 7.3 节）。

---

## 附录 A：设计决策记录

| 决策 | 选择 | 理由 |
|---|---|---|
| 宿主 | DSH 插件 | 用户明确选择 |
| 核心边界 | 只保留 SSH 执行 | 用户明确选择；去掉项目/自动化/Web 控制台 |
| 执行语义 | 自由命令 + 内置高危目录 | 用户提出「预设排查高危命令，配置时逐条设置」 |
| 凭据存储 | 插件自有注册表 + `ctx.credentials` | 自包含，密钥不落明文 |
| 确认机制 | DSH 原生 `ctx.approval` | 与 DSH 体验一致，不自造 token |
| 服务器寻址 | 每次显式传 `server` | 用户认为会话绑定意义不大，明确要求去掉 |
| 面板危险操作 | 待确认区（两段式） | `approval` 依赖 turn，面板不在 turn 内 |
| SSH 传输 | `ssh2` | 避免本地 shell 转义 bug；跨平台一致 |
| 超时实现 | 远端 watchdog 杀进程组 | 修正现有实现只杀本地客户端的缺陷 |
| host key | 默认 `accept-new`，变更即拒 | 修正现有 `StrictHostKeyChecking=no` |
| block 降级 | 不可降为 allow，只能降为 confirm | 防止误操作永久失去保护 |
