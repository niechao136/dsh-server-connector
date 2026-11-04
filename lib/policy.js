// dsh-server-connector — built-in high-risk command policy engine.
//
// A single pure module: it never touches the network, the file system, the clock
// or DSH. `srv_policy_check` and `srv_exec` both call `check()`, so the pre-flight
// verdict and the execution verdict can never disagree.
//
// This is containment, not a security boundary. Regexes cannot see through
// `python -c "shutil.rmtree('/')"` or `base64 -d | sh`; the real boundary is the
// unprivileged remote user plus a sudo allowlist. The contract here is only that
// known destructive patterns are blocked or require confirmation.

/**
 * One decision level.
 * @typedef {'allow' | 'confirm' | 'block'} Decision
 */

/**
 * One built-in rule. Either `pattern` or `wholePattern` is present; see
 * {@link RULES} for which one applies when.
 * @typedef {object} Rule
 * @property {string} id - stable rule id, the key of a server's policy map.
 * @property {string} label - short human-readable name, used in the approval reason.
 * @property {Decision} defaultDecision - `block` or `confirm`; never `allow`.
 * @property {string} description - what the rule is protecting against.
 * @property {RegExp} [pattern] - matched per subcommand and against the whole line.
 * @property {RegExp} [wholePattern] - matched against the whole line only.
 */

/** A rule that matched, with the decision it resolved to for this server. */
/**
 * @typedef {object} RuleMatch
 * @property {string} id
 * @property {string} label
 * @property {Decision} defaultDecision
 * @property {string} description
 * @property {Decision} decision
 */

/** The three decision levels, ordered from most to least permissive. */
export const DECISIONS = Object.freeze({
  ALLOW: /** @type {Decision} */ ('allow'),
  CONFIRM: /** @type {Decision} */ ('confirm'),
  BLOCK: /** @type {Decision} */ ('block'),
})

/** Severity rank: the strictest matching rule wins. `block > confirm > allow`. */
const RANK = Object.freeze({ allow: 0, confirm: 1, block: 2 })

/** Characters a single subcommand pattern may consume; separators are hard stops. */
const SEG = '[^\\n;|&]*'

/**
 * Verbs and redirections that modify the file they are told to modify: the
 * named path may appear anywhere after them. Used by the rules that block or
 * confirm a *write* to a system path while leaving a read (`cat /etc/passwd`)
 * alone.
 */
const WRITE_VERBS =
  '(?:>>?\\s*|\\btee\\b|\\brm\\b|' +
  `\\bsed\\b${SEG}\\s-i|\\b(?:vi|vim|nano|emacs|ed)\\b|\\btruncate\\b|\\bshred\\b)`

/**
 * Verbs whose *last* argument is the destination, so the protected path must be
 * preceded by at least one argument. Without that guard `cp /etc/passwd
 * /root/bak` — a backup, i.e. a read — would be reported as a write.
 */
const COPY_VERBS = '(?:\\bcp\\b|\\bmv\\b|\\binstall\\b|\\bln\\b)'

/**
 * A "writes this path" pattern: a write verb or redirection aimed at a path
 * matching `pathSource`. A copy verb counts only when the path is not its
 * first argument.
 * @param {string} pathSource - Regex source for the target path.
 * @returns {RegExp} compiled, case-insensitive pattern.
 */
function writePattern(pathSource) {
  return new RegExp(
    `(?:${WRITE_VERBS}${SEG}${pathSource})|(?:${COPY_VERBS}[^\\n;|&]*\\S\\s+${pathSource})`,
    'i',
  )
}

/**
 * The built-in rule catalog (doc §4.1). Exactly 20 rules; `defaultDecision` is
 * always `block` or `confirm`, never `allow`. Every rule is pure data: an id, a
 * label and description for the approval reason and panel, the default
 * decision, and the regexes it is matched with.
 *
 * `pattern` is tested against each subcommand (and the whole command line, which
 * is harmless because the patterns stop at separators). `wholePattern` is tested
 * against the whole command line only: the fork bomb and `curl … | sh` contain
 * separators themselves, so per-subcommand matching would never see them.
 *
 * The catalog is read-only: server policy can override a decision or disable a
 * rule, but never add to or edit the catalog.
 */
