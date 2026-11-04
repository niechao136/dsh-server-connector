# Phase 5 — before/after evidence

The Client half (doc §8) did not exist before this change: on `master` the plugin
shipped only the Host half, so there was no sidebar row, no server panel and no
settings section to capture. Each image below therefore pairs the same screen
before the change with the same screen after it.

| File | Before | After |
|---|---|---|
| `before-after-sidebar.png` | `master` 8400d9c: sidebar lists 插件 / 自动化任务 / 更多 | this PR: the 服务器 row is added between them |
| `before-after-panel.png` | `master` 8400d9c: no main panel for servers exists | this PR: the server panel with status, test and edit |
| `before-after-detail.png` | `master` 8400d9c: no server detail view exists | this PR: connection fields, per-rule policy table, recent audit, 删除 |
| `before-after-form.png` | `master` 8400d9c: no server form exists | this PR: the §8.4 form |
| `before-after-settings.png` | `master` 8400d9c: settings nav ends at Agent 预设 | this PR: the 服务器连接器 section with the pending queue |

## How they were captured

Both revisions were booted as ordinary DSH Web profiles against the same
`@deepseek-ai/dsh@0.2.1-rc.5` installation, each with its own `$DSH_HOME` and
its own empty `server-connector` data directory, and driven in Chromium
(Playwright) at:

- viewport 1440×900, device scale 1
- `colorScheme: light`, `locale: zh-CN`
- the same onboarding dialog dismissed, the same navigation path to each screen

The "before" build is the `master` commit `8400d9c` (the merge of phase 4),
checked out as a separate worktree and linked into its own profile. The "after"
build is this branch.

The baseline has no panel to seed, so the two seeded servers (`生产机-A` /
`10.0.0.5:22` and `测试机-B` / `10.0.0.6:22`, key and agent authentication,
`/srv/app` working directory) exist only in the "after" captures, where they are
created through the plugin's own `POST /server-connector/servers` route — the
same route the form calls. The settings capture shows a deletion request queued
for `生产机-A`, which is the §8.3 two-step flow.

## What the captures do not prove

- The SSH transport behind 测试 is not exercised here; the two-step queue,
  routes and policy behaviour are covered by `tests/routes.test.ts` and
  `tests/integration.test.ts`.
- Only the light theme was captured; the stylesheet uses `--dsw-alias-*` tokens
  only, which is asserted by `tests/client.test.ts`.
