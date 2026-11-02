/**
 * 回归测试：Agent 对话产物渲染 404 {"error":"File not found"}。
 *
 * 根因：react-markdown/remark 管线（micromark normalizeUri）会把链接目的地里的
 * 非 ASCII 字符做百分号编码，前端把编码后的 href 当成工作区相对路径拼进
 * /files/preview URL，后端按字面 "%E6…" 文件名找文件 → 404。
 * 修复：markdown URI → filePath 边界解码一次（decodeMarkdownPath）。
 *
 * 下面的 encoded fixture 是 remark-parse@11 对链接目的地的实际输出，
 * 采集命令见 docs/issues/2026-11-02-chat-artifact-preview-file-not-found.md §5。
 */
import { describe, expect, it } from 'vitest';
import { decodeMarkdownPath } from '../web/src/components/chat/artifacts/types';

describe('decodeMarkdownPath（产物渲染 File not found 回归）', () => {
  it('解码 remark 对中文文件名的百分号编码', () => {
    const remarkHref =
      'docs/research/%E6%B8%B8%E6%88%8F%E7%A9%BA%E9%97%B4%E4%B8%8E%E5%87%BA%E8%A1%8C%E7%A9%BA%E9%97%B4%E6%B7%B1%E5%BA%A6%E8%B0%83%E7%A0%94-report.html';
    expect(decodeMarkdownPath(remarkHref)).toBe(
      'docs/research/游戏空间与出行空间深度调研-report.html',
    );
  });

  it('解码 Agent 预先百分号编码的路径（remark 对已编码序列不再二次编码）', () => {
    expect(decodeMarkdownPath('docs/research/%E6%B8%B8%E6%88%8F%E7%A9%BA%E9%97%B4-space-report.html')).toBe(
      'docs/research/游戏空间-space-report.html',
    );
  });

  it('还原文件名里的字面 %（remark 把裸 % 编码为 %25）', () => {
    expect(decodeMarkdownPath('docs/100%25-report.html')).toBe('docs/100%-report.html');
  });

  it('非法 %XX 序列原样返回、不抛错', () => {
    expect(decodeMarkdownPath('docs/100%-report.html')).toBe('docs/100%-report.html');
    expect(decodeMarkdownPath('docs/100%2-report.html')).toBe('docs/100%2-report.html');
  });

  it('纯 ASCII 路径原样返回', () => {
    expect(decodeMarkdownPath('docs/research/report.html')).toBe('docs/research/report.html');
    expect(decodeMarkdownPath('images/pic.png')).toBe('images/pic.png');
  });
});
