/**
 * 把「拖进上传区的东西」摊平成一份文件清单。
 *
 * 为什么不能直接读 `dataTransfer.files`：这是**实测过的坑**，不是理论担忧。
 * Chrome/Edge 拖文件夹时，那个列表里放的是 size 为 0、连扩展名都没有的**假条目**；
 * Firefox 拖文件夹时它**完全是空的**。所以必须先走 `webkitGetAsEntry()` 递归，
 * 只有该 API 不可用时才回退。
 *
 * 返回的每个 File 都带 `webkitRelativePath`（形如 `docs/guide/intro.md`），
 * 后端拿它当 filename —— 不保留路径的话，200 个 `index.md` 在列表里糊成一片。
 */

/** 任一路径段以 `.` 开头即隐藏。与后端 `isHiddenZipPath` 同一条规则。 */
export function isHiddenSegment(segment: string): boolean {
  return segment.startsWith('.');
}

/**
 * 整条相对路径是否该跳过。`__MACOSX/` 是 macOS 打包时塞进来的资源分支目录，
 * 名字不以 `.` 开头但同样不是用户的文件。
 */
export function isHiddenPath(relativePath: string): boolean {
  if (relativePath === '__MACOSX' || relativePath.startsWith('__MACOSX/')) return true;
  return relativePath.split('/').some(isHiddenSegment);
}

/**
 * 覆写 `webkitRelativePath`。
 *
 * 递归 `webkitGetAsEntry()` 拿到的 `File` 是 `FileSystemFileEntry.file()` 给的，
 * 它的 `webkitRelativePath` 是**空串** —— 路径信息只在 entry 那边。直接改属性
 * 会抛（只读 getter），所以用 `Object.defineProperty` 重定义。
 */
function setRelativePath(file: File, relativePath: string): File {
  try {
    Object.defineProperty(file, 'webkitRelativePath', {
      value: relativePath,
      configurable: true,
    });
  } catch {
    // 改不动就算了：文件名还在，只是丢了目录信息，不该因此整批失败。
  }
  return file;
}

/** 递归收集一个 entry 下的所有文件。 */
async function traverseEntry(entry: any, prefix: string): Promise<File[]> {
  if (!entry) return [];

  if (entry.isFile) {
    const file: File | null = await new Promise((resolve) => {
      entry.file(
        (f: File) => resolve(f),
        () => resolve(null),
      );
    });
    if (!file) return [];
    const relativePath = prefix ? `${prefix}/${file.name}` : file.name;
    if (isHiddenPath(relativePath)) return [];
    return [setRelativePath(file, relativePath)];
  }

  if (entry.isDirectory) {
    const dirPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    // 隐藏目录整棵剪掉 —— 进去再逐条判是白跑一遍 `.git/`。
    if (isHiddenSegment(entry.name)) return [];
    const reader = entry.createReader();
    const files: File[] = [];
    // readEntries 单次最多返回 100 条，必须循环读到空数组为止。
    // 只读一次是这类实现最常见的 bug：目录里超过 100 个文件就会被悄悄截断。
    for (;;) {
      const batch: any[] = await new Promise((resolve) => {
        reader.readEntries(
          (entries: any[]) => resolve(entries),
          () => resolve([]),
        );
      });
      if (batch.length === 0) break;
      for (const child of batch) {
        files.push(...(await traverseEntry(child, dirPath)));
      }
    }
    return files;
  }

  return [];
}

/** 回退路径：`dataTransfer.files` 里有什么就用什么。 */
function collectFromFileList(list: FileList | null): File[] {
  if (!list) return [];
  const out: File[] = [];
  for (let i = 0; i < list.length; i++) {
    const file = list[i];
    // 拖文件夹时 Chrome 会塞 size 为 0 的假条目 —— 它没有内容，收下只会让后端报错。
    if (file.size === 0 && !file.type) continue;
    const relativePath = file.webkitRelativePath || file.name;
    if (isHiddenPath(relativePath)) continue;
    out.push(file);
  }
  return out;
}

/**
 * 入口：从一次 drop 事件里摊平出文件清单。
 *
 * 顺序是「先 entry API，再回退」而不是反过来 —— 反过来就等于永远只用回退路径，
 * 而那正是拖目录不工作的原因。
 */
export async function collectDroppedFiles(dataTransfer: DataTransfer | null): Promise<File[]> {
  if (!dataTransfer) return [];

  const items = dataTransfer.items;
  if (items && items.length > 0) {
    const entries: any[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind !== 'file') continue;
      const entry = typeof (item as any).webkitGetAsEntry === 'function'
        ? (item as any).webkitGetAsEntry()
        : null;
      if (entry) entries.push(entry);
    }
    if (entries.length > 0) {
      const files: File[] = [];
      for (const entry of entries) files.push(...(await traverseEntry(entry, '')));
      if (files.length > 0) return files;
    }
  }

  return collectFromFileList(dataTransfer.files);
}

/** 从 `<input webkitdirectory>` 读出的清单。隐藏项照样过滤。 */
export function collectFromInput(files: FileList | null): File[] {
  if (!files) return [];
  const out: File[] = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const relativePath = file.webkitRelativePath || file.name;
    if (isHiddenPath(relativePath)) continue;
    out.push(file);
  }
  return out;
}

/**
 * 受控并发地跑一批任务。
 *
 * 为什么要有上界：解析是 CPU 密集的（xlsx/pptx 要在服务端解 zip），并发太高只会
 * 互相抢 CPU，把一批 200 个文件拖成一样慢；而扫描件走的是后台 OCR，不占这个池子。
 * 结果**按输入顺序**返回，界面上的清单才不会乱跳。
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}