export const RULES = /** @type {readonly Rule[]} */ (Object.freeze([
  Object.freeze({
    id: 'rm-recursive',
    label: '递归删除',
    defaultDecision: 'block',
    description: 'rm 的递归删除（-r / -R / --recursive）会不可逆地删除整个目录树。',
    // `git rm -r` is left out: it removes tracked paths and stays recoverable
    // from the object database, so it is a VCS operation rather than a wipe.
    pattern: /(?<!git )\brm\b[^\n;|&]*(?:\s-[a-zA-Z]*r[a-zA-Z]*\b|\s--recursive\b)/i,
  }),
  Object.freeze({
    id: 'dd-write',
    label: '裸设备写入 / 格式化',
    defaultDecision: 'block',
    description: 'dd 直接写块设备或 mkfs 格式化会毁掉整块磁盘上的数据。',
    pattern: /\bdd\b[^\n;|&]*\bof=\s*\/dev\/|\bmkfs(?:\.[a-z0-9]+)?\b/i,
  }),
  Object.freeze({
    id: 'db-drop',
    label: '删库 / 清表',
    defaultDecision: 'block',
    description: 'DROP DATABASE / DROP TABLE / TRUNCATE 会不可逆地删除数据库或表数据。',
    // `truncate` alone is the unix command that zeroes a FILE (see truncate-log),
    // so as SQL it needs `TABLE` or a client that runs it (`psql -c "truncate t"`).
    pattern:
      /\bdrop\s+(?:database|schema|table)\b|\btruncate\s+table\b|\b(?:mysql|mariadb|psql|sqlite3|mongosh?|clickhouse-client|redis-cli)\b[^\n;|&]*\btruncate\b/i,
  }),
  Object.freeze({
    id: 'fork-bomb',
    label: 'fork 炸弹',
    defaultDecision: 'block',
    description: '递归自复制的 fork 炸弹会耗尽远端进程表，导致机器失联。',
    wholePattern: /:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:[^}]*\}/i,
  }),
  Object.freeze({
    id: 'shutdown',
    label: '关机',
    defaultDecision: 'block',
    description: 'shutdown / poweroff 会直接关掉远端主机。',
    pattern: /\b(?:shutdown|poweroff)\b/i,
  }),
  Object.freeze({
    id: 'reboot',
    label: '重启',
    defaultDecision: 'block',
    description: 'reboot 会重启远端主机，中断其上所有服务。',
    pattern: /\breboot\b/i,
  }),
  Object.freeze({
    id: 'chmod-root',
    label: '递归改系统路径权限',
    defaultDecision: 'confirm',
    description: '对 /etc、/usr、/bin 等系统路径递归 chmod 会破坏系统权限。',
    // A system path is one the distribution owns. `/home` and `/srv` are left
    // out on purpose: they hold user data and the default work dir of an app
    // (`/srv/app` in doc §3.1), so recursive chmod there is routine.
    pattern:
      /\bchmod\b[^\n;|&]*(?:\s-[a-zA-Z]*R[a-zA-Z]*\b|\s--recursive\b)[^\n;|&]*\/(?:etc|usr|bin|sbin|lib|lib32|lib64|boot|var|opt|root|proc|sys|dev)\b/i,
  }),
  Object.freeze({
    id: 'chown-root',
    label: '递归改系统路径属主',
    defaultDecision: 'confirm',
    description: '对 /etc、/usr、/var 等系统路径递归 chown 会破坏系统文件属主。',
    pattern:
      /\bchown\b[^\n;|&]*(?:\s-[a-zA-Z]*R[a-zA-Z]*\b|\s--recursive\b)[^\n;|&]*\/(?:etc|usr|bin|sbin|lib|lib32|lib64|boot|var|opt|root|proc|sys|dev)\b/i,
  }),
  Object.freeze({
    id: 'service-stop',
    label: '停用服务',
    defaultDecision: 'confirm',
    description: 'systemctl stop / disable 会停掉或取消自启服务，可能造成业务中断。',
    pattern: /\bsystemctl\b[^\n;|&]*\b(?:stop|disable)\b/i,
  }),
  Object.freeze({
    id: 'service-restart',
    label: '重启服务',
    defaultDecision: 'confirm',
    description: 'systemctl restart / docker restart 会短暂中断服务。',
    pattern: /\bsystemctl\b[^\n;|&]*\brestart\b|\bdocker\s+(?:container\s+)?restart\b/i,
  }),
  Object.freeze({
    id: 'docker-prune',
    label: '清理 / 强删容器',
    defaultDecision: 'confirm',
    description: 'docker prune / docker rm -f 会清掉镜像缓存或强删容器，可能丢数据。',
    pattern:
      /\bdocker\s+(?:system\s+)?prune\b|\bdocker\s+(?:container\s+)?rm\b[^\n;|&]*(?:\s-[a-zA-Z]*f\b|\s--force\b)/i,
  }),
  Object.freeze({
    id: 'curl-pipe-sh',
    label: 'curl 管道执行',
    defaultDecision: 'confirm',
    description: 'curl … | sh 会把远端脚本直接交给 shell 执行，内容不可预审。',
    wholePattern: /\bcurl\b[^\n]*\|\s*(?:sudo\s+)?(?:ba|da|z|k)?sh\b/i,
  }),
  Object.freeze({
    id: 'kill-all',
    label: '杀全部进程',
    defaultDecision: 'confirm',
    description: 'kill -9 -1 / pkill -9 会杀掉该用户能杀的所有进程。',
    pattern:
      /\bkill\b[^\n;|&]*(?:\s-9\b|\s-KILL\b|\s-s\s*(?:9|KILL)\b)[^\n;|&]*\s-1\b|\bpkill\b[^\n;|&]*(?:\s-9\b|\s-KILL\b|\s-s\s*(?:9|KILL)\b)/i,
  }),
  Object.freeze({
    id: 'passwd-edit',
    label: '改账号数据库',
    defaultDecision: 'block',
    description: '写 /etc/passwd 或 /etc/shadow 容易把账号系统改坏甚至锁死 root。',
    pattern: writePattern('\\/etc\\/(?:passwd|shadow)\\b'),
  }),
  Object.freeze({
    id: 'crontab-edit',
    label: '删改计划任务',
    defaultDecision: 'confirm',
    description: 'crontab -r 或写 /etc/cron* 会删除或植入定时任务。',
    pattern: new RegExp(
      `\\bcrontab\\s+-r\\b|${WRITE_VERBS}${SEG}\\/etc\\/cron`,
      'i',
    ),
  }),
  Object.freeze({
    id: 'iptables-flush',
    label: '清空防火墙',
    defaultDecision: 'confirm',
    description: 'iptables -F 会清空全部防火墙规则，可能把机器暴露出去。',
    pattern: /\biptables\b[^\n;|&]*\s(?:-F|--flush)\b/i,
  }),
  Object.freeze({
    id: 'git-force-push',
    label: '强制推送',
    defaultDecision: 'confirm',
    description: 'git push --force / -f 会覆盖远端历史（--force-with-lease 是安全变体，不在此列）。',
    // `--force-with-lease` is the guarded form: it only overwrites a branch the
    // pusher has already seen, so it is deliberately not matched.
    pattern: /\bgit\s+push\b[^\n;|&]*(?:\s--force(?!-with-lease)\b|\s-[a-zA-Z]*f[a-zA-Z]*\b)/i,
  }),
  Object.freeze({
    id: 'history-clear',
    label: '清空命令历史',
    defaultDecision: 'confirm',
    description: 'history -c 或清空 ~/.bash_history 会抹掉审计线索。',
    pattern:
      /\bhistory\s+-c\b|(?:>>?|\b(?:rm|shred|truncate|tee)\b)[^\n;|&]*\.[a-z_]*history\b/i,
  }),
  Object.freeze({
    id: 'truncate-log',
    label: '清空日志',
    defaultDecision: 'confirm',
    description: '重定向 /var/log/、把文件截断为 0 字节（truncate 无 -s 时即截断为 0）会清空日志文件。',
    pattern:
      /(?:>>?\s*\/var\/log\/)|\btruncate\b[^\n;|&]*(?:\s-s\s*0\b|\s--size\s*=?\s*0\b)|\btruncate\s+(?!--?[a-z])/i,
  }),
  Object.freeze({
    id: 'sudoers-edit',
    label: '改 sudo 配置',
    defaultDecision: 'block',
    description: '写 /etc/sudoers* 可能直接丢失 sudo 权限或开出无密码提权。',
    pattern: writePattern('\\/etc\\/sudoers'),
  }),
]))

