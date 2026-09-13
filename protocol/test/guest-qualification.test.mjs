import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { isolationCommand, isolationScript, prefixCommand, prefixBytes } from './guest-qualification.mjs';

test('live qualification scripts fit the guest argv contract and parse without execution', () => {
  for (const command of [isolationCommand, prefixCommand]) {
    assert(Buffer.byteLength(command) <= 4096, 'guest per-argument limit exceeded');
    const shell = spawnSync('/bin/sh', ['-n', '-c', command], { encoding: 'utf8' });
    assert.equal(shell.status, 0, shell.stderr);
  }
  const python = spawnSync('python3', ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], {
    input: isolationScript, encoding: 'utf8',
  });
  assert.equal(python.status, 0, python.stderr);
});

test('resume qualification generates exactly the bounded printable high-entropy prefix', () => {
  // Execute just the producer locally. No guest, private state, or network access.
  const producer = prefixCommand.slice(prefixCommand.indexOf('python3'), prefixCommand.lastIndexOf(';'));
  const result = spawnSync('/bin/sh', ['-c', producer], { maxBuffer: prefixBytes + 1024 });
  assert.equal(result.status, 0, result.stderr.toString());
  assert.equal(result.stdout.length, prefixBytes);
  assert(/^[A-Za-z0-9+/]+$/.test(result.stdout.toString('ascii')));
});
