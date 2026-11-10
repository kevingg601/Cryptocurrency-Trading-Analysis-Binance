import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AIDataSnapshot } from '@fadachi/core';
import { AntigravityProvider, isolatedCLIEnvironment, parseAvailableModels } from '../src/ai/antigravityProvider.ts';

async function fixture(t: test.TestContext, options: { mode?: string; tools?: boolean; signedIn?: boolean; hang?: boolean } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fadachi-cli-test-'));
  const home = path.join(root, 'profile');
  const prompts: unknown[] = [];
  const children: Array<EventEmitter & { killed: boolean }> = [];
  t.after(async () => {
    assert.ok(root.startsWith(path.join(os.tmpdir(), 'fadachi-cli-test-')));
    await fs.rm(root, { recursive: true, force: true });
  });
  const provider = new AntigravityProvider({ profileHome: home, timeoutMs: options.hang ? 20 : 1000,
    spawnCLI(_command, args, spawnOptions) {
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
        exitCode: null as number | null, killed: false,
        kill() { child.killed = true; queueMicrotask(() => child.emit('close', null)); return true; },
      });
      children.push(child);
      assert.equal(spawnOptions.shell, false);
      assert.equal(spawnOptions.windowsHide, true);
      assert.equal(spawnOptions.env?.USERPROFILE, home);
      assert.equal(spawnOptions.env?.GEMINI_API_KEY, undefined);
      assert.equal(spawnOptions.env?.FADACHI_TOKEN, undefined);
      if (args.includes('models')) {
        queueMicrotask(async () => {
          const log = args[args.indexOf('--log-file') + 1];
          await fs.writeFile(log, `CLI app data directory: ${path.join(home, '.gemini', 'antigravity-cli')}\n`
            + 'CLI settings initialized: permissions=deny, toolPermission=strict\nloaded 0 named hooks from 0 hooks.json file(s)\n');
          if (options.signedIn === false) {
            child.stderr.write('Error: Please sign in to view available models.'); child.exitCode = 1;
          } else {
            child.stdout.write('Fetching available models...\ngemini-fixture-high\tFixture model\n'); child.exitCode = 0;
          }
          child.emit('close', child.exitCode);
        });
      } else {
        child.stdin.on('data', bytes => {
          prompts.push(JSON.parse(bytes.toString()));
          if (options.hang) return;
          if (options.tools) child.stdout.write(JSON.stringify({ event: 'step_update', step_update: { step_type: 'tool', tool_name: 'run_command' } }) + '\n');
          else child.stdout.write(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', structured_output: { analyses: [
            { symbol: 'BTCUSDT', marketType: 'futures', direction: 'NEUTRAL', confidence: 50, reasoning: 'fixture', bullishEvidence: [], bearishEvidence: [], risks: [] },
          ] } } }) + '\n');
        });
        queueMicrotask(() => child.stdout.write(JSON.stringify({ event: 'init', init: {
          permission_mode: options.mode ?? 'strict', cwd: spawnOptions.cwd,
        } }) + '\n'));
      }
      return child as unknown as ChildProcessWithoutNullStreams;
    },
  });
  return { provider, home, prompts, children };
}

const snapshot = { symbol: 'BTCUSDT', marketType: 'futures', id: 'snapshot-offline' } as AIDataSnapshot;

test('CLI model list comes from IDs and its child environment excludes application secrets', () => {
  assert.deepEqual(parseAvailableModels('Fetching available models...\ngemini-fixture-high\tLabel\nclaude-fixture\tLabel\nError: nope'), ['gemini-fixture-high', 'claude-fixture']);
  const env = isolatedCLIEnvironment('D:\\isolated');
  assert.equal(env.USERPROFILE, 'D:\\isolated');
  assert.equal(env.HOME, 'D:\\isolated');
  assert.equal(env.GEMINI_API_KEY, undefined);
  assert.equal(env.FADACHI_TOKEN, undefined);
});

test('CLI waits for a strict isolated init before sending one batch on stdin', async t => {
  const f = await fixture(t);
  assert.equal((await f.provider.verifyIsolation()).verified, true);
  assert.deepEqual(await f.provider.getModels(), ['gemini-fixture-high']);
  const result = await f.provider.analyzeBatch([snapshot], 'gemini-fixture-high', new AbortController().signal);
  assert.equal((result as { analyses: unknown[] }).analyses.length, 1);
  assert.equal(f.prompts.length, 1);
  assert.equal((f.prompts[0] as { event: string }).event, 'user');
  assert.match((f.prompts[0] as { message: { content: string } }).message.content, /snapshot-offline/);
  assert.equal(f.children.at(-1)?.killed, true);
});

test('CLI without an isolated sign-in has no invented model list and cannot trade', async t => {
  const f = await fixture(t, { signedIn: false });
  const status = await f.provider.verifyIsolation();
  assert.equal(status.verified, false);
  assert.match(status.reason!, /登入/);
  assert.deepEqual(await f.provider.getModels(), []);
  await assert.rejects(f.provider.analyzeBatch([snapshot], 'gemini-fixture-high', new AbortController().signal), /登入/);
  assert.equal(f.prompts.length, 0);
});

test('CLI non-strict runtime is rejected before the public snapshot is sent', async t => {
  const f = await fixture(t, { mode: 'always-proceed' });
  await assert.rejects(f.provider.analyzeBatch([snapshot], 'gemini-fixture-high', new AbortController().signal), /policy rejected/);
  assert.equal(f.prompts.length, 0);
});

test('CLI tool attempts invalidate analysis even when it would otherwise return success', async t => {
  const f = await fixture(t, { tools: true });
  await assert.rejects(f.provider.analyzeBatch([snapshot], 'gemini-fixture-high', new AbortController().signal), /policy rejected/);
  assert.equal(f.children.at(-1)?.killed, true);
});

test('CLI configuration tampering is detected even after a successful preflight', async t => {
  const f = await fixture(t);
  assert.equal((await f.provider.verifyIsolation()).verified, true);
  const settings = path.join(f.home, '.gemini', 'antigravity-cli', 'settings.json');
  await fs.writeFile(settings, JSON.stringify({ toolPermission: 'always-proceed' }));
  assert.equal((await f.provider.verifyIsolation()).verified, false);
  assert.deepEqual(await f.provider.getModels(), []);
  assert.equal(f.prompts.length, 0);
});

test('CLI abort and timeout terminate its child rather than leaving a live analysis', async t => {
  const f = await fixture(t, { hang: true });
  const controller = new AbortController();
  await assert.rejects(f.provider.analyzeBatch([snapshot], 'gemini-fixture-high', controller.signal), /timed out/);
  assert.equal(f.children.at(-1)?.killed, true);
  const second = new AbortController(); second.abort();
  await assert.rejects(f.provider.analyzeBatch([snapshot], 'gemini-fixture-high', second.signal), /aborted/);
});
