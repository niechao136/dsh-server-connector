# 使用说明截图

README 里引用的界面截图与采集方式。截图是**真实运行**的 DSH Web 界面，不是设计稿。

| 文件 | 内容 | 对应 README 小节 |
|---|---|---|
| `panel.png` | 侧边栏「服务器」入口 + 服务器列表（一台已连接） | 五分钟上手 / 服务器面板 |
| `detail.png` | 服务器详情：连接信息、逐条高危策略、最近 20 条审计、删除 | 服务器面板 |
| `form.png` | 新增服务器表单，含每条内置规则的默认取值 | 服务器面板 |
| `settings.png` | 设置 → 服务器连接器：待确认操作 + 全局配置 | 审批与两段式确认 |
| `install-dialog.png` | 「插件 → 添加插件」对话框 | 安装 |

## 采集环境

- `@deepseek-ai/dsh@0.2.1-rc.5`，插件以 `link:` 方式装进一个独立 profile，
  该 profile 使用自己的 `$DSH_HOME`（`dsh plugin --profile web add <checkout>`）。
- Chromium（Playwright 自带的 131.0.6778.33）headless，通过 CDP 驱动：
  视口 1440×900（表单 1440×1080，详情 1440×2150），device scale 1，
  `prefers-color-scheme: light`，`locale: zh-CN`。
- 三台示例服务器（`本地演示机` / `生产机-A` / `测试机-B`）经由插件自己的
  `POST /server-connector/servers` 路由创建——与面板表单调用的是同一个接口。

## 演示数据是真的执行出来的

`detail.png` 里的 4 条审计来自一次真实会话：插件在本机起了
`linuxserver/openssh-server` 容器，用 `srv_connect` / `srv_exec` 依次跑了
`df -h /`、`df -h /srv/app`、`ls -l /srv/app`，最后一条是被策略拦下的
`rm -rf /srv/app/old`（`decision: "block"`，命令没有发到远端）。
**`settings.png` 里的待确认记录**也是真的：对 `测试机-B` 调用了一次
`DELETE /server-connector/servers/srv-03`，服务器仍在列表里，只是多了一条待确认请求。

## 截图之外已知的界面问题

- `srv_connect` / 面板「测试」的探测字段（platform / kernel / shell / sudo）目前恒为
  `unknown`：探测脚本在 POSIX shell 下有语法错误（`then;`）。README 的「已知限制」有记录。
- 截图只覆盖浅色主题与中文界面；样式里没有硬编码颜色（只引用设计令牌），
  这一点由 `tests/client.test.ts` 的 `stylesheet … only mentions design tokens` 断言，
  所以深色主题理论上可用，但本次没有采集深色截图。
