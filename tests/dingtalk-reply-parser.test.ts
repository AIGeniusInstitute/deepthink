import { describe, expect, test } from 'vitest';

import { extractRepliedMsg } from '../src/dingtalk-reply-parser.js';

describe('extractRepliedMsg', () => {
  test('returns null when repliedMsg is undefined', () => {
    expect(extractRepliedMsg(undefined)).toBeNull();
  });

  test('returns null when msgType missing', () => {
    expect(
      extractRepliedMsg({ msgType: '' } as unknown as Parameters<
        typeof extractRepliedMsg
      >[0]),
    ).toBeNull();
  });

  test('parses file reply with downloadCode', () => {
    const out = extractRepliedMsg({
      msgType: 'file',
      msgId: 'msg-file-1',
      content: {
        spaceId: '28534345282',
        fileName: '招标文件.docx',
        downloadCode: 'CODE_ABC',
        fileId: '218754500233',
      },
    });

    expect(out).toEqual({
      kind: 'file',
      fileName: '招标文件.docx',
      downloadCode: 'CODE_ABC',
      originalMsgId: 'msg-file-1',
    });
  });

  test('file reply with missing fileName falls back to "file"', () => {
    const out = extractRepliedMsg({
      msgType: 'file',
      content: { downloadCode: 'X' },
    });

    expect(out?.kind).toBe('file');
    expect(out?.fileName).toBe('file');
    expect(out?.downloadCode).toBe('X');
  });

  test('file reply without content returns kind=file with default name', () => {
    const out = extractRepliedMsg({ msgType: 'file' });
    expect(out).toEqual({ kind: 'file', fileName: 'file' });
  });

  test('picture reply exposes both downloadCode and pictureDownloadCode', () => {
    const out = extractRepliedMsg({
      msgType: 'picture',
      content: { downloadCode: 'D1', pictureDownloadCode: 'P1' },
    });

    expect(out).toMatchObject({
      kind: 'picture',
      downloadCode: 'D1',
      pictureDownloadCode: 'P1',
    });
  });

  test('picture reply with only pictureDownloadCode', () => {
    const out = extractRepliedMsg({
      msgType: 'picture',
      content: { pictureDownloadCode: 'P-ONLY' },
    });

    expect(out?.kind).toBe('picture');
    expect(out?.downloadCode).toBeUndefined();
    expect(out?.pictureDownloadCode).toBe('P-ONLY');
  });

  test('text reply with string content', () => {
    const out = extractRepliedMsg({
      msgType: 'text',
      content: 'hello world',
    });

    expect(out?.kind).toBe('text');
    expect(out?.textContent).toBe('hello world');
  });

  test('text reply with object content.text variant', () => {
    const out = extractRepliedMsg({
      msgType: 'text',
      content: { text: 'nested text' },
    });

    expect(out?.kind).toBe('text');
    expect(out?.textContent).toBe('nested text');
  });

  test('text reply truncates very long content to 500 chars', () => {
    const long = 'x'.repeat(2000);
    const out = extractRepliedMsg({ msgType: 'text', content: long });
    expect(out?.textContent?.length).toBe(500);
  });

  test('unknown msgType falls back to "other" with JSON summary', () => {
    const out = extractRepliedMsg({
      msgType: 'video',
      content: { videoId: 'abc', duration: 30 } as unknown as string,
    });
    expect(out?.kind).toBe('other');
    expect(out?.textContent).toContain('videoId');
  });

  test('prefers explicit originalMsgId over repliedMsg.msgId', () => {
    const out = extractRepliedMsg(
      {
        msgType: 'file',
        msgId: 'inner-id',
        content: { downloadCode: 'X', fileName: 'a.pdf' },
      },
      'outer-id',
    );
    expect(out?.originalMsgId).toBe('outer-id');
  });

  test('falls back to repliedMsg.msgId when originalMsgId not provided', () => {
    const out = extractRepliedMsg({
      msgType: 'file',
      msgId: 'only-inner',
      content: { downloadCode: 'X', fileName: 'a.pdf' },
    });
    expect(out?.originalMsgId).toBe('only-inner');
  });

  test('parses the real captured payload from production', () => {
    // Captured from DingTalk group message on 2026-04-28 (scrubbed for commit).
    const repliedMsg = {
      createdAt: 1776830767131,
      senderId: '$:LWCP_v1:$Wz21GEcy7GJ3ijaZZyl/vA==',
      msgType: 'file',
      msgId: 'msgV295fS0uw5ODbrswQAQeoQ==',
      content: {
        spaceId: '28534345282',
        fileName: '招标文件.docx',
        downloadCode:
          '2CJdsvm0AOiFdRhaVqtG6AaGMo2mZjCp6Y0P+1BARqGvNWUKM/BbhYqRb0',
        fileId: '218754500233',
      },
    };

    const out = extractRepliedMsg(repliedMsg, 'msgV295fS0uw5ODbrswQAQeoQ==');

    expect(out).toEqual({
      kind: 'file',
      fileName: '招标文件.docx',
      downloadCode:
        '2CJdsvm0AOiFdRhaVqtG6AaGMo2mZjCp6Y0P+1BARqGvNWUKM/BbhYqRb0',
      originalMsgId: 'msgV295fS0uw5ODbrswQAQeoQ==',
    });
  });
});
