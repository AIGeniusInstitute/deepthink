import fs from 'fs';
import path from 'path';

export const PRUNED_HISTORY_IMAGE_MARKER =
  '[image data removed - already processed by model]';

const IMAGE_REFERENCE_PATTERN = /\[图片:[^\]]+\]/;
const HISTORY_ARCHIVE_PATTERN = /\[历史图片已归档 [^\]]+\]/;

type ImageDimensions = { width: number; height: number } | null;

interface TranscriptLine {
  index: number;
  parsed: Record<string, unknown> | null;
}

interface PruneResult {
  value: unknown;
  didMutate: boolean;
  prunedImages: number;
}

export interface TranscriptContentPruneResult {
  content: string;
  didMutate: boolean;
  prunedImages: number;
}

export interface SessionTranscriptPruneResult {
  didMutate: boolean;
  prunedImages: number;
  transcriptPath?: string;
}

export interface TranscriptPruneOptions {
  getImageDimensions?: (base64Data: string) => ImageDimensions;
}

function findLastAssistantIndex(lines: TranscriptLine[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].parsed?.type === 'assistant') {
      return i;
    }
  }
  return -1;
}

function collectTextFragments(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectTextFragments(item));
  }
  if (!value || typeof value !== 'object') {
    return [];
  }

  const record = value as Record<string, unknown>;
  const fragments: string[] = [];
  if (typeof record.text === 'string') {
    fragments.push(record.text);
  }
  if ('content' in record) {
    fragments.push(...collectTextFragments(record.content));
  }
  return fragments;
}

function findImageReference(...values: unknown[]): string | null {
  for (const value of values) {
    for (const text of collectTextFragments(value)) {
      const match = text.match(IMAGE_REFERENCE_PATTERN);
      if (match) {
        return match[0];
      }
    }
  }
  return null;
}

function hasHistoryArchiveMarker(value: unknown): boolean {
  return collectTextFragments(value).some((text) => HISTORY_ARCHIVE_PATTERN.test(text));
}

function formatHistoryArchiveMarker(timestamp: unknown): string | null {
  if (typeof timestamp === 'string') {
    const isoMatch = timestamp.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
    if (isoMatch) {
      return `[历史图片已归档 ${isoMatch[1]} ${isoMatch[2]}]`;
    }
  }

  const date = new Date(timestamp as string | number | Date);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const pad = (value: number) => value.toString().padStart(2, '0');
  return `[历史图片已归档 ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}]`;
}

function getImageMediaType(block: Record<string, unknown>): string | null {
  const source = block.source;
  if (!source || typeof source !== 'object') {
    return null;
  }
  const mediaType = (source as Record<string, unknown>).media_type;
  return typeof mediaType === 'string' ? mediaType : null;
}

function getImageBase64(block: Record<string, unknown>): string | null {
  const source = block.source;
  if (!source || typeof source !== 'object') {
    return null;
  }
  const data = (source as Record<string, unknown>).data;
  return typeof data === 'string' ? data : null;
}

function buildPlaceholderText(
  block: Record<string, unknown>,
  imageReference: string | null,
  getImageDimensions?: (base64Data: string) => ImageDimensions,
): string {
  if (imageReference) {
    return `${PRUNED_HISTORY_IMAGE_MARKER} ${imageReference}`;
  }

  const base64Data = getImageBase64(block);
  const mediaType = getImageMediaType(block);
  const dimensions = base64Data && getImageDimensions ? getImageDimensions(base64Data) : null;
  if (dimensions && mediaType) {
    return `${PRUNED_HISTORY_IMAGE_MARKER.slice(0, -1)} (原 ${dimensions.width}×${dimensions.height} ${mediaType})]`;
  }

  return PRUNED_HISTORY_IMAGE_MARKER;
}

function pruneImageBlocksInValue(
  value: unknown,
  imageReference: string | null,
  getImageDimensions?: (base64Data: string) => ImageDimensions,
): PruneResult {
  if (Array.isArray(value)) {
    let didMutate = false;
    let prunedImages = 0;
    const next = value.map((item) => {
      if (!item || typeof item !== 'object') {
        return item;
      }

      const block = item as Record<string, unknown>;
      if (block.type === 'image') {
        didMutate = true;
        prunedImages += 1;
        return {
          type: 'text',
          text: buildPlaceholderText(block, imageReference, getImageDimensions),
        };
      }

      if ('content' in block) {
        const nested = pruneImageBlocksInValue(
          block.content,
          imageReference,
          getImageDimensions,
        );
        if (nested.didMutate) {
          didMutate = true;
          prunedImages += nested.prunedImages;
          return {
            ...block,
            content: nested.value,
          };
        }
      }

      return item;
    });

    return {
      value: didMutate ? next : value,
      didMutate,
      prunedImages,
    };
  }

  if (value && typeof value === 'object' && 'content' in (value as Record<string, unknown>)) {
    const record = value as Record<string, unknown>;
    const nested = pruneImageBlocksInValue(record.content, imageReference, getImageDimensions);
    if (nested.didMutate) {
      return {
        value: { ...record, content: nested.value },
        didMutate: true,
        prunedImages: nested.prunedImages,
      };
    }
  }

  return {
    value,
    didMutate: false,
    prunedImages: 0,
  };
}

