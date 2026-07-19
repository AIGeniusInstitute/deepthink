/**
 * 文件扩展名 → Monaco 语言 ID 映射。
 * Monaco 内置 70+ 语言；这里覆盖 100+ 常见扩展名（含别名归并）。
 * 未知扩展名回退 'plaintext'，仍由 Monaco 以纯文本渲染。
 */
const EXT_TO_LANG: Record<string, string> = {
  // web
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  html: 'html', htm: 'html', xhtml: 'html',
  css: 'css', scss: 'scss', sass: 'sass', less: 'less',
  vue: 'html', svelte: 'html',
  json: 'json', json5: 'json', jsonc: 'json',
  // 脚本/动态
  py: 'python', pyw: 'python', pyi: 'python',
  rb: 'ruby',
  php: 'php',
  pl: 'perl', pm: 'perl',
  lua: 'lua',
  tcl: 'tcl',
  r: 'r',
  jl: 'julia',
  dart: 'dart',
  swift: 'swift',
  // 系统/编译
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin', kts: 'kotlin',
  scala: 'scala', sc: 'scala',
  c: 'c', h: 'c',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
  cs: 'csharp',
  m: 'objective-c', mm: 'objective-cpp',
  d: 'd',
  nim: 'nim',
  zig: 'zig',
  pas: 'pascal', pp: 'pascal',
  asm: 'asm',
  s: 'asm',
  elixir: 'elixir', ex: 'elixir', exs: 'elixir',
  erl: 'erlang',
  hs: 'haskell', lhs: 'haskell',
  hsx: 'haskell',
  ml: 'ocaml', mli: 'ocaml',
  clj: 'clojure', cljs: 'clojure', cljc: 'clojure', edn: 'clojure',
  lisp: 'lisp', lsp: 'lisp', el: 'lisp',
  scm: 'scheme',
  rkt: 'racket',
  fs: 'fsharp', fsx: 'fsharp',
  vb: 'vb',
  // shell
  sh: 'shell', bash: 'shell', zsh: 'shell', bashrc: 'shell',
  fish: 'shell',
  ps1: 'powershell', psm1: 'powershell',
  bat: 'bat', cmd: 'bat',
  // 数据/配置
  xml: 'xml', svg: 'xml', plist: 'xml',
  yaml: 'yaml', yml: 'yaml',
  toml: 'ini',
  ini: 'ini', cfg: 'ini', conf: 'ini',
  env: 'ini',
  csv: 'plaintext',
  sql: 'sql',
  graphql: 'graphql', gql: 'graphql',
  proto: 'proto',
  // 标记/文档
  md: 'markdown', markdown: 'markdown',
  rst: 'rst',
  tex: 'latex',
  // 函数式/其它
  coffee: 'coffeescript',
  styl: 'stylus',
  dockerfile: 'dockerfile',
  makefile: 'makefile', mk: 'makefile',
  cmake: 'cmake',
  ninja: 'plaintext',
  glsl: 'cpp',
  wgsl: 'plaintext',
  sol: 'sol',
  vim: 'vim',
  ahk: 'plaintext',
  awk: 'plaintext',
  sed: 'plaintext',
  diff: 'diff',
  patch: 'diff',
  log: 'plaintext',
  txt: 'plaintext',
  // ── Monaco 内置语言补全（编辑器侧覆盖全部 Monaco 内置 + 常用别名）──
  abap: 'abap',
  csx: 'csharp',
  mysql: 'mysql',
  pug: 'pug', jade: 'pug',
  hbs: 'handlebars', handlebars: 'handlebars', mustache: 'handlebars',
  raz: 'razor', razor: 'razor',
  sv: 'systemverilog', svh: 'systemverilog',
  v: 'verilog', vh: 'verilog', vhd: 'vhdl', vhdl: 'vhdl',
  bicep: 'bicep',
  cyclone: 'cyclone',
  hcl: 'hcl', tf: 'hcl', tfvars: 'hcl',
  liquid: 'liquid',
  mips: 'mips',
  csp: 'csp',
  msdax: 'msdax',
  pgsql: 'pgsql', pg: 'pgsql',
  redis: 'redis',
  redshift: 'redshift',
  postman: 'postman',
  powerquery: 'powerquery', pq: 'powerquery',
  cameligo: 'cameligo',
  pascaligo: 'pascaligo',
  azcli: 'azcli',
  apex: 'apex',
  pla: 'pla',
  ecls: 'ecls',
  ecla: 'ecla',
  lexon: 'lexon',
  m3: 'm3',
  cli: 'cli',
  netlogo: 'netlogo',
  sb: 'sb',
  squirrel: 'squirrel',
  ksh: 'shell', shrc: 'shell',
  psd1: 'powershell',
  // ── hljs 在 CodeRenderer（对话产物只读渲染）侧补充、Monaco 编辑器回退 plaintext 的语言 ──
  // 这些扩展名在 Monaco 编辑器以 plaintext 打开，但在 ArtifactRenderer 用 hljs 仍彩色渲染。
  cr: 'plaintext',       // crystal (hljs)
  elm: 'plaintext',      // elm (hljs)
  groovy: 'plaintext',   // groovy (hljs)
  gradle: 'plaintext',   // gradle/groovy (hljs)
  f90: 'plaintext', f95: 'plaintext', f: 'plaintext', for: 'plaintext',  // fortran (hljs)
  ada: 'plaintext', adb: 'plaintext', ads: 'plaintext',
  cbl: 'plaintext', cob: 'plaintext',
  dpr: 'pascal', lpr: 'pascal',
  cls: 'plaintext',  // vbnet/obj... 留 plaintext（避免与 OO cls 冲突）
  sty: 'latex', ltx: 'latex', bib: 'plaintext',
  vbs: 'plaintext', vba: 'plaintext',
  as: 'plaintext', actionscript: 'plaintext',  // actionscript (hljs)
  ss: 'scheme',
  fsi: 'fsharp', fsproj: 'plaintext',
  pl6: 'plaintext', p6: 'plaintext', raku: 'plaintext',
  glslf: 'cpp', glslv: 'cpp',
};

