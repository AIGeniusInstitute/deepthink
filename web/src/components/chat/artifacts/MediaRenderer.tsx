/**
 * Media renderer for images, video, and audio. Uses native browser tags.
 * Videos get `controls` and preload="metadata" so Range requests kick in.
 */
import { useState } from 'react';
import type { ArtifactSource } from './types';

interface Props {
  source: ArtifactSource;
  previewUrl: string | null;
  kind: 'image' | 'video' | 'audio';
  onImageClick?: (src: string) => void;
}

export function MediaRenderer({ source, previewUrl, kind, onImageClick }: Props) {
  const [error, setError] = useState(false);

  if (!previewUrl) {
    return <div className="p-4 text-sm text-muted-foreground">媒体预览不可用</div>;
  }

  if (error) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        {source.fileName || 'media'} 加载失败
      </div>
    );
  }

  if (kind === 'image') {
    return (
      <div className="flex items-center justify-center bg-[repeating-conic-gradient(#f5f5f5_0%_25%,white_0%_50%)] bg-[length:16px_16px] p-3">
        <img
          src={previewUrl}
          alt={source.alt || source.fileName || 'image'}
          className="max-w-full max-h-[600px] object-contain cursor-zoom-in"
          style={{ background: 'white' }}
          onClick={() => onImageClick?.(previewUrl)}
          onError={() => setError(true)}
        />
      </div>
    );
  }

  if (kind === 'video') {
    return (
      <div className="p-3 bg-black">
        <video
          src={previewUrl}
          controls
          preload="metadata"
          className="w-full max-h-[600px]"
          onError={() => setError(true)}
        >
          您的浏览器不支持视频播放。
        </video>
      </div>
    );
  }

  // audio
  return (
    <div className="p-4 bg-muted/20">
      <audio src={previewUrl} controls preload="metadata" onError={() => setError(true)}>
        您的浏览器不支持音频播放。
      </audio>
    </div>
  );
}