function appendHistoryArchiveMarker(
  messageContent: unknown,
  archiveMarker: string | null,
): { value: unknown; didMutate: boolean } {
  if (!archiveMarker) {
    return { value: messageContent, didMutate: false };
  }

  if (typeof messageContent === 'string') {
    return {
      value: messageContent
        ? `${messageContent}\n${archiveMarker}`
        : archiveMarker,
      didMutate: true,
    };
  }

  if (Array.isArray(messageContent)) {
    return {
      value: [...messageContent, { type: 'text', text: archiveMarker }],
      didMutate: true,
    };
  }

  return { value: messageContent, didMutate: false };
}

export function pruneProcessedHistoryImagesInTranscriptContent(
  content: string,
  options: TranscriptPruneOptions = {},
): TranscriptContentPruneResult {
  const lines = content.split('\n');
  const parsedLines: TranscriptLine[] = lines.map((line, index) => {
    if (!line.trim()) {
      return { index, parsed: null };
    }

    try {
      return {
        index,
        parsed: JSON.parse(line) as Record<string, unknown>,
      };
    } catch {
      return { index, parsed: null };
    }
  });

  const lastAssistantIndex = findLastAssistantIndex(parsedLines);
  if (lastAssistantIndex < 0) {
    return { content, didMutate: false, prunedImages: 0 };
  }

  let didMutate = false;
  let prunedImages = 0;

  for (let i = 0; i < lastAssistantIndex; i++) {
    const entry = parsedLines[i].parsed;
    if (!entry || entry.type !== 'user') {
      continue;
    }

    const message = entry.message;
    const messageRecord =
      message && typeof message === 'object'
        ? (message as Record<string, unknown>)
        : null;

    const imageReference = findImageReference(
      messageRecord?.content,
      entry.toolUseResult,
    );

    let entryChanged = false;
    let entryPrunedImages = 0;

    if (messageRecord && 'content' in messageRecord) {
      const prunedMessage = pruneImageBlocksInValue(
        messageRecord.content,
        imageReference,
        options.getImageDimensions,
      );
      if (prunedMessage.didMutate) {
        entry.message = {
          ...messageRecord,
          content: prunedMessage.value,
        };
        entryChanged = true;
        entryPrunedImages += prunedMessage.prunedImages;
      }
    }

    if ('toolUseResult' in entry) {
      const prunedToolResult = pruneImageBlocksInValue(
        entry.toolUseResult,
        imageReference,
        options.getImageDimensions,
      );
      if (prunedToolResult.didMutate) {
        entry.toolUseResult = prunedToolResult.value;
        entryChanged = true;
        entryPrunedImages += prunedToolResult.prunedImages;
      }
    }

    if (
      entryPrunedImages > 0 &&
      messageRecord &&
      'content' in messageRecord &&
      !imageReference &&
      !hasHistoryArchiveMarker(messageRecord.content)
    ) {
      const archiveMarker = formatHistoryArchiveMarker(entry.timestamp);
      const appended = appendHistoryArchiveMarker(
        (entry.message as Record<string, unknown>).content,
        archiveMarker,
      );
      if (appended.didMutate) {
        entry.message = {
          ...(entry.message as Record<string, unknown>),
          content: appended.value,
        };
        entryChanged = true;
      }
    }

    if (entryChanged) {
      didMutate = true;
      prunedImages += entryPrunedImages;
      lines[parsedLines[i].index] = JSON.stringify(entry);
    }
  }

  return {
    content: didMutate ? lines.join('\n') : content,
    didMutate,
    prunedImages,
  };
}

export function pruneProcessedHistoryImagesInTranscript(params: {
  claudeConfigDir: string;
  sessionId?: string;
  getImageDimensions?: (base64Data: string) => ImageDimensions;
}): SessionTranscriptPruneResult {
  if (!params.sessionId) {
    return { didMutate: false, prunedImages: 0 };
  }

  const projectsDir = path.join(params.claudeConfigDir, 'projects');
  if (!fs.existsSync(projectsDir)) {
    return { didMutate: false, prunedImages: 0 };
  }

  let transcriptPath: string | undefined;
  try {
    const projectEntries = fs.readdirSync(projectsDir, { withFileTypes: true });
    for (const projectEntry of projectEntries) {
      if (!projectEntry.isDirectory()) {
        continue;
      }

      const candidate = path.join(
        projectsDir,
        projectEntry.name,
        `${params.sessionId}.jsonl`,
      );
      if (fs.existsSync(candidate)) {
        transcriptPath = candidate;
        break;
      }
    }
  } catch {
    return { didMutate: false, prunedImages: 0 };
  }

  if (!transcriptPath) {
    return { didMutate: false, prunedImages: 0 };
  }

  try {
    const original = fs.readFileSync(transcriptPath, 'utf-8');
    const result = pruneProcessedHistoryImagesInTranscriptContent(original, {
      getImageDimensions: params.getImageDimensions,
    });
    if (!result.didMutate) {
      return { didMutate: false, prunedImages: 0, transcriptPath };
    }

    const originalSize = Buffer.byteLength(original, 'utf-8');
    const nextSize = Buffer.byteLength(result.content, 'utf-8');
    if (originalSize === nextSize) {
      return { didMutate: false, prunedImages: 0, transcriptPath };
    }

    const tempPath = `${transcriptPath}.tmp`;
    fs.writeFileSync(tempPath, result.content);
    fs.renameSync(tempPath, transcriptPath);

    return {
      didMutate: true,
      prunedImages: result.prunedImages,
      transcriptPath,
    };
  } catch {
    return { didMutate: false, prunedImages: 0, transcriptPath };
  }
}
