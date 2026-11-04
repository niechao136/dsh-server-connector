// Tests for the high-risk policy engine (design doc §4.2).
//
// Run with: node --test tests/policy.test.ts  (Node strips the types natively)
// or:       pnpm test
//
// One `test()` block per §4.2 semantics clause: subcommand splitting, strictest
// wins, server overrides, the block→confirm-only restriction, disabledRules, and
// "no match is allow". The rule table itself (§4.1) is pinned rule by rule.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  RULES,
  RULES_BY_ID,
  check,
  checkCommand,
  compareDecisions,
  effectiveDecision,
  splitSubcommands,
} from '../lib/policy.js'

/** Narrow helper so a test reads `decisionOf('rm -rf /') === 'block'`. */
function decisionOf(command: string, serverPolicy?: unknown, disabledRules?: string[]): string {
  return check(command, serverPolicy as never, disabledRules).decision
}

describe('catalog (§4.1)', () => {
  test('has exactly 20 built-in rules with unique ids', () => {
    assert.equal(RULES.length, 20)
    assert.equal(new Set(RULES.map((rule) => rule.id)).size, 20)
  })

  test('every rule carries id, label, description and a block/confirm default', () => {
    for (const rule of RULES) {
      assert.equal(typeof rule.id, 'string', `${rule.id}: id`)
      assert.ok(rule.id.length > 0, 'id is non-empty')
      assert.equal(typeof rule.label, 'string', `${rule.id}: label`)
      assert.ok(rule.label.length > 0, `${rule.id}: label is non-empty`)
      assert.equal(typeof rule.description, 'string', `${rule.id}: description`)
      assert.ok(rule.description.length > 0, `${rule.id}: description is non-empty`)
      assert.ok(
        rule.defaultDecision === 'block' || rule.defaultDecision === 'confirm',
        `${rule.id}: default is block or confirm, never allow`,
      )
      assert.ok(rule.pattern ?? rule.wholePattern, `${rule.id}: has a matcher`)
    }
  })

  test('ids and defaults match the §4.1 table exactly', () => {
    const expected: Array<[string, 'block' | 'confirm']> = [
      ['rm-recursive', 'block'],
      ['dd-write', 'block'],
      ['db-drop', 'block'],
      ['fork-bomb', 'block'],
      ['shutdown', 'block'],
      ['reboot', 'block'],
      ['chmod-root', 'confirm'],
      ['chown-root', 'confirm'],
      ['service-stop', 'confirm'],
      ['service-restart', 'confirm'],
      ['docker-prune', 'confirm'],
      ['curl-pipe-sh', 'confirm'],
      ['kill-all', 'confirm'],
      ['passwd-edit', 'block'],
      ['crontab-edit', 'confirm'],
      ['iptables-flush', 'confirm'],
      ['git-force-push', 'confirm'],
      ['history-clear', 'confirm'],
      ['truncate-log', 'confirm'],
      ['sudoers-edit', 'block'],
    ]
    assert.deepEqual(
      RULES.map((rule) => [rule.id, rule.defaultDecision]),
      expected,
    )
    for (const [id] of expected) assert.ok(RULES_BY_ID.has(id), `${id} is indexed`)
  })

  test('the catalog is frozen so callers cannot edit rules at runtime', () => {
    assert.ok(Object.isFrozen(RULES))
    for (const rule of RULES) assert.ok(Object.isFrozen(rule), `${rule.id} is frozen`)
  })
})

