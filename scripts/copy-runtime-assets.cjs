#!/usr/bin/env node
/**
 * Copy runtime assets that sit next to their TS source into dist/.
 *
 * `tsc` only emits .js. Anything the running server reads via
 * path.join(__dirname, ...) — i.e. relative to the compiled file — has to be
 * copied explicitly, or production builds (`node dist/index.js`) lose it.
 * See docs/issues/2026-09-29-eval-center-schema-asset-missing.md.
 *
 * Invoked as part of `npm run build` (root package.json).
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

// src/<rel> → dist/<rel>
const ASSETS = ['eval-center/eval-schema.sql'];

for (const rel of ASSETS) {
  const from = path.join(ROOT, 'src', rel);
  const to = path.join(ROOT, 'dist', rel);
  if (!fs.existsSync(from)) {
    console.error(`❌ 运行时资产源码缺失：src/${rel}`);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}
console.log(`✅ 已复制 ${ASSETS.length} 个运行时资产到 dist/`);
