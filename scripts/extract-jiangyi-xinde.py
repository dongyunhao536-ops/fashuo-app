# -*- coding: utf-8 -*-
# 从讲义 OCR 文本里【逐字】提取作者标注的心得框（提示/马工程/归纳/易混…），不调 API、纯本地解析。
#
# 用法：python scripts/extract-jiangyi-xinde.py <in.txt> <out.md> [科目]
#   科目 ∈ SUBJECTS（默认 刑法）。决定输出标题/书名署名与科目专属标注词。
# [gpt] 宪法：末尾加 --manifest config/jiangyi/xianfa-2027-boxes.json；全文变更后须重新审核边界。
#
# 机制：按「===== 第N页 =====」分页；行首（容忍 OCR 括号乱码 [ ［ 【 空格）命中标注词即开一个框，
# 一直吃到下一个 标注/编号/中文序号标题/页码/页眉/空行 为止；把被 OCR 断行的整段拼回，逐字输出（不简化），
# 每条带讲义页码锚点。供答疑①档 search_xinde 引用。
import sys, re, json, hashlib

MARKERS = ["提示", "马工程", "归纳", "总结", "小结", "口诀", "记忆", "辨析", "注意",
           "重点", "易混", "易错", "对比", "技巧", "拓展", "补充", "区分"]

# 同系列《法律硕士考试精讲一本通》各科卷；extra_markers = 该卷特有的标注框词（普查 OCR 全文后定）。
SUBJECTS = {
    # [gpt] 2026-08-28：宪法有跨页框、嵌套提示和漏识别标题，必须用绑定全文指纹的边界清单。
    "宪法": {"book": "《宪法学精讲一本通》马峰（2027年）",
             "extra_markers": ["老马识途", "重点提示", "备注"],
             "requires_manifest": True},
    "刑法": {"book": "《刑法精讲一本通》车润海", "extra_markers": []},
    "民法": {"book": "《民法学精讲一本通》岳业鹏",
             # 全书普查实锤的作者框（示例/分析是随文案例串讲，不进①档；"例外"是图表行标签非框）
             "extra_markers": ["规范拓展", "理论拓展", "背景拓展", "背诵口诀"]},
    "法理": {"book": "《法理学精讲一本通》老杜",
             # 老杜三件套天生对齐带背五步：推导逻辑→①逻辑链、形象理解→④挂例、一招制敌→应用锁扣；
             # 法律格言=格言+出处+考点指向(论述弹药)；"知识索引"是导图框、OCR拍平成碎片且骨架走考试分析，不收
             "extra_markers": ["推导逻辑", "形象理解", "一招制敌", "法律格言"]},
    "法制史": {"book": "《法制史精讲一本通》龚成思",
               # "点晴"=OCR 对"点睛"的常见误读，两变体都收（297晴/135睛）；典文释义=古文引文+意即=白话译文
               # （成对出现、常带编号"典文释义4"）；记忆线索=口诀+法理学交叉指针（正中法综融合命题趋势）
               "extra_markers": ["老龚点睛", "老龚点晴", "总结对比", "典文释义", "记忆线索", "意即"]},
}
OPEN = r'[\[［【（(（\s]*'          # [ ［ 【 （ ( 及空白，容错 OCR
CLOSE = r'[\]］」》）)）：:：、]'  # ] ］ 」 》 ） ) ： :  、
mk = None  # main() 里按科目拼（基础词表 + 科目专属词），长词在前防被短词截断

num = re.compile(r'^\s*\d+\s*[.。、．]')            # 1.  2、  2．(全角句点)
cn = re.compile(r'^\s*[一二三四五六七八九十]+\s*、')       # 一、二、
cnb = re.compile(r'^\s*[（(]\s*[一二三四五六七八九十]+\s*[)）]')  # （一）
pagemk = re.compile(r'^\s*=====\s*第(\d+)页')
barenum = re.compile(r'^\s*\d{1,4}\s*$')
HEADER = "法律硕士考试精讲一本通"