describe('§4.1 rule matching', () => {
  /** Every matched rule for a command line. */
  const idsOf = (command: string): string[] => check(command).matches.map((match) => match.id)

  test('rm-recursive matches -r / -R / -rf / --recursive and blocks', () => {
    for (const command of ['rm -rf /tmp/x', 'rm -r /tmp/x', 'rm -R /tmp/x', 'rm -fr /tmp/x', 'rm --recursive /tmp/x', 'sudo rm -rf /var/lib/app']) {
      assert.equal(decisionOf(command), 'block', command)
      assert.equal(check(command).ruleId, 'rm-recursive', command)
    }
    // A non-recursive rm is not this rule's business.
    assert.equal(decisionOf('rm -f /tmp/x'), 'allow')
    assert.ok(!idsOf('rm -f /tmp/x').includes('rm-recursive'))
  })

  test('dd-write matches dd to /dev and mkfs', () => {
    for (const command of ['dd if=/dev/zero of=/dev/sda', 'dd of=/dev/nvme0n1 if=/tmp/x', 'mkfs.ext4 /dev/sdb', 'mkfs /dev/sdc']) {
      assert.equal(decisionOf(command), 'block', command)
      assert.equal(check(command).ruleId, 'dd-write', command)
    }
    assert.equal(decisionOf('dd if=/dev/sda of=/tmp/disk.img'), 'allow')
  })

  test('db-drop matches DROP DATABASE / DROP TABLE / TRUNCATE', () => {
    for (const command of [
      'mysql -e "DROP DATABASE app"',
      'psql -c "drop table users"',
      'mysql -e "TRUNCATE TABLE users"',
      'psql -c "truncate users"',
    ]) {
      assert.equal(decisionOf(command), 'block', command)
      assert.equal(check(command).ruleId, 'db-drop', command)
    }
    assert.equal(decisionOf('mysql -e "select * from users"'), 'allow')
    // The unix `truncate` (a file, not a table) belongs to truncate-log.
    assert.equal(decisionOf('truncate data.log'), 'confirm')
    assert.equal(check('truncate data.log').ruleId, 'truncate-log')
  })

  test('fork-bomb matches the classic self-replicating one-liner', () => {
    assert.equal(decisionOf(':(){ :|:& };:'), 'block')
    assert.equal(check(':(){ :|:& };:').ruleId, 'fork-bomb')
  })

  test('shutdown matches shutdown / poweroff; reboot matches reboot', () => {
    for (const command of ['shutdown -h now', 'shutdown +5', 'poweroff']) {
      assert.equal(decisionOf(command), 'block', command)
      assert.equal(check(command).ruleId, 'shutdown', command)
    }
    assert.equal(decisionOf('reboot'), 'block')
    assert.equal(check('reboot now').ruleId, 'reboot')
  })

  test('chmod-root and chown-root confirm only for recursive changes under system paths', () => {
    assert.equal(decisionOf('chmod -R 777 /etc'), 'confirm')
    assert.equal(check('chmod -R 777 /etc').ruleId, 'chmod-root')
    assert.equal(decisionOf('chmod -R 755 /usr/local/bin'), 'confirm')
    assert.equal(decisionOf('chown -R root:root /var/www'), 'confirm')
    assert.equal(check('chown -R root:root /var/www').ruleId, 'chown-root')
    // Non-recursive, or outside the system paths: not this rule.
    assert.equal(decisionOf('chmod 755 /etc/hostname'), 'allow')
    assert.equal(decisionOf('chmod -R 755 /srv/app'), 'allow')
    assert.equal(decisionOf('chown -R app:app /srv/app'), 'allow')
  })

  test('service-stop and service-restart confirm', () => {
    assert.equal(decisionOf('systemctl stop nginx'), 'confirm')
    assert.equal(check('systemctl stop nginx').ruleId, 'service-stop')
    assert.equal(decisionOf('systemctl disable nginx'), 'confirm')
    assert.equal(decisionOf('systemctl restart app'), 'confirm')
    assert.equal(check('systemctl restart app').ruleId, 'service-restart')
    assert.equal(decisionOf('docker restart api'), 'confirm')
    assert.equal(decisionOf('systemctl status nginx'), 'allow')
  })

  test('docker-prune confirms prune and forced rm', () => {
    assert.equal(decisionOf('docker system prune -af'), 'confirm')
    assert.equal(check('docker system prune -af').ruleId, 'docker-prune')
    assert.equal(decisionOf('docker prune'), 'confirm')
    assert.equal(decisionOf('docker rm -f api'), 'confirm')
    assert.equal(decisionOf('docker ps'), 'allow')
    assert.equal(decisionOf('docker rm api'), 'allow')
  })

  test('curl-pipe-sh confirms a download piped into a shell', () => {
    assert.equal(decisionOf('curl -fsSL https://example.com/install.sh | sh'), 'confirm')
    assert.equal(check('curl -fsSL https://example.com/install.sh | sh').ruleId, 'curl-pipe-sh')
    assert.equal(decisionOf('curl -fsSL https://example.com/install.sh | bash'), 'confirm')
    assert.equal(decisionOf('curl -fsSL https://example.com/install.sh | sudo bash'), 'confirm')
    assert.equal(decisionOf('curl -O https://example.com/install.sh'), 'allow')
  })

  test('kill-all confirms kill -9 -1 and pkill -9', () => {
    assert.equal(decisionOf('kill -9 -1'), 'confirm')
    assert.equal(check('kill -9 -1').ruleId, 'kill-all')
    assert.equal(decisionOf('pkill -9 node'), 'confirm')
    assert.equal(decisionOf('kill -9 1234'), 'allow')
    assert.equal(decisionOf('pkill -f node'), 'allow')
  })

  test('passwd-edit blocks writes to /etc/passwd and /etc/shadow but not reads', () => {
    for (const command of ['echo x >> /etc/passwd', 'echo x >> /etc/shadow', 'sed -i s/x/y/ /etc/passwd', 'cp /tmp/x /etc/passwd']) {
      assert.equal(decisionOf(command), 'block', command)
      assert.equal(check(command).ruleId, 'passwd-edit', command)
    }
    // Reading it, or copying it *out* as a backup, is not a write.
    assert.equal(decisionOf('cat /etc/passwd'), 'allow')
    assert.equal(decisionOf('grep root /etc/shadow'), 'allow')
    assert.equal(decisionOf('cp /etc/passwd /root/bak'), 'allow')
  })

  test('crontab-edit confirms crontab -r and writes under /etc/cron*', () => {
    assert.equal(decisionOf('crontab -r'), 'confirm')
    assert.equal(check('crontab -r').ruleId, 'crontab-edit')
    assert.equal(decisionOf('echo "* * * * * x" >> /etc/cron.d/thing'), 'confirm')
    assert.equal(decisionOf('crontab -l'), 'allow')
  })

  test('iptables-flush confirms -F / --flush', () => {
    assert.equal(decisionOf('iptables -F'), 'confirm')
    assert.equal(check('iptables -F').ruleId, 'iptables-flush')
    assert.equal(decisionOf('iptables -t nat --flush'), 'confirm')
    assert.equal(decisionOf('iptables -L'), 'allow')
  })

  test('git-force-push confirms --force and -f', () => {
    assert.equal(decisionOf('git push --force origin master'), 'confirm')
    assert.equal(check('git push --force origin master').ruleId, 'git-force-push')
    assert.equal(decisionOf('git push -f origin main'), 'confirm')
    assert.equal(decisionOf('git push origin master'), 'allow')
    assert.equal(decisionOf('git pull --force'), 'allow')
  })

  test('history-clear confirms history -c and wiping the history file', () => {
    assert.equal(decisionOf('history -c'), 'confirm')
    assert.equal(check('history -c').ruleId, 'history-clear')
    assert.equal(decisionOf('rm -f ~/.bash_history'), 'confirm')
    assert.equal(decisionOf('history'), 'allow')
  })

  test('truncate-log confirms redirects into /var/log and truncate -s 0', () => {
    assert.equal(decisionOf('> /var/log/syslog'), 'confirm')
    assert.equal(check('> /var/log/syslog').ruleId, 'truncate-log')
    assert.equal(decisionOf('truncate -s 0 /var/log/app.log'), 'confirm')
    assert.equal(decisionOf('truncate -s 100 /var/log/app.log'), 'allow')
    // Without -s, truncate zeroes the file: the same loss as `-s 0`.
    assert.equal(decisionOf('truncate app.log'), 'confirm')
    assert.equal(check('truncate app.log').ruleId, 'truncate-log')
  })

  test('sudoers-edit blocks writes to /etc/sudoers*', () => {
    assert.equal(decisionOf('echo "x ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers'), 'block')
    assert.equal(check('echo x > /etc/sudoers.d/x').ruleId, 'sudoers-edit')
    assert.equal(decisionOf('cat /etc/sudoers'), 'allow')
  })
})