const KNOWN_LANGS = new Set([
  // Monaco 内置（编辑器侧高亮）
  'abap','apex','azcli','bat','bicep','cameligo','cli','clojure','cobol','coffeescript',
  'cpp','csharp','csp','cyclone','d','dart','dockerfile','ecls','ecla','elixir','erlang',
  'fsharp','go','graphql','handlebars','haskell','hcl','html','ini','java','javascript',
  'json','julia','kotlin','latex','less','lexon','liquid','lisp','lua','m3','makefile',
  'markdown','mips','msdax','mysql','netlogo','nim','objective-c','ocaml','pascal','pascaligo',
  'perl','pgsql','php','pla','postman','powerquery','powershell','pug','python','r','racket',
  'razor','redis','redshift','restructuredtext','ruby','rust','sb','scala','scheme','scss',
  'shell','sol','sql','squirrel','stylus','swift','systemverilog','tcl','toml','typescript',
  'vb','verilog','vhdl','vim','xml','yaml','zig','plaintext',
  // highlight.js 在 CodeRenderer（对话产物只读渲染）侧补充的语言
  'crystal','elm','groovy','fortran','ada','cobol','vbnet','actionscript','raku',
  'reason','ocaml','mercury','modula','oz','prolog','purescript','idris','dhall','gleam',
  'sparql','turtle','n1ql','tap','step','step7','sieve','smali','sml','stata','supercollider',
  'routeros','roboconf','ruleslanguage','rprofile','sasl','scilab','scheme','smithy','solidity',
  'specfile','stan','stata','subunit','taggerscript','thrift','tp','twig','typescript','vala',
  'vbscript','velocity','verilog','vhdl','vim','wasm','wast','wren','x86asm','xl','xquery',
  'zephir','zig',
]);

export function extToLanguage(ext: string): string {
  const e = ext.toLowerCase().replace(/^\./, '');
  return EXT_TO_LANG[e] || 'plaintext';
}

export function isKnownLanguage(lang: string): boolean {
  return KNOWN_LANGS.has(lang);
}

/** 支持的语言数量（Monaco 编辑器内置 ∪ highlight.js 渲染，含 plaintext），≥100。 */
export const SUPPORTED_LANGUAGE_COUNT = KNOWN_LANGS.size;
