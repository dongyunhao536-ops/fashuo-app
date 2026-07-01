# -*- coding: utf-8 -*-
# 从讲义 OCR 文本里【逐字】提取作者标注的心得框（提示/马工程/归纳/易混…），不调 API、纯本地解析。
#
# 用法：python scripts/extract-jiangyi-xinde.py <in.txt> <out.md>
#
# 机制：按「===== 第N页 =====」分页；行首（容忍 OCR 括号乱码 [ ［ 【 空格）命中标注词即开一个框，
# 一直吃到下一个 标注/编号/中文序号标题/页码/页眉/空行 为止；把被 OCR 断行的整段拼回，逐字输出（不简化），
# 每条带讲义页码锚点。供答疑①档 search_xinde 引用。
import sys, re

MARKERS = ["提示", "马工程", "归纳", "总结", "小结", "口诀", "记忆", "辨析", "注意",
           "重点", "易混", "易错", "对比", "技巧", "拓展", "补充", "区分"]
OPEN = r'[\[［【（(（\s]*'          # [ ［ 【 （ ( 及空白，容错 OCR
CLOSE = r'[\]］」》）)）：:：、]'  # ] ］ 」 》 ） ) ： :  、
mk = re.compile('^' + OPEN + '(' + '|'.join(MARKERS) + ')(' + CLOSE + r'|\s|$)')

num = re.compile(r'^\s*\d+\s*[.。、．]')            # 1.  2、  2．(全角句点)
cn = re.compile(r'^\s*[一二三四五六七八九十]+\s*、')       # 一、二、
cnb = re.compile(r'^\s*[（(]\s*[一二三四五六七八九十]+\s*[)）]')  # （一）
pagemk = re.compile(r'^\s*=====\s*第(\d+)页')
barenum = re.compile(r'^\s*\d{1,4}\s*$')
HEADER = "法律硕士考试精讲一本通"


def is_delim(line):
    return bool(
        mk.match(line) or num.match(line) or cn.match(line) or cnb.match(line)
        or pagemk.match(line) or barenum.match(line)
        or HEADER in line or line.strip() == ""
    )


def main():
    inp, out = sys.argv[1], sys.argv[2]
    lines = open(inp, encoding="utf-8").read().split("\n")
    n = len(lines)
    page = 0
    boxes = []
    i = 0
    while i < n:
        pm = pagemk.match(lines[i])
        if pm:
            page = int(pm.group(1))
            i += 1
            continue
        m = mk.match(lines[i])
        if m:
            marker = m.group(1)
            buf = [lines[i][m.end():].rstrip()]  # 去掉行首标注词本身，保内容
            i += 1
            while i < n and not is_delim(lines[i]):
                buf.append(lines[i].rstrip())
                i += 1
            text = "".join(buf).strip()
            if len(text) >= 6:  # 去掉 OCR 噪音空框
                boxes.append((page, marker, text))
        else:
            i += 1

    with open(out, "w", encoding="utf-8") as f:
        f.write("# 刑法讲义心得（《刑法精讲一本通》车润海 · 作者标注框逐字提取）\n\n")
        f.write("> 从讲义扫描 OCR 文本【机械提取、逐字未简化】作者亲手标注的 提示/马工程/归纳/易混/易错/辨析 等框——这些就是作者划的重点、易错、辨析。供答疑①档（心得）引用，每条带讲义页码锚点。\n")
        f.write("> 非人工复核、可能含个别 OCR 误字；与《考试分析》冲突时以考试分析为准。\n\n")
        f.write(f"> 共 {len(boxes)} 条。\n\n")
        for pg, mkr, text in boxes:
            f.write(f"- 【讲义P{pg}·{mkr}】{text}\n")
    print(f"extracted {len(boxes)} boxes -> {out}")


if __name__ == "__main__":
    main()