describe('§4.2.1 subcommand splitting', () => {
  test('splits on && || ; | and newlines', () => {
    assert.deepEqual(splitSubcommands('a && b || c ; d | e'), ['a', 'b', 'c', 'd', 'e'])
    assert.deepEqual(splitSubcommands('a\nb\r\nc'), ['a', 'b', 'c'])
    assert.deepEqual(splitSubcommands('  a  &&\n b  '), ['a', 'b'])
  })

  test('drops empty segments and trims whitespace', () => {
    assert.deepEqual(splitSubcommands(''), [])
    assert.deepEqual(splitSubcommands('   \n  '), [])
    assert.deepEqual(splitSubcommands(';;;||'), [])
    assert.deepEqual(splitSubcommands('  ls  '), ['ls'])
  })

  test('rejects a non-string command', () => {
    assert.throws(() => splitSubcommands(42 as never), TypeError)
    assert.throws(() => check(undefined as never), TypeError)
  })

  test('every subcommand is checked, not only the first (doc §4.2.1)', () => {
    assert.equal(decisionOf('echo ok && rm -rf /'), 'block')
    assert.equal(decisionOf('ls; reboot'), 'block')
    assert.equal(decisionOf('ls || shutdown -h now'), 'block')
    assert.equal(decisionOf('echo ok | dd of=/dev/sda'), 'block')
    assert.equal(decisionOf('echo ok\nrm -rf /tmp/x'), 'block')
    assert.equal(decisionOf('cat /etc/hostname && echo hi'), 'allow')
  })

  test('the destructive half of a chain names the right rule', () => {
    const result = check('echo ok && rm -rf /tmp/x')
    assert.equal(result.decision, 'block')
    assert.equal(result.ruleId, 'rm-recursive')
    assert.equal(result.matchedRule?.id, 'rm-recursive')
  })

  test('the split subcommands are reported for callers that render a reason', () => {
    assert.deepEqual(check('ls && rm -rf /tmp/x').segments, ['ls', 'rm -rf /tmp/x'])
  })
})

