'use strict';
// fork 测试子进程：回传一条消息后退出。
if (process.send) {
  process.send({ hello: 'from-child', pid: process.pid });
}
process.exit(0);
