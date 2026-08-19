import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSshTerminalArgv,
  readTerminalCwdUrl,
  readTerminalHostId,
  shellQuote,
} from '@/modules/terminal/terminal-websocket.service.js';

test('shellQuote wraps in single quotes and escapes embedded quotes', () => {
  assert.equal(shellQuote('/home/u/my project'), `'/home/u/my project'`);
  assert.equal(shellQuote(`/has'quote`), `'/has'\\''quote'`);
});

test('readTerminalCwdUrl returns the cwd param or null', () => {
  assert.equal(readTerminalCwdUrl('/ws/terminal?cwd=%2Fhome%2Fu%2Fproj'), '/home/u/proj');
  assert.equal(readTerminalCwdUrl('/ws/terminal'), null);
});

test('readTerminalHostId returns the hostId param or null', () => {
  assert.equal(readTerminalHostId('/ws/terminal?hostId=h1'), 'h1');
  assert.equal(readTerminalHostId('/ws/terminal'), null);
});

test('buildSshTerminalArgv forces a tty, carries identity and lands in cwd', () => {
  const argv = buildSshTerminalArgv({
    identityFile: '/data/ssh/lovdex_ed25519',
    host: '10.0.0.5',
    port: 22,
    sshUser: 'root',
    cwd: '/home/root/app',
  });
  assert.deepEqual(argv, [
    '-t',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=15',
    '-o', 'BatchMode=yes',
    '-i', '/data/ssh/lovdex_ed25519',
    'root@10.0.0.5',
    `cd '/home/root/app' && exec $SHELL -l`,
  ]);
});

test('buildSshTerminalArgv adds -p for a non-default port and defaults cwd to ~', () => {
  const argv = buildSshTerminalArgv({ identityFile: null, host: 'h', port: 2222, sshUser: 'u', cwd: null });
  assert.equal(argv[0], '-t');
  assert.ok(argv.includes('-p') && argv.includes('2222'));
  assert.equal(argv[argv.length - 1], `cd '~' && exec $SHELL -l`);
  assert.ok(!argv.some((a) => a.startsWith('-i')));
});