describe('§4.2.2 the strictest decision wins', () => {
  test('block > confirm > allow', () => {
    assert.ok(compareDecisions('block', 'confirm') > 0)
    assert.ok(compareDecisions('confirm', 'allow') > 0)
    assert.ok(compareDecisions('allow', 'confirm') < 0)
    assert.equal(compareDecisions('block', 'block'), 0)
  })

  test('a block rule wins over a confirm rule in the same command line', () => {
    const result = check('systemctl restart app && rm -rf /tmp/x')
    assert.equal(result.decision, 'block')
    assert.equal(result.ruleId, 'rm-recursive')
    assert.deepEqual(
      result.matches.map((match) => [match.id, match.decision]),
      [
        ['rm-recursive', 'block'],
        ['service-restart', 'confirm'],
      ],
    )
  })

  test('a confirm rule wins over an allow outcome', () => {
    assert.equal(check('ls && systemctl restart app').decision, 'confirm')
    assert.equal(check('ls && systemctl restart app').ruleId, 'service-restart')
  })

  test('matchedRule is the strictest match, and null only for allow', () => {
    assert.equal(check('echo hi').matchedRule, null)
    assert.equal(check('echo hi').ruleId, null)
    assert.equal(check('shutdown -h now && reboot').matchedRule?.decision, 'block')
  })
})

describe('§4.2.3 server policy overrides', () => {
  test('a server may tighten a confirm rule to block', () => {
    assert.equal(decisionOf('systemctl restart app', { 'service-restart': 'block' }), 'block')
  })

  test('a server may loosen a confirm rule to allow', () => {
    assert.equal(decisionOf('systemctl restart app', { 'service-restart': 'allow' }), 'allow')
  })

  test('a server may lower a block rule to confirm', () => {
    assert.equal(decisionOf('rm -rf /tmp/x', { 'rm-recursive': 'confirm' }), 'confirm')
    assert.equal(check('rm -rf /tmp/x', { 'rm-recursive': 'confirm' }).ruleId, 'rm-recursive')
  })

  test('a block rule can never be lowered straight to allow (coerced to confirm)', () => {
    assert.equal(decisionOf('rm -rf /tmp/x', { 'rm-recursive': 'allow' }), 'confirm')
    assert.equal(decisionOf('shutdown -h now', { shutdown: 'allow' }), 'confirm')
    assert.equal(decisionOf('echo x >> /etc/passwd', { 'passwd-edit': 'allow' }), 'confirm')
  })

  test('effectiveDecision implements the same coercion', () => {
    const rmRule = RULES_BY_ID.get('rm-recursive')!
    const restartRule = RULES_BY_ID.get('service-restart')!
    assert.equal(effectiveDecision(rmRule, { 'rm-recursive': 'allow' }), 'confirm')
    assert.equal(effectiveDecision(rmRule, { 'rm-recursive': 'confirm' }), 'confirm')
    assert.equal(effectiveDecision(rmRule, {}), 'block')
    assert.equal(effectiveDecision(restartRule, { 'service-restart': 'allow' }), 'allow')
  })

  test('unknown ids and non-decision values fall back to the rule default', () => {
    assert.equal(decisionOf('rm -rf /tmp/x', { 'not-a-rule': 'allow' }), 'block')
    assert.equal(decisionOf('rm -rf /tmp/x', { 'rm-recursive': 'yes-please' }), 'block')
    assert.equal(decisionOf('rm -rf /tmp/x', { 'rm-recursive': null }), 'block')
  })

  test('accepts both the server-record shape and a bare override map', () => {
    // doc §3.1 server record
    const server = { policy: { 'rm-recursive': 'confirm' }, disabledRules: [] as string[] }
    assert.equal(check('rm -rf /tmp/x', server).decision, 'confirm')
    // bare override map
    assert.equal(check('rm -rf /tmp/x', { 'rm-recursive': 'confirm' }).decision, 'confirm')
    // omitted entirely
    assert.equal(check('rm -rf /tmp/x').decision, 'block')
    assert.equal(check('rm -rf /tmp/x', undefined).decision, 'block')
  })

  test('a server override does not leak into other rules', () => {
    const result = check('rm -rf /tmp/x && systemctl restart app', { 'rm-recursive': 'confirm' })
    assert.equal(result.decision, 'confirm')
    assert.deepEqual(
      result.matches.map((match) => [match.id, match.decision]),
      [
        ['rm-recursive', 'confirm'],
        ['service-restart', 'confirm'],
      ],
    )
  })
})