/** Catalog indexed by rule id. */
export const RULES_BY_ID = new Map(RULES.map((rule) => [rule.id, rule]))

/**
 * Whether `value` is one of the three decisions.
 * @param {unknown} value
 * @returns {value is Decision}
 */
function isDecision(value) {
  return value === 'allow' || value === 'confirm' || value === 'block'
}

/**
 * Compare two decisions by severity.
 * @param {Decision} a
 * @param {Decision} b
 * @returns {number} positive when `a` is stricter than `b`, 0 when equal.
 */
export function compareDecisions(a, b) {
  return RANK[a] - RANK[b]
}

/**
 * Split a command line into the subcommands every rule must be checked against.
 *
 * Splits on `&&`, `||`, `;`, `|` and newlines (doc §4.2.1). Without this,
 * `echo ok && rm -rf /` would only be matched as a whole and the destructive
 * half could slip past a rule anchored at the start of the line.
 *
 * @param {string} command - the raw command line.
 * @returns {string[]} trimmed, non-empty subcommands.
 * @throws {TypeError} when `command` is not a string.
 */
export function splitSubcommands(command) {
  if (typeof command !== 'string') throw new TypeError('command must be a string')
  return command
    .split(/&&|\|\||;|\||\r?\n/)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '')
}

/**
 * Separate the two accepted second-argument shapes into overrides plus disabled
 * rule ids:
 * - a server record (`{ policy, disabledRules }`, doc §3.1), or
 * - a bare per-rule override map (`{ 'rm-recursive': 'confirm' }`).
 *
 * A third argument may carry `disabledRules` alongside a bare override map.
 * @param {Record<string, unknown>|undefined} serverPolicy
 * @param {string[]|undefined} disabledRules
 * @returns {{overrides: Record<string, unknown>, disabled: Set<string>}}
 */
