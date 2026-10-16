// pptx / xlsx / epub / xmind 四种 zip 容器格式的解析。
//
// fixture 全部是**真实工具产出的文件**（python-pptx、LibreOffice），不是手搓 XML ——
// 手搓的包只能证明解析器读懂了我自己想象的结构。重建方式见
// tests/fixtures/office/build-fixtures.sh。
//
// 断言的重点是**结构**而不是"有文字就算过"：表格的行列对应、幻灯片的页序、章节的
// 标题层级，任何一样丢了，分块一动刀（chunk 边界落在表头和数据之间）检索就散了。
// 所以每个用例都钉住结构本身。

import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import {
  parsePptx,
  parseXlsx,
  parseEpub,
  parseXmind,
  detectZipDocumentType,
  isHiddenZipPath,
  isLegacyOfficeBuffer,
  legacyOfficeMessage,
  ZipDocumentError,
} from '../../src/document-parser-zip.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'office');
const fixture = (name: string): Buffer => fs.readFileSync(path.join(FIXTURES, name));

describe('pptx', () => {
  test('按 sldIdLst 出页序，标题形状渲染成 #、正文原样', async () => {
    const out = await parsePptx(fixture('slides.pptx'), 'slides.pptx');
    expect(out).toContain('# CIBI3026A101 项目启动会');
    expect(out).toContain('代号：CHARLIE-9930');
    expect(out).toContain('# 入组标准');
    expect(out).toContain('# 给药方案');
    // 三页都要有页眉，且顺序与文件序一致。
    expect(out.match(/## 第 \d+ 页/g)).toEqual(['## 第 1 页', '## 第 2 页', '## 第 3 页']);
  });

  test('页序取自 presentation.xml.rels，不是文件名数字（缺陷点）', async () => {
    // 这个包把 sldIdLst 倒了过来、文件名保持不动。按文件名排会给出「项目启动会」
    // 在前 —— 那正好是**相反**的顺序，而这个错误在输出里完全看不出来
    // （每页文字都对，就是顺序错）。
    const out = await parsePptx(fixture('slides-reordered.pptx'), 'slides-reordered.pptx');
    const first = out.indexOf('## 第 1 页');
    const slide1 = out.slice(first, out.indexOf('## 第 2 页'));
    expect(slide1).toContain('# 给药方案');
    expect(slide1).not.toContain('项目启动会');
    expect(out.slice(out.indexOf('## 第 3 页'))).toContain('# CIBI3026A101 项目启动会');
  });

  test('不是 pptx 的 zip 报错说清楚缺什么', async () => {
    const zip = new JSZip();
    zip.file('hello.txt', 'x');
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    await expect(parsePptx(buf, 'fake.pptx')).rejects.toThrow(/ppt\/presentation\.xml/);
  });
});

describe('xlsx', () => {
  test('表头与数据行在同一个 Markdown 表格里（缺陷点）', async () => {
    const out = await parseXlsx(fixture('dosing.xlsx'), 'dosing.xlsx');
    expect(out).toContain('## dosing');
    // 关键：表头行和数据行必须在同一个表里。摊平成一行行文本的话，
    // 分块边界落在表头和数据之间，「受试药的剂量」就只剩一串没有列名的数字。
    expect(out).toContain('| 药物名称 | 剂量 | 给药途径 |');
    expect(out).toContain('| 受试药 CIBI3026A101 | 200mg | 静脉注射 |');
    expect(out).toContain('| 安慰剂 | 0mg | 静脉注射 |');
    const headerAt = out.indexOf('| 药物名称 |');
    const rowAt = out.indexOf('| 受试药 CIBI3026A101 |');
    expect(headerAt).toBeGreaterThan(-1);
    expect(rowAt).toBeGreaterThan(headerAt);
  });

  test('firstRowAsHeader=false 时不生成表头分隔行，首行就是数据', async () => {
    const buf = fixture('dosing.xlsx');
    const withHeader = await parseXlsx(buf, 'dosing.xlsx');
    const without = await parseXlsx(buf, 'dosing.xlsx', { firstRowAsHeader: false });
    expect(withHeader).toContain('| 药物名称 | 剂量 | 给药途径 |');
    expect(withHeader).toContain('| --- |');
    // 关掉表头后降级为「一行一条记录」，首行与其余行同权。
    expect(without).not.toContain('---');
    expect(without).toContain('药物名称 | 剂量 | 给药途径');
    expect(without.indexOf('药物名称')).toBeLessThan(without.indexOf('受试药 CIBI3026A101'));
  });
});

describe('epub', () => {
  test('按 spine 出章节序，保留标题层级', async () => {
    const out = await parseEpub(fixture('handbook.epub'), 'handbook.epub');
    // 章节边界必须进 Markdown —— `heading` 分块策略正是按 # 切的。
    expect(out).toContain('# 第一章 访视安排');
    expect(out).toContain('## 1.1 窗口期');
    expect(out).toContain('# 第二章 不良事件记录');
  });

  test('章节序来自 spine，不是 manifest 声明序或文件名（缺陷点）', async () => {
    // fixture 的 manifest 里 ch2 声明在 ch1 之前，spine 里 ch1 在前。
    // 按 manifest 或文件名排都会把第二章排到第一章前面。
    const out = await parseEpub(fixture('handbook.epub'), 'handbook.epub');
    expect(out.indexOf('第一章')).toBeLessThan(out.indexOf('第二章'));
  });

  test('没有标题元素的章节不能整章丢字', async () => {
    // 第三章只有 <ul>/<li>，一个标题都没有。fixture 的 LibreOffice 版本
    // 把 h1 全拍成了 <p>，这类「章内无标题」的 epub 是真实存在的。
    const out = await parseEpub(fixture('handbook.epub'), 'handbook.epub');
    expect(out).toContain('- 原始病历归档至研究中心');
    expect(out).toContain('- 电子数据保留 5 年');
  });

  test('缺 container.xml 的 zip 明确报错', async () => {
    const zip = new JSZip();
    zip.file('foo.txt', 'x');
    await expect(parseEpub(await zip.generateAsync({ type: 'nodebuffer' }))).rejects.toThrow(
      /META-INF\/container\.xml/,
    );
  });
});

describe('xmind', () => {
  test('层级渲染成标题层级，浮动主题不进正文', async () => {
    const out = await parseXmind(fixture('design.xmind'), 'design.xmind');
    expect(out).toContain('# CIBI3026A101 研究设计');
    expect(out).toContain('# 研究设计');
    expect(out).toContain('## 入组标准');
    expect(out).toContain('### 年龄 18-75 岁');
    expect(out).toContain('### ECOG 评分 0-1');
    expect(out).toContain('## 主要终点');
    // children.detached 是用户拖到画布空白处的浮动批注，不属于层级树。
    expect(out).not.toContain('浮动批注');
  });

  test('XMind 8 的 content.xml 也要认', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<xmap-content xmlns="urn:xmind:xmap:xmlns:content:2.0">
  <sheet id="s1"><title>旧版导图</title>
    <topic id="root"><title>中心主题</title>
      <children><topics type="attached">
        <topic id="a"><title>分支甲</title>
          <children><topics type="attached"><topic id="a1"><title>叶子甲</title></topic></topics></children>
        </topic>
      </topics></children>
    </topic>
  </sheet>
</xmap-content>`;
    const zip = new JSZip();
    zip.file('content.xml', xml);
    const out = await parseXmind(await zip.generateAsync({ type: 'nodebuffer' }), 'old.xmind');
    expect(out).toContain('# 旧版导图');
    expect(out).toContain('# 中心主题');
    expect(out).toContain('## 分支甲');
    expect(out).toContain('### 叶子甲');
    // 每个节点只能出现一次（递归写成全树遍历会重复渲染）。
    expect(out.match(/分支甲/g)?.length).toBe(1);
  });
});

describe('类型判定与安全闸', () => {
  test('四种格式的 magic 都是 PK，只能靠内部结构分辨', async () => {
    for (const [file, expected] of [
      ['slides.pptx', 'pptx'],
      ['dosing.xlsx', 'xlsx'],
      ['handbook.epub', 'epub'],
      ['design.xmind', 'xmind'],
    ] as const) {
      const buf = fixture(file);
      // 前提：magic 全是 zip，sniffParserFromBuffer 只会说是 docx。
      expect([...buf.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
      expect(await detectZipDocumentType(buf)).toBe(expected);
    }
  });

  test('普通 zip（不是这四种）判定为 null', async () => {
    const zip = new JSZip();
    zip.file('a/b.txt', 'x');
    expect(await detectZipDocumentType(await zip.generateAsync({ type: 'nodebuffer' }))).toBeNull();
  });

  test('路径穿越、条目数超限的 zip 一律拒绝', async () => {
    const evil = new JSZip();
    evil.file('../../etc/passwd', 'x');
    await expect(
      parsePptx(await evil.generateAsync({ type: 'nodebuffer' }), 'evil.pptx'),
    ).rejects.toThrow(/非法路径/);

    const many = new JSZip();
    for (let i = 0; i < 5_001; i++) many.file(`f${i}.txt`, 'x');
    await expect(
      parsePptx(await many.generateAsync({ type: 'nodebuffer' }), 'many.pptx'),
    ).rejects.toThrow(/条目过多/);
  });

  test('损坏的 zip 报「不是有效的压缩包」而不是崩栈', async () => {
    const buf = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64, 0x41)]);
    await expect(parsePptx(buf, 'broken.pptx')).rejects.toThrow(ZipDocumentError);
    await expect(parsePptx(buf, 'broken.pptx')).rejects.toThrow(/不是有效的压缩包/);
  });

  test('老版二进制 Office 给出可执行的提示', async () => {
    const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), Buffer.alloc(16)]);
    expect(isLegacyOfficeBuffer(ole)).toBe(true);
    expect(isLegacyOfficeBuffer(fixture('slides.pptx'))).toBe(false);
    // 提示里要出现"另存为"和正确的目标格式 —— 只说"不支持"用户不知道下一步做什么。
    expect(legacyOfficeMessage('report.doc')).toContain('另存为 .docx');
    expect(legacyOfficeMessage('book.xls')).toContain('另存为 .xlsx');
    expect(legacyOfficeMessage('deck.ppt')).toContain('另存为 .pptx');
  });
});

describe('隐藏项判定', () => {
  test('任一路径段以 . 开头即隐藏，__MACOSX/ 也算', () => {
    expect(isHiddenZipPath('.git/config')).toBe(true);
    expect(isHiddenZipPath('docs/.hidden/a.md')).toBe(true);
    expect(isHiddenZipPath('.DS_Store')).toBe(true);
    expect(isHiddenZipPath('__MACOSX/._a.md')).toBe(true);
    expect(isHiddenZipPath('__MACOSX')).toBe(true);
    // 文件名里带点但不是以点开头 —— 不是隐藏项。
    expect(isHiddenZipPath('docs/v1.2/guide.md')).toBe(false);
    expect(isHiddenZipPath('README.md')).toBe(false);
  });
});
