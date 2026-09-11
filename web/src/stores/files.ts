import { create } from 'zustand';
import { api, apiFetch, computeUploadTimeoutMs } from '../api/client';

export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number;
  modifiedAt: string;
  isSystem: boolean;
  absolutePath?: string;
}

export interface UploadProgress {
  total: number;
  completed: number;
  currentFile: string;
  /** bytes for current batch */
  totalBytes: number;
  uploadedBytes: number;
}

interface FileState {
  files: Record<string, FileEntry[]>;
  currentPath: Record<string, string>;
  loading: boolean;
  uploading: boolean;
  uploadProgress: UploadProgress | null;
  error: string | null;

  loadFiles: (jid: string, path?: string) => Promise<void>;
  uploadFiles: (jid: string, files: File[], basePath?: string) => Promise<boolean>;
  deleteFile: (jid: string, filePath: string) => Promise<boolean>;
  createDirectory: (jid: string, parentPath: string, name: string) => Promise<void>;
  navigateTo: (jid: string, path: string) => void;
  getFileContent: (jid: string, filePath: string) => Promise<string | null>;
  saveFileContent: (jid: string, filePath: string, content: string) => Promise<boolean>;
  saveFileBinary: (jid: string, filePath: string, data: ArrayBuffer | Blob) => Promise<boolean>;
  saveHtmlAsDocx: (jid: string, filePath: string, html: string) => Promise<boolean>;
  // AgentNet Disk — 搜索/移动/重命名/回收站/版本
  searchFiles: (jid: string, q: string) => Promise<FileEntry[]>;
  moveFile: (jid: string, source: string, targetDir: string) => Promise<boolean>;
  renameFile: (jid: string, filePath: string, newName: string) => Promise<boolean>;
  listTrash: (jid: string) => Promise<TrashItem[]>;
  restoreTrash: (jid: string, id: string) => Promise<boolean>;
  purgeTrash: (jid: string, id: string) => Promise<boolean>;
  emptyTrash: (jid: string) => Promise<boolean>;
  listVersions: (jid: string, filePath: string) => Promise<VersionEntry[]>;
  getVersionContent: (jid: string, filePath: string, version: number) => Promise<{ content: string; isText: boolean } | null>;
  restoreVersion: (jid: string, filePath: string, version: number) => Promise<boolean>;
}

export interface TrashItem {
  id: string;
  trashId: string;
  originalPath: string;
  name: string;
  isFolder: boolean;
  sizeBytes: number;
  deletedBy: string;
  deletedAt: string;
}

export interface VersionEntry {
  id: string;
  versionNum: number;
  sizeBytes: number;
  mimeType: string | null;
  createdBy: string;
  createdAt: string;
  comment: string | null;
}

