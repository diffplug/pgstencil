/**
 * Pins the security audit's reporting grammar and its redactor by executing the
 * shipped shell, not a copy of it. See `.github/workflows/security-audit.yml`
 * and `SECURITY.md` -> "Continuous checks".
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const workflow = readFileSync(
  join(repo, '.github/workflows/security-audit.yml'),
  'utf8',
);

/** The one literal every reader waits for. The producer copy in
 * `.github/audit/_preamble.md` is pinned against it below. */
const SENTINEL = '<!-- END OF REPORT -->';

/** The index of the step named `stepName`, and the column its `- ` sits in. */
function findStep(lines, stepName) {
  const at = lines.findIndex((line) => line.trim() === `- name: ${stepName}`);
  if (at < 0) throw new Error(`missing workflow step: ${stepName}`);
  return { at, indent: lines[at].indexOf('- ') };
}

/**
 * The lines of the block scalar introduced by `key` inside the named step,
 * dedented. Scanned by indentation rather than matched by a regex, which would
 * run past the end of the block and hand a test the rest of the file. A step
 * that has been renamed, or a key that has moved, must fail loudly here —
 * silently returning the next step's body, or an empty string, would leave a
 * test passing against nothing.
 */
function workflowBlock(source, stepName, key) {
  const lines = source.split('\n');
  const step = findStep(lines, stepName);
  let keyAt = -1;
  for (let i = step.at + 1; i < lines.length; i += 1) {
    if (
      lines[i].trim().startsWith('- ') &&
      lines[i].indexOf('- ') === step.indent
    )
      break;
    if (lines[i].trim() === `${key}: |`) {
      keyAt = i;
      break;
    }
  }
  if (keyAt < 0)
    throw new Error(
      `missing \`${key}: |\` block in workflow step: ${stepName}`,
    );
  const bodyIndent = lines[keyAt].search(/\S/) + 2;
  const body = [];
  for (const line of lines.slice(keyAt + 1)) {
    if (line.trim() !== '' && line.search(/\S/) < bodyIndent) break;
    body.push(line.slice(bodyIndent));
  }
  return body.join('\n');
}

/** The shell body of one workflow step, as shipped. */
const workflowRunBlock = (source, stepName) =>
  workflowBlock(source, stepName, 'run');

/**
 * Every file the archive step publishes, as the redactor must see them. Read
 * from the workflow rather than listed here, so a sink added to the artifact
 * without being added to the redactor fails this suite instead of shipping.
 */
const publishedSinks = workflowBlock(
  workflow,
  'Archive audit transcript',
  'path',
)
  .split('\n')
  .map((line) => line.trim().replace('${{ runner.temp }}/', ''))
  .filter(Boolean);

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fixture(t) {
  const dir = tempDir(t, 'pgstencil-audit-');
  mkdirSync(join(dir, 'bin'));
  mkdirSync(join(dir, 'scripts'));
  copyFileSync(
    join(repo, 'scripts/clamp-issue-body.mjs'),
    join(dir, 'scripts/clamp-issue-body.mjs'),
  );
  const env = {
    ...process.env,
    PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
    RUNNER_TEMP: dir,
    GITHUB_REPOSITORY: 'fixture/repo',
    GITHUB_RUN_ID: '123',
    CLAUDE_CODE_OAUTH_TOKEN: 'fixture-oauth-token',
  };
  return { dir, env };
}

function stub(dir, name, source) {
  writeFileSync(join(dir, 'bin', name), `#!${process.execPath}\n${source}\n`, {
    mode: 0o755,
  });
}

/** A stub `gh` that records every call; `openIssue` decides what `issue list` finds. */
function ghStub(dir, openIssue = true) {
  stub(
    dir,
    'gh',
    `
      const fs = require('node:fs');
      const args = process.argv.slice(2);
      fs.appendFileSync('gh-calls.jsonl', JSON.stringify(args) + '\\n');
      if (args[0] === 'issue' && args[1] === 'list') process.stdout.write(${openIssue ? "'23\\n'" : "''"});
    `,
  );
}