# [gpt] 2026-08-28：精确提取已审核的行段；不改变其他四科的历史解析行为。
def extract_manifest_boxes(source, manifest, subject):
    if manifest.get("subject") != subject:
        raise ValueError("边界清单科目不匹配")
    if hashlib.sha256(source).hexdigest() != manifest.get("sourceSha256"):
        raise ValueError("全文 SHA-256 与边界清单不匹配，禁止沿用旧行号")
    lines = source.decode("utf-8").splitlines()
    pages, page = [], 0
    for line in lines:
        match = pagemk.match(line)
        if match:
            page = int(match.group(1))
        pages.append(page)
    boxes, seen = [], set()
    allowed = set(MARKERS + SUBJECTS[subject]["extra_markers"])
    for entry in manifest.get("boxes", []):
        identity, marker = entry["id"], entry["marker"]
        if identity in seen or marker not in allowed:
            raise ValueError("重复条目 ID 或未知标注词")
        seen.add(identity)
        anchor = entry["anchorLine"]
        if not 1 <= anchor <= len(lines) or lines[anchor - 1] != entry["anchorText"]:
            raise ValueError(f"{identity} 标题锚点失配")
        selected, last = [], 0
        for segment in entry["segments"]:
            start, end = segment["startLine"], segment["endLine"]
            if not 1 <= start <= end <= len(lines) or start <= last:
                raise ValueError(f"{identity} 行段越界、重叠或逆序")
            for number in range(start, end + 1):
                if pages[number - 1] == 0 or pagemk.match(lines[number - 1]):
                    raise ValueError(f"{identity} 行段包含分页标记或无页码内容")
                selected.append(number)
            last = end
        if not selected or selected[0] < anchor:
            raise ValueError(f"{identity} 内容为空或先于标题")
        fragments = [lines[number - 1] for number in selected]
        # 行内【注意】保正文，独立标题不进入 segments；只移除这一处作者标签。
        if selected[0] == anchor and not entry.get("markerOcrMissing"):
            fragments[0] = re.sub(r"^[\[［【]" + re.escape(marker) + r"[\]］】〕]", "", fragments[0])
        used_pages = sorted({pages[anchor - 1], *(pages[n - 1] for n in selected)})
        if used_pages != entry.get("pdfPages"):
            raise ValueError(f"{identity} 页码与行段不一致")
        first_page, last_page = used_pages[0], used_pages[-1]
        printed = entry.get("bookPages")
        page_ref = str(first_page) if first_page == last_page else f"{first_page}–{last_page}"
        book_ref = "未知" if not printed else "–".join(map(str, dict.fromkeys(printed)))
        ref = f"〔PDF第{page_ref}页；书页{book_ref}；全文第{selected[0]}–{selected[-1]}行〕"
        body = "".join(fragments).strip()
        if len(body) < 6:
            raise ValueError(f"{identity} 内容过短")
        boxes.append((first_page, marker, ref + body))
    if not boxes:
        raise ValueError("边界清单没有条目")
    return boxes


def is_delim(line):
    return bool(
        mk.match(line) or num.match(line) or cn.match(line) or cnb.match(line)
        or pagemk.match(line) or barenum.match(line)
        or HEADER in line or line.strip() == ""
    )


