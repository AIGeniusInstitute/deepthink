'use strict';
// S1 spike 实验：libnode 运行时内的 child_process 行为。
// 结果写入同目录 spike-s1-result.txt（同时走 stdout→logcat）。
const { spawn, fork } = require('child_process');
const fs = require('fs');
const path = require('path');

const lines = [];
const log = (s) => {
  lines.push(s);
  console.log('[spike] ' + s);
};
const resultFile = path.join(__dirname, 'spike-s1-result.txt');
const flush = () => {
  try {
    fs.writeFileSync(resultFile, lines.join('\n'));
  } catch (e) {
    console.error('[spike] write result failed: ' + e.message);
  }
};

function trySpawn(cmd, args, opts) {
  return new Promise((resolve) => {
    let out = '';
    let errOut = '';
    try {
      const p = spawn(cmd, args, opts || {});
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (errOut += d));
      p.on('error', (e) => {
        flush();
        resolve('SPAWN-ERROR: ' + e.message);
      });
      p.on('close', (code) => {
        flush();
        resolve(
          `close=${code} stdout=${JSON.stringify(out.trim().slice(0, 120))} stderr=${JSON.stringify(
            errOut.trim().slice(0, 160)
          )}`
        );
      });
      setTimeout(() => {
        try { p.kill(); } catch (e) {}
        flush();
        resolve('TIMEOUT(5s) stdout=' + JSON.stringify(out.trim().slice(0, 120)));
      }, 5000);
    } catch (e) {
      flush();
      resolve('THROW: ' + e.message);
    }
  });
}

(async () => {
  log('T0 node version : ' + process.version);
  log('T0 execPath     : ' + process.execPath);
  log('T0 argv0        : ' + process.argv0);
  log('T0 platform/arch: ' + process.platform + '/' + process.arch);
  log('T0 __dirname    : ' + __dirname);
  try {
    fs.accessSync(process.execPath, fs.constants.X_OK);
    log('T0 execPath X_OK: yes');
  } catch (e) {
    log('T0 execPath X_OK: no (' + e.message + ')');
  }
  flush();

  log('T1 spawn(node)     : ' + (await trySpawn('node', ['-e', 'console.log(42)'])));
  log('T2 spawn(execPath) : ' + (await trySpawn(process.execPath, ['-e', 'console.log(43)'])));
  log('T3 spawn(sh)       : ' + (await trySpawn('/system/bin/sh', ['-c', 'echo hi-from-sh'])));
  flush();

  // T4: fork（nodejs-mobile 场景走 spawn(process.execPath) 的封装）
  await new Promise((resolve) => {
    try {
      const child = fork(path.join(__dirname, 'child.js'));
      let msgs = '';
      child.on('message', (m) => (msgs += JSON.stringify(m)));
      child.on('error', (e) => {
        log('T4 fork            : CHILD-ERROR ' + e.message);
        flush();
        resolve();
      });
      child.on('exit', (c) => {
        log('T4 fork            : exit=' + c + ' msg=' + msgs);
        flush();
        resolve();
      });
      setTimeout(() => {
        log('T4 fork            : TIMEOUT(5s)');
        try { child.kill(); } catch (e) {}
        flush();
        resolve();
      }, 5000);
    } catch (e) {
      log('T4 fork            : THROW ' + e.message);
      flush();
      resolve();
    }
  });

  // T5: 有 node 启动器 ELF 时的 spawn（方案 A，由宿主注入 DT_LAUNCHER）
  const launcher = process.env.DT_LAUNCHER || '';
  if (launcher) {
    log('T5 spawn(launcher) : ' + (await trySpawn(launcher, ['-e', 'console.log(44)'])));
  } else {
    log('T5 spawn(launcher) : skipped (DT_LAUNCHER not set)');
  }

  flush();
  log('DONE');
  flush();
  process.exit(0);
})().catch((e) => {
  log('FATAL: ' + (e && e.stack ? e.stack : e));
  flush();
  process.exit(1);
});
