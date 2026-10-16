// 生成 design.xmind（由 build-fixtures.sh 调用，从仓库树内运行 —— jszip 要能解析到）。
//
// XMind Zen / 2020+ 的正文是包内的 `content.json`：一个 sheet 数组，每个 sheet 有
// `rootTopic`，子主题在 `children.attached` 里。`children.detached` 是**浮动主题**
// （用户拖到画布空白处的批注），它不属于层级树 —— 这个 fixture 特意塞了一个，
// 用来钉住「浮动主题不能被渲染进正文」。
import JSZip from 'jszip';
import fs from 'node:fs';
import path from 'node:path';

const outDir = process.argv[2] ?? '.';

const content = [
  {
    id: 'sheet-1',
    class: 'sheet',
    title: 'CIBI3026A101 研究设计',
    rootTopic: {
      id: 'root',
      title: '研究设计',
      structureClass: 'org.xmind.ui.logic.right',
      children: {
        attached: [
          {
            id: 't1',
            title: '入组标准',
            children: {
              attached: [
                { id: 't1a', title: '年龄 18-75 岁' },
                { id: 't1b', title: 'ECOG 评分 0-1' },
              ],
            },
          },
          {
            id: 't2',
            title: '主要终点',
            children: { attached: [{ id: 't2a', title: '客观缓解率 ORR' }] },
          },
          {
            id: 't3',
            title: '样本量',
            children: { attached: [{ id: 't3a', title: '计划入组 120 例' }] },
          },
        ],
        detached: [{ id: 'x1', title: '这是浮动批注，不属于层级' }],
      },
    },
  },
];

const zip = new JSZip();
zip.file('content.json', JSON.stringify(content));
zip.file('metadata.json', JSON.stringify({ creator: { name: 'XMind', version: '12.0.2' } }));
zip.file(
  'manifest.json',
  JSON.stringify({ 'file-entries': { 'content.json': {}, 'metadata.json': {} } }),
);

const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
fs.writeFileSync(path.join(outDir, 'design.xmind'), buf);
console.log('design.xmind ok');
