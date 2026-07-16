import { useEffect, useState, useCallback } from 'react';
import { sandboxApi, type SandboxFileEntry } from '../../api/sandbox';

interface SandboxFileTreeProps {
  sessionId: string;
}

interface TreeNode {
  name: string;
  path: string;
  type: 'file' | 'dir' | 'link';
  size: number;
  mtime: string;
  children?: TreeNode[];
  loaded?: boolean;
}

export function SandboxFileTree({ sessionId }: SandboxFileTreeProps) {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['/workspace']));
  const [error, setError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<{ content: string; truncated: boolean; size: number } | null>(null);
  const [fileLoading, setFileLoading] = useState(false);

  const loadPath = useCallback(async (path: string): Promise<TreeNode[]> => {
    const r = await sandboxApi.listFiles(sessionId, path);
    return r.entries.map((e: SandboxFileEntry) => ({
      name: e.name,
      path: path === '/' ? `/${e.name}` : `${path}/${e.name}`,
      type: e.type,
      size: e.size,
      mtime: e.mtime,
      loaded: e.type !== 'dir' ? true : false,
    }));
  }, [sessionId]);

  const mergeNodes = (nodes: TreeNode[], path: string, children: TreeNode[]): TreeNode[] => {
    return nodes.map((n) => {
      if (n.path === path && n.type === 'dir') {
        return { ...n, children, loaded: true };
      }
      if (n.children) {
        return { ...n, children: mergeNodes(n.children, path, children) };
      }
      return n;
    });
  };

  const refreshPath = useCallback(async (path: string) => {
    try {
      const children = await loadPath(path);
      setTree((prev) => mergeNodes(prev, path, children));
    } catch (e: any) {
      setError(e?.message ?? '加载失败');
    }
  }, [loadPath]);

  // Initial load
  useEffect(() => {
    refreshPath('/workspace');
  }, [refreshPath]);

  // Poll expanded nodes every 5s
  useEffect(() => {
    const timer = setInterval(() => {
      expanded.forEach((p) => refreshPath(p));
    }, 5000);
    return () => clearInterval(timer);
  }, [expanded, refreshPath]);

  const toggleDir = async (node: TreeNode) => {
    const next = new Set(expanded);
    if (next.has(node.path)) {
      next.delete(node.path);
    } else {
      next.add(node.path);
      if (!node.loaded) {
        await refreshPath(node.path);
      }
    }
    setExpanded(next);
  };

  const handleFileClick = async (node: TreeNode) => {
    if (node.type !== 'file') return;
    setSelectedFile(node.path);
    setFileLoading(true);
    setFileContent(null);
    try {
      const r = await sandboxApi.readFile(sessionId, node.path);
      setFileContent(r);
    } catch (e: any) {
      setFileContent({ content: `读取失败: ${e?.message ?? e}`, truncated: false, size: 0 });
    } finally {
      setFileLoading(false);
    }
  };

  const renderNode = (node: TreeNode, depth: number): React.ReactNode => {
    const indent = { paddingLeft: `${depth * 12 + 8}px` };
    if (node.type === 'dir') {
      const isOpen = expanded.has(node.path);
      return (
        <div key={node.path}>
          <button
            onClick={() => toggleDir(node)}
            className="w-full text-left px-2 py-0.5 hover:bg-white/5 flex items-center gap-1 text-xs"
            style={indent}
          >
            <span className="text-neutral-500 text-[10px] w-3">
              {isOpen ? '▼' : '▶'}
            </span>
            <span className="text-yellow-400/80">📁</span>
            <span className="text-neutral-200 truncate">{node.name}</span>
          </button>
          {isOpen && node.children && (
            <div>
              {node.children.map((c) => renderNode(c, depth + 1))}
            </div>
          )}
        </div>
      );
    }
    return (
      <div
        key={node.path}
        onClick={() => handleFileClick(node)}
        className={`px-2 py-0.5 hover:bg-white/5 flex items-center gap-1 text-xs cursor-pointer ${
          selectedFile === node.path ? 'bg-white/10' : ''
        }`}
        style={indent}
      >
        <span className="w-3" />
        <span className="text-blue-400/80">📄</span>
        <span className="text-neutral-300 truncate">{node.name}</span>
        <span className="text-neutral-600 ml-auto text-[10px]">
          {formatSize(node.size)}
        </span>
      </div>
    );
  };

  return (
    <div className="h-full flex flex-col bg-[#0f0f14]">
      <div className="px-3 py-1.5 bg-[#1a1b26] border-b border-[#2a2b36] text-xs text-neutral-400">
        /workspace
      </div>
      <div className="flex-1 overflow-auto">
        {error ? (
          <div className="p-3 text-xs text-red-400">{error}</div>
        ) : tree.length === 0 ? (
          <div className="p-3 text-xs text-neutral-500">空目录</div>
        ) : (
          tree.map((n) => renderNode(n, 0))
        )}
      </div>
      {selectedFile && (
        <div className="border-t border-[#2a2b36] h-1/3 flex flex-col">
          <div className="flex items-center justify-between px-3 py-1 bg-[#1a1b26] text-xs">
            <span className="text-neutral-400 truncate">{selectedFile}</span>
            <button
              onClick={() => setSelectedFile(null)}
              className="text-neutral-500 hover:text-neutral-300"
            >
              ✕
            </button>
          </div>
          <div className="flex-1 overflow-auto p-2">
            {fileLoading ? (
              <div className="text-xs text-neutral-500">加载中...</div>
            ) : fileContent ? (
              <pre className="text-xs text-neutral-200 font-mono whitespace-pre-wrap break-all">
                {fileContent.content}
                {fileContent.truncated && (
                  <span className="text-yellow-400">
                    {'\n\n'}... 文件过大，仅显示前 100KB（共 {fileContent.size} 字节）
                  </span>
                )}
              </pre>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / 1024 / 1024).toFixed(1)}M`;
}
