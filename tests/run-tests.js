#!/usr/bin/env node
/**
 * run-tests.js — Test runner for TCIsim
 *
 * Executes all test-*.js files in this directory and reports a summary.
 * Exit code 0 if all pass, 1 if any fail.
 *
 * Usage: node tests/run-tests.js
 */

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const dir = __dirname;
const files = fs.readdirSync(dir)
  .filter(f => f.startsWith('test-') && (f.endsWith('.js') || f.endsWith('.mjs')))
  .sort();

const WIDTH = 60;
const SEP = '─'.repeat(WIDTH);

console.log('\n' + SEP);
console.log('  TCIsim Test Suite');
console.log(SEP + '\n');

let totalPassed = 0;
let totalFailed = 0;
const results = [];

for (const file of files) {
  const filePath = path.join(dir, file);
  const result = spawnSync(process.execPath, [filePath], { encoding: 'utf8' });

  // Parse "X passed, Y failed" from stdout
  const match = result.stdout.match(/(\d+) passed,\s*(\d+) failed/);
  const passed = match ? parseInt(match[1], 10) : 0;
  const failed = match ? parseInt(match[2], 10) : 0;
  // Failure modes beyond a printed "N failed":
  //  - crashed: non-zero exit with 0 reported failures — covers both a crash
  //    before any summary AND a crash after a clean summary (teardown throw,
  //    unhandled rejection), which the old `!match` check reported as ok.
  //  - noSummary: clean exit but no summary line — a test file that silently
  //    ran nothing must not count as green.
  const crashed = result.status !== 0 && failed === 0;
  const noSummary = !match && result.status === 0;

  totalPassed += passed;
  totalFailed += failed + (crashed || noSummary ? 1 : 0);

  const label = file.replace(/^test-/, '').replace(/\.m?js$/, '');
  const status = crashed ? '  CRASH'
    : noSummary ? ' NO-SUM'
    : failed > 0 ? `  FAIL (${failed})` : '     ok';
  const counts = crashed || noSummary ? '' : `  ${passed}p / ${failed}f`;
  console.log(`  ${status.padEnd(12)} ${label.padEnd(28)} ${counts}`);

  if (crashed || noSummary) {
    console.log(`\n  --- ${crashed ? 'crash output' : 'no "N passed, N failed" summary printed'} ---`);
    console.log((result.stderr || result.stdout).trim().split('\n').map(l => '  ' + l).join('\n'));
    console.log('  ---\n');
  } else if (failed > 0) {
    // Print stdout for failed suites so failures are visible
    console.log('\n' + result.stdout.trim().split('\n').map(l => '  ' + l).join('\n') + '\n');
  }

  results.push({ file, passed, failed, crashed });
}

console.log('\n' + SEP);
const allPassed = totalFailed === 0;
const summary = allPassed
  ? `  ALL PASSED  ${totalPassed} tests`
  : `  FAILED  ${totalFailed} failed, ${totalPassed} passed`;
console.log(summary);
console.log(SEP + '\n');

process.exit(allPassed ? 0 : 1);