function normalizeServerPolicy(serverPolicy, disabledRules) {
  const disabled = new Set(Array.isArray(disabledRules) ? disabledRules : [])
  if (serverPolicy === undefined || serverPolicy === null) {
    return { overrides: {}, disabled }
  }
  if (typeof serverPolicy !== 'object') throw new TypeError('serverPolicy must be an object')
  if (Array.isArray(serverPolicy.disabledRules)) {
    for (const id of serverPolicy.disabledRules) if (typeof id === 'string') disabled.add(id)
  }
  const fields = /** @type {Record<string, unknown>} */ (serverPolicy)
  const record = 'policy' in fields || 'disabledRules' in fields
  const policy = fields.policy
  /** @type {Record<string, unknown>} */
  const overrides = record
    ? policy !== null && typeof policy === 'object'
      ? /** @type {Record<string, unknown>} */ (policy)
      : {}
    : fields
  return { overrides, disabled }
}

/**
 * Resolve one rule's effective decision under a server's overrides (doc §4.2.3).
 *
 * A server may tighten any rule, loosen a `confirm` rule to `allow`, or lower a
 * `block` rule to `confirm`. It may **not** lower a `block` rule straight to
 * `allow`: that value is coerced to `confirm`, the loosest sanctioned setting.
 * Unknown ids and non-decision values fall back to the rule's default.
 *
 * @param {Rule} rule
 * @param {Record<string, unknown>} [overrides]
 * @returns {Decision}
 */
export function effectiveDecision(rule, overrides = {}) {
  const configured = overrides?.[rule.id]
  if (!isDecision(configured)) return rule.defaultDecision
  if (rule.defaultDecision === 'block' && configured === 'allow') return 'confirm'
  return configured
}

/**
 * Whether one rule matches the command line. A rule carries exactly one of
 * `pattern` / `wholePattern`; the other is undefined.
 * @param {Rule} rule
 * @param {string} command
 * @param {string[]} segments
 * @returns {boolean}
 */
function ruleMatches(rule, command, segments) {
  if (rule.wholePattern !== undefined) return rule.wholePattern.test(command)
  const pattern = /** @type {RegExp} */ (rule.pattern)
  return pattern.test(command) || segments.some((segment) => pattern.test(segment))
}

/**
 * The policy engine (doc §4.2): a pure function from
 * `(command, serverPolicy) → { decision, matchedRule, … }`.
 *
 * Semantics:
 * 1. the command line is split into subcommands and every subcommand is checked
 *    against every rule;
 * 2. the strictest matching decision wins (`block > confirm > allow`);
 * 3. `disabledRules` removes a rule entirely, so `srv_policy_check` and
 *    `srv_exec` agree on what exists;
 * 4. no match is `allow`.
 *
 * @param {string} command - the raw command line.
 * @param {{policy?: Record<string, unknown>, disabledRules?: string[]}|Record<string, unknown>} [serverPolicy]
 *   a server record (`{policy, disabledRules}`) or a bare override map.
 * @param {string[]} [disabledRules] - extra disabled ids when the second argument
 *   is a bare override map.
 * @returns {{
 *   decision: Decision,
 *   matchedRule: RuleMatch | null,
 *   ruleId: string | null,
 *   matches: RuleMatch[],
 *   segments: string[],
 * }}
 * @throws {TypeError} for a non-string command or a non-object policy argument.
 */
export function check(command, serverPolicy = {}, disabledRules) {
  const segments = splitSubcommands(command)
  const { overrides, disabled } = normalizeServerPolicy(serverPolicy, disabledRules)

  const matches = []
  for (const rule of RULES) {
    if (disabled.has(rule.id)) continue
    if (!ruleMatches(rule, command, segments)) continue
    matches.push({
      id: rule.id,
      label: rule.label,
      defaultDecision: rule.defaultDecision,
      description: rule.description,
      decision: effectiveDecision(rule, overrides),
    })
  }

  /** @type {Decision} */
  let decision = 'allow'
  /** @type {RuleMatch | null} */
  let matchedRule = null
  for (const match of matches) {
    if (RANK[match.decision] > RANK[decision]) {
      decision = match.decision
      matchedRule = match
    }
  }

  return {
    decision,
    matchedRule,
    ruleId: matchedRule === null ? null : matchedRule.id,
    matches,
    segments,
  }
}

/** Alias of {@link check} for callers that prefer an explicit verb. */
export const checkCommand = check
