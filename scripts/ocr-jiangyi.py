# -*- coding: utf-8 -*-
# 扫描版 PDF → 纯文本（本地 RapidOCR / onnxruntime，免费离线，不调任何云）。
#
# 用法：
#   python scripts/ocr-jiangyi.py <input.pdf> <output.txt> [start_page] [end_page]
#   - 不给页码：从 output.txt 已写到的最后一页之后续跑（断点续跑），跑到全书末页。
#   - 给 start/end：只跑该区间（验证用）。
#
# 机制：逐页 pdftoppm 渲染成 PNG(200DPI) → RapidOCR 识别 → 追加写出（每页带「===== 第N页 =====」
# 锚点便于答疑引用页码）→ 删临时 PNG。中途中断可重跑自动续。纯本地 CPU，无网络、无 API 费。
import sys, os, re, glob, tempfile, subprocess
from rapidocr_onnxruntime import RapidOCR


def total_pages(pdf):
    out = subprocess.run(["pdfinfo", pdf], capture_output=True, text=True,
                         encoding="utf-8", errors="ignore").stdout
    m = re.search(r"Pages:\s+(\d+)", out)
    return int(m.group(1)) if m else 0


def resume_from(out_path):
    """从已有 output 里找最后一个「第N页」锚点，下一页续跑。"""
    if not os.path.exists(out_path):
        return 1
    last = 0
    with open(out_path, encoding="utf-8") as f:
        for line in f:
            m = re.match(r"=====\s*第(\d+)页", line)
            if m:
                last = int(m.group(1))
    return last + 1


def render(pdf, p, prefix, dpi=200):
    subprocess.run(["pdftoppm", "-png", "-r", str(dpi), "-f", str(p), "-l", str(p), pdf, prefix],
                   check=True, capture_output=True)
    files = glob.glob(prefix + "*.png")
    return files[0] if files else None


def page_text(engine, png):
    res, _ = engine(png)
    if not res:
        return ""
    # 按顶部 y（分行桶）再按 x 排序，恢复自上而下、从左到右的阅读顺序
    items = sorted(res, key=lambda r: (round(min(pt[1] for pt in r[0]) / 8),
                                       min(pt[0] for pt in r[0])))
    return "\n".join(it[1] for it in items)


def main():
    pdf, out = sys.argv[1], sys.argv[2]
    total = total_pages(pdf)
    start = int(sys.argv[3]) if len(sys.argv) > 3 else resume_from(out)
    end = int(sys.argv[4]) if len(sys.argv) > 4 else total
    print(f"[ocr] total={total} pages, run {start}..{end}", flush=True)
    engine = RapidOCR()
    tmpdir = tempfile.mkdtemp(prefix="ocrjy_")
    for p in range(start, end + 1):
        prefix = os.path.join(tmpdir, f"pg{p}_")
        png = render(pdf, p, prefix)
        text = page_text(engine, png) if png else ""
        if png and os.path.exists(png):
            os.remove(png)
        with open(out, "a", encoding="utf-8") as f:
            f.write(f"\n\n===== 第{p}页 =====\n{text}")
        print(f"[ocr] page {p}/{end}  {len(text)} chars", flush=True)
    print("[ocr] done", flush=True)


if __name__ == "__main__":
    main()
