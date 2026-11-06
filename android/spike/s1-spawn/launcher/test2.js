'use strict';
// S1 spike T-A~T-C：node 启动器闭环实验（在启动器拉起的 node 里跑）。
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const nodebin = path.join(__dirname, 'nodebin');
process.env.PATH = nodebin + path.delimiter + (process.env.PATH || '');

const lines = [];
const log = (s) => {
  lines.push(s);
  console.log(s);
};

log('T-A launcher node version : ' + process.version);
log('T-A execPath              : ' + process.execPath);

const r = spawnSync('node', ['-e', 'console.log(42)'], { encoding: 'utf8' });
log(
  'T-B spawn(node)           : status=' +
    r.status +
    ' out=' +
    JSON.stringify((r.stdout || '').trim()) +
    ' err=' +
    JSON.stringify(((r.stderr || '').trim()).slice(0, 200)) +
    ' error=' +
    (r.error ? r.error.message : 'none')
);

const inner =
  "const{spawnSync}=require('child_process');" +
  "const x=spawnSync('node',['-e','console.log(777)'],{encoding:'utf8'});" +
  "console.log('inner:',x.status,(x.stdout||'').trim())";
const r2 = spawnSync('node', ['-e', inner], { encoding: 'utf8' });
log(
  'T-C nested spawn          : status=' +
    r2.status +
    ' out=' +
    JSON.stringify((r2.stdout || '').trim()) +
    ' err=' +
    JSON.stringify(((r2.stderr || '').trim()).slice(0, 200))
);

fs.writeFileSync(path.join(__dirname, 'launcher-test-result.txt'), lines.join('\n'));
process.exit(0);