export function toBase64Url(str: string): string {
  const bytes = new TextEncoder().encode(str);
  const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join('');
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export const useFileStore = create<FileState>((set, get) => ({
  files: {},
  currentPath: {},
  loading: false,
  uploading: false,
  uploadProgress: null,
  error: null,

  loadFiles: async (jid: string, path?: string) => {
    set({ loading: true, error: null });
    try {
      const targetPath = path !== undefined ? path : (get().currentPath[jid] || '');
      const params = new URLSearchParams();
      if (targetPath) params.set('path', targetPath);

      const data = await api.get<{ files: FileEntry[]; currentPath: string }>(
        `/api/groups/${encodeURIComponent(jid)}/files?${params}`
      );

      set((s) => ({
        files: { ...s.files, [jid]: data.files },
        currentPath: { ...s.currentPath, [jid]: data.currentPath },
        loading: false,
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load files';
      console.error('Failed to load files:', err);
      set({ loading: false, error: msg });
    }
  },

  uploadFiles: async (jid: string, files: File[], basePath?: string) => {
    if (files.length === 0) return false;

    const total = files.length;
    const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
    set({
      uploading: true,
      uploadProgress: { total, completed: 0, currentFile: files[0].name, totalBytes, uploadedBytes: 0 },
    });

    const targetBase = basePath !== undefined ? basePath : (get().currentPath[jid] || '');
    const apiUrl = `/api/groups/${encodeURIComponent(jid)}/files`;
    let uploadedBytes = 0;

    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];

        // For folder uploads, webkitRelativePath = "folderName/sub/file.txt"
        // Extract directory portion to preserve structure
        const relativePath = file.webkitRelativePath;
        let uploadPath = targetBase;
        if (relativePath) {
          const lastSlash = relativePath.lastIndexOf('/');
          if (lastSlash > 0) {
            const dir = relativePath.substring(0, lastSlash);
            uploadPath = targetBase ? `${targetBase}/${dir}` : dir;
          }
        }

        set({
          uploadProgress: { total, completed: i, currentFile: file.name, totalBytes, uploadedBytes },
        });

        const formData = new FormData();
        formData.append('files', file);
        if (uploadPath) formData.append('path', uploadPath);

        await apiFetch(apiUrl, {
          method: 'POST',
          body: formData,
          headers: {},
          timeoutMs: computeUploadTimeoutMs(file.size),
        });

        uploadedBytes += file.size;

        set({
          uploadProgress: { total, completed: i + 1, currentFile: i + 1 < total ? files[i + 1].name : '', totalBytes, uploadedBytes },
        });
      }

      // Reload file list
      await get().loadFiles(jid, targetBase);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to upload files';
      console.error('Failed to upload files:', err);
      set({ error: msg });
      return false;
    } finally {
      set({ uploading: false, uploadProgress: null });
    }
  },

  deleteFile: async (jid: string, filePath: string) => {
    try {
      const encoded = toBase64Url(filePath);
      await api.delete(`/api/groups/${encodeURIComponent(jid)}/files/${encoded}`);

      const currentPath = get().currentPath[jid] || '';
      await get().loadFiles(jid, currentPath);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to delete file';
      console.error('Failed to delete file:', err);
      set({ error: msg });
      return false;
    }
  },

  createDirectory: async (jid: string, parentPath: string, name: string) => {
    try {
      await api.post(`/api/groups/${encodeURIComponent(jid)}/directories`, {
        path: parentPath,
        name,
      });

      await get().loadFiles(jid, parentPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to create directory';
      console.error('Failed to create directory:', err);
      set({ error: msg });
    }
  },

  navigateTo: (jid: string, path: string) => {
    set((s) => ({
      currentPath: { ...s.currentPath, [jid]: path },
      files: { ...s.files, [jid]: [] },
    }));
    get().loadFiles(jid, path);
  },

  getFileContent: async (jid: string, filePath: string) => {
    try {
      const encoded = toBase64Url(filePath);
      const data = await api.get<{ content: string }>(
        `/api/groups/${encodeURIComponent(jid)}/files/content/${encoded}`
      );
      return data.content;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to read file';
      console.error('Failed to read file content:', err);
      set({ error: msg });
      return null;
    }
  },

  saveFileContent: async (jid: string, filePath: string, content: string) => {
    try {
      const encoded = toBase64Url(filePath);
      await api.put(`/api/groups/${encodeURIComponent(jid)}/files/content/${encoded}`, { content });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save file';
      console.error('Failed to save file content:', err);
      set({ error: msg });
      return false;
    }
  },

  saveFileBinary: async (jid: string, filePath: string, data: ArrayBuffer | Blob) => {
    try {
      const encoded = toBase64Url(filePath);
      const body = data instanceof Blob ? await data.arrayBuffer() : data;
      await apiFetch(`/api/groups/${encodeURIComponent(jid)}/files/binary/${encoded}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body,
      });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save binary file';
      console.error('Failed to save binary file:', err);
      set({ error: msg });
      return false;
    }
  },

  saveHtmlAsDocx: async (jid: string, filePath: string, html: string) => {
    try {
      const encoded = toBase64Url(filePath);
      await apiFetch(`/api/groups/${encodeURIComponent(jid)}/files/html-docx/${encoded}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
        body: html,
      });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to convert HTML to docx';
      console.error('Failed to convert HTML to docx:', err);
      set({ error: msg });
      return false;
    }
  },

  // ─── AgentNet Disk 方法 ───
  searchFiles: async (jid: string, q: string) => {
    try {
      const data = await api.get<{ files: FileEntry[] }>(
        `/api/groups/${encodeURIComponent(jid)}/files/search?q=${encodeURIComponent(q)}`
      );
      return data.files;
    } catch (err) {
      console.error('Failed to search files:', err);
      return [];
    }
  },

  moveFile: async (jid: string, source: string, targetDir: string) => {
    try {
      await api.post(`/api/groups/${encodeURIComponent(jid)}/files/move`, { source, targetDir });
      await get().loadFiles(jid, get().currentPath[jid] || '');
      return true;
    } catch (err) {
      console.error('Failed to move file:', err);
      set({ error: err instanceof Error ? err.message : 'Failed to move file' });
      return false;
    }
  },

  renameFile: async (jid: string, filePath: string, newName: string) => {
    try {
      await api.post(`/api/groups/${encodeURIComponent(jid)}/files/rename`, { path: filePath, newName });
      await get().loadFiles(jid, get().currentPath[jid] || '');
      return true;
    } catch (err) {
      console.error('Failed to rename file:', err);
      set({ error: err instanceof Error ? err.message : 'Failed to rename file' });
      return false;
    }
  },

  listTrash: async (jid: string) => {
    try {
      const data = await api.get<{ items: TrashItem[] }>(`/api/groups/${encodeURIComponent(jid)}/files/trash`);
      return data.items;
    } catch (err) {
      console.error('Failed to list trash:', err);
      return [];
    }
  },

  restoreTrash: async (jid: string, id: string) => {
    try {
      await api.post(`/api/groups/${encodeURIComponent(jid)}/files/trash/${id}/restore`);
      return true;
    } catch (err) {
      console.error('Failed to restore trash:', err);
      return false;
    }
  },

  purgeTrash: async (jid: string, id: string) => {
    try {
      await api.delete(`/api/groups/${encodeURIComponent(jid)}/files/trash/${id}`);
      return true;
    } catch (err) {
      console.error('Failed to purge trash:', err);
      return false;
    }
  },

  emptyTrash: async (jid: string) => {
    try {
      await api.delete(`/api/groups/${encodeURIComponent(jid)}/files/trash`);
      return true;
    } catch (err) {
      console.error('Failed to empty trash:', err);
      return false;
    }
  },

  listVersions: async (jid: string, filePath: string) => {
    try {
      const encoded = toBase64Url(filePath);
      const data = await api.get<{ versions: VersionEntry[] }>(
        `/api/groups/${encodeURIComponent(jid)}/files/versions/${encoded}`
      );
      return data.versions;
    } catch (err) {
      console.error('Failed to list versions:', err);
      return [];
    }
  },

  getVersionContent: async (jid: string, filePath: string, version: number) => {
    try {
      const encoded = toBase64Url(filePath);
      const data = await api.get<{ content: string; isText: boolean }>(
        `/api/groups/${encodeURIComponent(jid)}/files/versions/${encoded}/${version}`
      );
      return { content: data.content, isText: data.isText };
    } catch (err) {
      console.error('Failed to get version content:', err);
      return null;
    }
  },

  restoreVersion: async (jid: string, filePath: string, version: number) => {
    try {
      const encoded = toBase64Url(filePath);
      await api.post(`/api/groups/${encodeURIComponent(jid)}/files/versions/${encoded}/${version}/restore`);
      return true;
    } catch (err) {
      console.error('Failed to restore version:', err);
      return false;
    }
  },
}));