function ghCalls(dir) {
  const file = join(dir, 'gh-calls.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(JSON.parse);
}

const reporting = workflowRunBlock(
  workflow,
  'Surface result, file or close issue',
);

/** `report: null` means the file is never written at all. */
const cases = [
  {
    name: 'a finished PASS closes the open issues',
    report: `VERDICT: PASS\nEvidence\n\n${SENTINEL}\n`,
    expected: 'PASS',
  },
  // A trailing blank line after the sentinel still ends a finished report; read
  // with an exact `tail -n1` this PASS would be reported as cut off.
  {
    name: 'a trailing blank line still ends a report',
    report: `VERDICT: PASS\nEvidence\n\n${SENTINEL}\n\n\n`,
    expected: 'PASS',
  },
  // Cut off between rewriting the verdict line and writing the sentinel, a run
  // reads as a clean PASS on line 1. Without the sentinel guard that is a green
  // check run over a report that stopped early.
  {
    name: 'PASS without a sentinel is a cut-off audit',
    report: 'VERDICT: PASS\nEvidence\n',
    expected: 'INCONCLUSIVE',
    notes: ['cut off mid-report'],
  },
  {
    name: 'FAIL with an appended explanation is still a finding',
    report: `VERDICT: FAIL — credential leaked\nEvidence\n\n${SENTINEL}\n`,
    expected: 'FAIL',
    notes: [],
  },
  {
    name: 'a cut-off FAIL is still a finding',
    report: 'VERDICT: FAIL\nEvidence\n',
    expected: 'FAIL',
    notes: ['cut off mid-report'],
  },
  {
    name: 'INCONCLUSIVE is not a security finding',
    report: `VERDICT: INCONCLUSIVE\nEvidence\n\n${SENTINEL}\n`,
    expected: 'INCONCLUSIVE',
    notes: ['could not determine every check'],
  },
  {
    name: 'a missing report is inconclusive',
    report: null,
    expected: 'INCONCLUSIVE',
    notes: ['produced no report'],
  },
  {
    name: 'an empty report is inconclusive',
    report: '',
    expected: 'INCONCLUSIVE',
    notes: ['produced no report'],
  },
  {
    name: 'an unreadable verdict is not a pass',
    report: `Summary\nVERDICT: PASS\n\n${SENTINEL}\n`,
    expected: 'INCONCLUSIVE',
    notes: ['could not be read'],
  },
  {
    name: 'embedded whitespace is not PASS',
    report: `VERDICT:  PASS\n\n${SENTINEL}\n`,
    expected: 'INCONCLUSIVE',
    notes: ['could not be read'],
  },
  {
    name: 'a PASS prefix with a suffix is unreadable',
    report: `VERDICT: PASS but unfinished\n\n${SENTINEL}\n`,
    expected: 'INCONCLUSIVE',
    notes: ['could not be read'],
  },
  // Both conditions hold at once, and each is reported on its own terms: one
  // note per condition, never one block per combination.
  {
    name: 'an unreadable and unfinished report records both conditions',
    report: 'garbled\nevidence\n',
    expected: 'INCONCLUSIVE',
    notes: ['could not be read', 'cut off mid-report'],
  },
];

for (const scenario of cases) {
  test(`reporting: ${scenario.name}`, (t) => {
    const { dir, env } = fixture(t);
    ghStub(dir);
    if (scenario.report !== null)
      writeFileSync(join(dir, 'audit-report.md'), scenario.report);
    const result = spawnSync('bash', ['-c', reporting], {
      cwd: dir,
      env,
      encoding: 'utf8',
    });
    assert.equal(
      result.status,
      scenario.expected === 'PASS' ? 0 : 1,
      result.stderr,
    );
    const calls = ghCalls(dir);
    assert.equal(
      calls.some((args) => args[0] === 'issue' && args[1] === 'close'),
      scenario.expected === 'PASS',
    );
    if (scenario.expected === 'PASS') return;
    const body = readFileSync(join(dir, 'audit-comment.md'), 'utf8');
    assert.match(
      body,
      scenario.expected === 'FAIL'
        ? /Audit failed/
        : /Audit reached no usable verdict/,
    );
    for (const note of scenario.notes ?? [])
      assert.ok(body.includes(note), `missing note: ${note}`);
    // Whatever the run did write is published; a report is never summarised away.
    if (scenario.report)
      assert.ok(body.includes(scenario.report.split('\n')[0]), body);
  });
}

// Upward only. FAIL is the ceiling: an inconclusive run must not relabel an
// issue that already carries real findings, and the title never needs walking
// back down, because a PASS closes the issue outright.
for (const [name, report, retitles] of [
  ['a FAIL retitles the open issue', 'VERDICT: FAIL\nEvidence\n', true],
  [
    'an INCONCLUSIVE never retitles a FAIL issue',
    'VERDICT: INCONCLUSIVE\n',
    false,
  ],
]) {
  test(`reporting: ${name}`, (t) => {
    const { dir, env } = fixture(t);
    ghStub(dir);
    writeFileSync(join(dir, 'audit-report.md'), report);
    const result = spawnSync('bash', ['-c', reporting], {
      cwd: dir,
      env,
      encoding: 'utf8',
    });
    assert.equal(result.status, 1, result.stderr);
    const calls = ghCalls(dir);
    assert.ok(
      calls.some((args) => args[0] === 'issue' && args[1] === 'comment'),
      'expected an append',
    );
    assert.ok(
      !calls.some((args) => args[0] === 'issue' && args[1] === 'create'),
      'expected no second issue',
    );
    const edits = calls.filter(
      (args) => args[0] === 'issue' && args[1] === 'edit',
    );
    assert.equal(edits.length, retitles ? 1 : 0, JSON.stringify(calls));
    if (retitles)
      assert.match(
        edits[0].join(' '),
        /\[security-audit\] FAIL on \d{4}-\d{2}-\d{2}/,
      );
  });
}

test('reporting: with no open issue a new one is filed under the label', (t) => {
  const { dir, env } = fixture(t);
  ghStub(dir, false);
  writeFileSync(join(dir, 'audit-report.md'), 'VERDICT: FAIL\nEvidence\n');
  const result = spawnSync('bash', ['-c', reporting], {
    cwd: dir,
    env,
    encoding: 'utf8',
  });
  assert.equal(result.status, 1, result.stderr);
  const create = ghCalls(dir).find(
    (args) => args[0] === 'issue' && args[1] === 'create',
  );
  assert.ok(create, 'expected an issue to be created');
  assert.match(
    create.join(' '),
    /\[security-audit\] FAIL on \d{4}-\d{2}-\d{2}/,
  );
  assert.ok(create.includes('security-audit-failure'), create.join(' '));
});

test('redaction covers every published sink', (t) => {
  const { dir, env } = fixture(t);
  for (const sink of publishedSinks)
    writeFileSync(
      join(dir, sink),
      `before ${env.CLAUDE_CODE_OAUTH_TOKEN} after`,
    );
  const result = spawnSync(
    'bash',
    ['-c', workflowRunBlock(workflow, 'Redact secrets from agent output')],
    {
      cwd: dir,
      env,
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.ok(
    publishedSinks.length >= 2,
    `expected every sink, got ${publishedSinks.join(', ')}`,
  );
  for (const sink of publishedSinks)
    assert.equal(readFileSync(join(dir, sink), 'utf8'), 'before *** after');
  assert.match(
    result.stdout,
    /::warning::Redacted 2 literal secret occurrence/,
  );
});

test('a throwing redactor removes every published sink', (t) => {
  const { dir, env } = fixture(t);
  for (const sink of publishedSinks)
    writeFileSync(join(dir, sink), env.CLAUDE_CODE_OAUTH_TOKEN);
  stub(dir, 'node', 'process.exit(1);');
  const result = spawnSync(
    'bash',
    ['-c', workflowRunBlock(workflow, 'Redact secrets from agent output')],
    {
      cwd: dir,
      env,
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 1);
  for (const sink of publishedSinks)
    assert.equal(existsSync(join(dir, sink)), false, sink);
});

// The local runner applies the same grammar CI does. 'FAIL — explained' pins
// that an appended explanation is still a finding rather than an unreadable
// report; status alone cannot tell the two apart, so that row checks the
// message too. The `false` rows write no sentinel: a PASS on line 1 of a
// cut-off report does not exit zero here either.
for (const [verdict, cliExit, expected, sentinel = true] of [
  ['PASS', 0, 0],
  ['FAIL', 0, 1],
  ['FAIL — explained', 0, 1],
  ['INCONCLUSIVE', 0, 1],
  ['PASS extra', 0, 1],
  ['PASS', 7, 1],
  ['PASS', 0, 1, false],
  ['FAIL', 0, 1, false],
]) {
  test(`local runner: ${verdict}, CLI exit ${cliExit}${sentinel ? '' : ', no sentinel'}`, (t) => {
    const { dir, env } = fixture(t);
    copyFileSync(
      join(repo, 'scripts/security-audit-local.sh'),
      join(dir, 'scripts/security-audit-local.sh'),
    );
    mkdirSync(join(dir, '.github/audit'), { recursive: true });
    for (const name of ['_preamble', 'security']) {
      copyFileSync(
        join(repo, `.github/audit/${name}.md`),
        join(dir, `.github/audit/${name}.md`),
      );
    }
    // Reads the output file out of the prompt, so the domain file declaring a
    // different one fails here rather than producing an empty run.
    stub(
      dir,
      'claude',
      `
      const fs = require('node:fs');
      const prompt = process.argv[3];
      const output = prompt.match(/\\*\\*Output file:\\*\\* \\x60([^\\x60]+)\\x60/)[1];
      fs.writeFileSync(output, ${JSON.stringify(`VERDICT: ${verdict}\nEvidence\n${sentinel ? `${SENTINEL}\n\n` : ''}`)});
      process.exit(${cliExit});
    `,
    );
    const result = spawnSync('bash', ['scripts/security-audit-local.sh'], {
      cwd: dir,
      env,
      encoding: 'utf8',
    });
    assert.equal(result.status, expected, result.stderr);
    if (cliExit === 0)
      assert.ok(existsSync(join(dir, 'audit-report.md')), 'expected a report');
    if (cliExit === 0 && verdict.startsWith('FAIL')) {
      assert.ok(!result.stderr.includes('no readable verdict'), result.stderr);
      assert.match(result.stderr, /reports FAIL/);
    }
    if (cliExit === 0 && !sentinel)
      assert.match(result.stderr, /cut off before finishing/);
  });
}

// The producer side. Every consumer above is pinned by executing the shipped
// text, but the literal the agent is told to write lives only in
// `_preamble.md` — so without this the producer could be renamed and the whole
// suite would stay green against a sentinel nothing writes.
test('the preamble tells the auditor to write the sentinel every reader waits for', () => {
  const preamble = readFileSync(
    join(repo, '.github/audit/_preamble.md'),
    'utf8',
  );
  const written = [...preamble.matchAll(/^printf '[^']*' >> <your report>$/gm)];
  assert.equal(
    written.length,
    1,
    'expected exactly one closing `printf` in the preamble',
  );
  assert.match(
    written[0][0],
    new RegExp(SENTINEL.replace(/[-[\]{}()*+?.,\\^$|#]/g, '\\$&')),
  );
  // The verdict line the reporting step reads, and the fail-closed value it
  // opens as.
  assert.match(preamble, /^printf 'VERDICT: INCONCLUSIVE\\n/m);
  assert.match(preamble, /never buffered in your context/i);
});

// The consumer contract in PACKAGES.md is the job's check-run name, so the
// trigger that produces one per commit and the name it produces are both
// pinned here rather than left to review.
test('the workflow keeps the triggers and the job name a consumer reads', () => {
  assert.match(workflow, /^on:\n(?:.*\n)*? {2}push:\n {4}branches: \[main\]$/m);
  assert.match(workflow, /^ {2}schedule:\n {4}- cron: '51 4 \* \* \*'$/m);
  assert.match(workflow, /^ {2}workflow_dispatch:$/m);
  assert.match(workflow, /^ {2}security-audit:\n {4}name: security-audit$/m);
  // A superseded commit on `main` still needs its own verdict.
  assert.ok(
    !/^concurrency:/m.test(workflow),
    'the audit must not cancel a superseded run',
  );
});