def main():
    global mk
    inp, out = sys.argv[1], sys.argv[2]
    subject = sys.argv[3] if len(sys.argv) > 3 else "刑法"
    if subject not in SUBJECTS:
        sys.exit(f"未知科目 {subject}，可选：{'/'.join(SUBJECTS)}")
    manifest_boxes = None
    if len(sys.argv) > 4:
        if len(sys.argv) != 6 or sys.argv[4] != "--manifest":
            sys.exit("可选参数：--manifest <已审核边界清单.json>")
        with open(inp, "rb") as f:
            source = f.read()
        with open(sys.argv[5], encoding="utf-8") as f:
            manifest_boxes = extract_manifest_boxes(source, json.load(f), subject)
    elif SUBJECTS[subject].get("requires_manifest"):
        sys.exit("宪法必须提供 --manifest；通用编号截断会漏掉跨页框与框内清单")
    book = SUBJECTS[subject]["book"]
    markers = sorted(MARKERS + SUBJECTS[subject]["extra_markers"], key=len, reverse=True)
    # \d{0,2}：容纳"典文释义4"式带编号的框（法制史 124 处）；编号不进 group(1) 标签
    mk = re.compile('^' + OPEN + '(' + '|'.join(markers) + r')\s*\d{0,2}\s*(' + CLOSE + r'|\s|$)')
    lines = open(inp, encoding="utf-8").read().split("\n")
    n = len(lines)
    page = 0
    boxes = []
    i = 0
    while manifest_boxes is None and i < n:
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
            # 冒号清单续吃（2026-07-19 修）：框文以"："结尾且被编号行截断＝正文清单是框的本体
            # （老杜"判断标准是：1.…2.…3.…"式，刑12/民2/法理9条受害）。只按编号顺序 1→2→3 续吃，
            # 撞号/断号即停（框清单与后续正文节编号常直接相连甚至撞号），页码/页眉/下个框/中文序号/上限硬停。
            expected = 1  # 下一个该出现的清单编号；>1 表示已进入清单模式
            while i < n and expected <= 12:
                in_list = expected > 1
                if not in_list and not "".join(buf).rstrip().endswith("："):
                    break  # 框文不是冒号收尾 → 不续吃
                ln = lines[i]
                if pagemk.match(ln) or mk.match(ln) or cn.match(ln) or cnb.match(ln) \
                   or barenum.match(ln) or HEADER in ln or ln.strip() == "":
                    break  # 硬停：页码/下个框/中文序号标题/页眉/空行
                if num.match(ln):
                    got = int(re.match(r'\s*(\d+)', ln).group(1))
                    if got != expected:
                        break  # 断号/撞号 = 已流入正文编号节
                    expected += 1
                elif not in_list:
                    break  # 冒号后接的不是编号清单（表格等）→ 维持原截断
                buf.append(ln.rstrip())
                i += 1
            text = "".join(buf).strip()
            if len(text) >= 6:  # 去掉 OCR 噪音空框
                boxes.append((page, marker, text))
        else:
            i += 1

    if manifest_boxes is not None:
        boxes = manifest_boxes
    with open(out, "w", encoding="utf-8") as f:
        f.write(f"# {subject}讲义心得（{book} · 作者标注框逐字提取）\n\n")
        if manifest_boxes is not None:
            f.write("> [gpt] 按绑定全文 SHA-256 的边界清单逐字提取；栏目边界已核对，未逐字校对全文。PDF页与书页分开标明。\n")
            f.write("> 老马识途、注意、重点提示、补充、备注供检索定位；含嵌套提示，不代表互不重叠的知识点。可能有 OCR 误字，表格/导图关系须回看 PDF；与《考试分析》冲突时以考试分析为准。\n\n")
        else:
            f.write("> 从讲义扫描 OCR 文本【机械提取、逐字未简化】作者亲手标注的 提示/马工程/归纳/易混/易错/辨析 等框——这些就是作者划的重点、易错、辨析。供答疑①档（心得）引用，每条带讲义页码锚点。\n")
            f.write("> 非人工复核、可能含个别 OCR 误字；与《考试分析》冲突时以考试分析为准。\n\n")
        f.write(f"> 共 {len(boxes)} 条。\n\n")
        for pg, mkr, text in boxes:
            f.write(f"- 【讲义P{pg}·{mkr}】{text}\n")
    print(f"extracted {len(boxes)} boxes -> {out}")


if __name__ == "__main__":
    main()
