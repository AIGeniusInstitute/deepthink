#!/usr/bin/env bash
# 重建 tests/fixtures/office/ 下的四个二进制 fixture。
#
# 为什么 fixture 是**真的由 Office 工具产出**的文件，而不是手搓 XML：
# 手搓的包只能证明「解析器读懂了我自己想象的结构」。真实文件里有一堆想当然会漏掉的
# 东西 —— 命名空间前缀、rels 的相对路径、sharedStrings 的共享字符串表、LibreOffice
# 的 EPUB 3 nav 文档 —— 那些才是解析器真正要对付的。
#
# 依赖：python-pptx（pip）、LibreOffice（soffice）。两者都缺失时不重建，直接用仓库里
# 已提交的 fixture —— 它们是产物，不是生成过程，提交进仓库就是为了让测试不依赖本机装了什么。
#
# 用法：bash tests/fixtures/office/build-fixtures.sh
set -euo pipefail

cd "$(dirname "$0")"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ── slides.pptx：python-pptx ─────────────────────────────
# 3 页，其中第 2 页是「只有标题没有正文」—— 空正文的形状必须被跳过而不是渲染成空标题。
cat > "$WORK/mk_pptx.py" <<'PY'
from pptx import Presentation

prs = Presentation()
s1 = prs.slides.add_slide(prs.slide_layouts[0])
s1.shapes.title.text = "CIBI3026A101 项目启动会"
s1.placeholders[1].text = "PI：张伟\n代号：CHARLIE-9930\n日期：2026-01-06"

s2 = prs.slides.add_slide(prs.slide_layouts[5])
s2.shapes.title.text = "入组标准"

s3 = prs.slides.add_slide(prs.slide_layouts[1])
s3.shapes.title.text = "给药方案"
s3.placeholders[1].text = "试验组：受试药 200mg 每日一次\n对照组：安慰剂\n给药周期：28 天"

prs.save("slides.pptx")
PY
( cd "$WORK" && python3 mk_pptx.py )
mv "$WORK/slides.pptx" .
# 再由它派生一个「页序与文件名不一致」的包，用来钉住 sldIdLst 才是页序权威。
node build-pptx-reordered.mjs .

# ── dosing.xlsx：LibreOffice 由 CSV 转换 ────────────────
# 三列表头 + 两行数据。表头和它的数据行必须在同一个 Markdown 表格里，
# 「受试药的剂量」才检索得出来。
printf '药物名称,剂量,给药途径\n受试药 CIBI3026A101,200mg,静脉注射\n安慰剂,0mg,静脉注射\n' > "$WORK/dosing.csv"
"${SOFFICE:-soffice}" -env:UserInstallation=file://"$WORK/lo-profile" --headless \
  --convert-to xlsx --outdir "$WORK" "$WORK/dosing.csv" >/dev/null
mv "$WORK/dosing.xlsx" .

# ── handbook.epub：手写（LibreOffice 会把 h1 拍平成 p，测不了标题层级）──
node build-epub.mjs .
# 反向校验：让 LibreOffice 读一遍，读不出来说明这个包根本不合法。
if "${SOFFICE:-soffice}" -env:UserInstallation=file://"$WORK/lo-profile" --headless \
     --convert-to txt --outdir "$WORK" handbook.epub >/dev/null 2>&1; then
  echo "handbook.epub 通过 LibreOffice 反向读取校验"
else
  echo "警告：LibreOffice 无法读取 handbook.epub" >&2
fi

# ── design.xmind：手写 content.json ─────────────────────
# 这个格式没有现成的命令行工具，只能手写。好在 XMind Zen 的正文就是一份 JSON，
# 结构没有歧义（不像 OOXML 有 rels / sharedStrings 那些间接层）。
node build-xmind.mjs .

echo "fixtures rebuilt:"
ls -la ./*.pptx ./*.xlsx ./*.epub ./*.xmind