describe('§4.2.4 disabledRules', () => {
  test('a disabled rule is treated as if it did not exist', () => {
    const result = check('rm -rf /tmp/x', { policy: {}, disabledRules: ['rm-recursive'] })
    assert.equal(result.decision, 'allow')
    assert.equal(result.ruleId, null)
    assert.deepEqual(result.matches, [])
  })

  test('disabling one rule leaves every other rule in force', () => {
    const server = { policy: {}, disabledRules: ['rm-recursive'] }
    assert.equal(check('rm -rf /tmp/x && systemctl restart app', server).decision, 'confirm')
    assert.equal(check('rm -rf /tmp/x && shutdown -h now', server).decision, 'block')
  })

  test('accepts disabledRules as a third argument too', () => {
    assert.equal(check('rm -rf /tmp/x', {}, ['rm-recursive']).decision, 'allow')
    assert.equal(checkCommand('rm -rf /tmp/x', {}, ['rm-recursive']).decision, 'allow')
  })

  test('an unknown or non-string disabled id changes nothing', () => {
    assert.equal(decisionOf('rm -rf /tmp/x', { policy: {}, disabledRules: ['nope'] }), 'block')
    assert.equal(decisionOf('rm -rf /tmp/x', { policy: {}, disabledRules: [42] as never }), 'block')
  })

  test('a disabled rule stays disabled even when the server also overrides it', () => {
    const server = { policy: { 'rm-recursive': 'block' }, disabledRules: ['rm-recursive'] }
    assert.equal(check('rm -rf /tmp/x', server).decision, 'allow')
  })
})

describe('§4.2.5 / §4.2.6 no match is allow, and the verdict is pure', () => {
  test('ordinary commands are allowed', () => {
    for (const command of ['ls -la', 'echo hi', 'cat /etc/hostname', 'npm run build', 'systemctl status nginx', 'docker ps', 'git status']) {
      assert.equal(decisionOf(command), 'allow', command)
      assert.equal(check(command).matchedRule, null, command)
    }
  })

  test('an empty or whitespace-only command line is allow', () => {
    assert.equal(decisionOf(''), 'allow')
    assert.equal(decisionOf('   \n\t '), 'allow')
  })

  test('check() is pure: repeated calls and frozen input agree', () => {
    const server = Object.freeze({ policy: Object.freeze({ 'rm-recursive': 'confirm' as const }), disabledRules: Object.freeze([]) })
    const command = 'echo ok && rm -rf /tmp/x && systemctl restart app'
    const first = check(command, server as never)
    const second = check(command, server as never)
    assert.deepEqual(first, second)
    assert.equal(first.decision, 'confirm')
    // The command argument is not mutated, and the engine keeps no state.
    assert.equal(command, 'echo ok && rm -rf /tmp/x && systemctl restart app')
    assert.deepEqual(check('rm -rf /tmp/x').decision, 'block')
  })

  test('checkCommand is the same function as check', () => {
    assert.equal(checkCommand, check)
  })
})
