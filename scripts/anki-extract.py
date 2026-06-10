# 抽取 Anki 牌组 → 【保留背诵优先级标注】(00说明的颜色体系) → JSON
# 用法：python scripts/anki-extract.py <collection.anki21> <输出json>
# 关键：不剥光 HTML，而是按颜色/底色/加粗/下划线把每段文字打上优先级标签。
# 颜色映射(见卡牌00说明)：
#   底色(0,128,128)=没主观  (210,76,76)=出主观题  (217,217,217)=主观题题目+口诀
#   底色(194,226,255)浅蓝=P1必背高精  蓝字无底=P2必背略低  黑加粗=P3选背  黑普通=P4浏览
#   下划线=客观题点(紫=极重要)  绿字(87,141,49)=口诀
import sqlite3, json, re, html, sys, io
import urllib.parse
from html.parser import HTMLParser
from collections import Counter

DB = sys.argv[1] if len(sys.argv) > 1 else "/tmp/anki/collection.anki21"
OUT = sys.argv[2] if len(sys.argv) > 2 else "D:/fashuo/考点库/anki_extracted.json"

def parse_rgb(s):
    m = re.search(r"rgb\((\d+),\s*(\d+),\s*(\d+)\)", s or "")
    return (int(m[1]), int(m[2]), int(m[3])) if m else None

def near(c, t, tol=22):
    return c is not None and all(abs(c[i] - t[i]) <= tol for i in range(3))

def is_blue_text(c):
    return c is not None and c[2] > c[0] + 25 and c[2] > 90 and c[1] < c[2]

def is_purple(c):
    return c is not None and c[0] > 80 and c[2] > 110 and c[1] < c[0] - 20 and c[1] < c[2] - 20

def classify(color, bg, bold, ul):
    if near(bg, (0, 128, 128)): return "没主观标记"
    if near(bg, (210, 76, 76)): return "出主观标记"
    if near(bg, (217, 217, 217)): return "题目口诀行"
    if near(bg, (194, 226, 255)): return "P1必背高精"
    if near(color, (87, 141, 49)): return "口诀"
    if ul:
        return "极重要客观点" if is_purple(color) else "客观点"
    if is_blue_text(color): return "P2必背"
    if bold: return "P3选背"
    return "P4浏览"

class Ann(HTMLParser):
    def __init__(self):
        super().__init__()
        self.stack = []   # 每个开标签压一帧 {color,bg,bold,ul}
        self.buckets = {}  # 标签 -> 文本片段列表
        self.cur = []      # 当前累积(同一段)

    def _cur_style(self):
        color = bg = None; bold = ul = False
        for fr in self.stack:
            if fr.get("color"): color = fr["color"]
            if fr.get("bg"): bg = fr["bg"]
            if fr.get("bold"): bold = True
            if fr.get("ul"): ul = True
        return color, bg, bold, ul

    def handle_starttag(self, tag, attrs):
        fr = {}
        if tag == "b" or tag == "strong": fr["bold"] = True
        if tag == "u": fr["ul"] = True
        if tag == "span" or tag == "font":
            d = dict(attrs)
            st = d.get("style", "")
            cm = re.search(r"(?<!background-)color:\s*(rgb\([^)]+\)|#[0-9a-fA-F]{6})", st)
            bm = re.search(r"background-color:\s*(rgb\([^)]+\))", st)
            if cm: fr["color"] = parse_rgb(cm[1])
            if bm: fr["bg"] = parse_rgb(bm[1])
            if d.get("color"): fr["color"] = parse_rgb(d["color"]) or fr.get("color")
        self.stack.append(fr)
        if tag in ("div", "p", "br", "h1", "h2", "h3", "h4", "li", "tr"):
            self._flush()

    def handle_endtag(self, tag):
        if self.stack: self.stack.pop()
        if tag in ("div", "p", "h1", "h2", "h3", "h4", "li", "tr"):
            self._flush()

    def handle_startendtag(self, tag, attrs):
        if tag == "br": self._flush()

    def _flush(self):
        if self.cur:
            self.buckets.setdefault(self._seg_label, []).append("".join(self.cur).strip())
            self.cur = []

    def handle_data(self, data):
        text = html.unescape(data).replace("\xa0", " ")
        if not text.strip():
            return
        lbl = classify(*self._cur_style())
        # 段落内标签变化则切分
        if self.cur and getattr(self, "_seg_label", None) != lbl:
            self._flush()
        self._seg_label = lbl
        self.cur.append(text)

    def result(self):
        self._flush()
        return {k: [s for s in v if s] for k, v in self.buckets.items()}

def annotate(htmltext):
    p = Ann(); p._seg_label = "P4浏览"
    try: p.feed(htmltext or "")
    except Exception: pass
    return p.result()

# ── 原始 HTML 保真层（2026-06-10：背诵原文必须与 Anki 卡一字不差、颜色排版一致）──
# 不再依赖颜色分桶重组（会肢解句子），而是把字段 HTML 原样带给前端渲染。
# 仅做三件事：①剥 <script>/on* 事件（防注入）②img src 改写到 /anki-media/（png/jpg→webp）③去外链跟踪像素。
def raw_html(h):
    if not h or not h.strip():
        return ""
    h = re.sub(r"<script[\s\S]*?</script>", "", h, flags=re.I)
    h = re.sub(r"\son\w+\s*=\s*(\"[^\"]*\"|'[^']*')", "", h, flags=re.I)

    def _src(m):
        src = html.unescape(m.group(1))
        if src.startswith(("http:", "https:", "data:")):
            return m.group(0)  # 外链/内嵌保持原样（字段里基本没有）
        if src.lower().endswith(".svg"):
            name = src
        else:
            name = src.rsplit(".", 1)[0] + ".webp"
        return 'src="/anki-media/%s"' % urllib.parse.quote(name)

    return re.sub(r'src="([^"]+)"', _src, h).strip()

def subject_of(deck):
    parts = deck.split("::")
    seg = parts[1].strip() if len(parts) > 1 else parts[0].strip()
    if "法条分析" in seg:
        if "刑法" in seg: return "刑法", True
        if "民法" in seg: return "民法", True
        return seg, True
    m = {"A": "刑法", "B": "民法", "C": "法理", "D": "宪法", "E": "法制史"}
    if seg[:1] in m and seg[1:2] == " ": return m[seg[:1]], False
    return seg, False

db = sqlite3.connect(DB); c = db.cursor()
col = c.execute("select models, decks from col").fetchone()
models = json.loads(col[0]); decks = json.loads(col[1])
mid2flds = {mid: [f["name"] for f in m["flds"]] for mid, m in models.items()}
mid2name = {mid: m["name"] for mid, m in models.items()}
did2name = {int(d): v["name"] for d, v in decks.items()}
note_did = {}
for cid, nid, did in c.execute("select id, nid, did from cards"):
    note_did[nid] = did

SKIP = ("使用手册", "标注说明")
notes = []
plain = lambda h: re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html.unescape(h or "").replace("\xa0", " "))).strip()

for nid, mid, flds in c.execute("select id, mid, flds from notes order by id"):
    mid = str(mid); deck = did2name.get(note_did.get(nid), "")
    if any(s in deck for s in SKIP): continue
    subject, is_fatiao = subject_of(deck)
    names = mid2flds.get(mid, []); vals = flds.split(chr(0x1f))
    f = {names[i]: vals[i] for i in range(min(len(names), len(vals)))}
    model = mid2name.get(mid, mid)
    chap_raw = f.get("章节", "")
    if "Basic" in model:  # 法条卡
        ann = annotate(f.get("Back", ""))
        timu = plain(f.get("Front", ""))
        title = timu.split("\n")[0][:80]; kind = "法条"
        # Basic 卡：Front=题干，Back+图片=内容
        timu_html = raw_html(f.get("Front", ""))
        yuanwen_html = raw_html(f.get("Back", "")) + raw_html(f.get("图片", ""))
        biji_html = ""
    else:
        # 题目字段=带口诀+优先级配色的主观题范答(首选)；无则退原文
        src = f.get("题目", "") or f.get("原文", "")
        ann = annotate(src)
        timu = plain(f.get("题目", ""))
        title = (timu.split("【")[0] or plain(chap_raw).split("\n")[0])[:80]; kind = "卡片"
        timu_html = raw_html(f.get("题目", ""))
        yuanwen_html = raw_html(f.get("原文", ""))
        biji_html = raw_html(f.get("我的笔记", ""))
    g = lambda *ks: [s for k in ks for s in ann.get(k, [])]
    has_subj = bool(f.get("题目", "").strip()) or bool(ann.get("出主观标记"))
    has_obj = bool(ann.get("客观点") or ann.get("极重要客观点"))
    notes.append({
        "note_id": nid, "subject": subject, "is_fatiao": is_fatiao,
        "deck": deck, "chapter": plain(chap_raw), "model": model, "kind": kind,
        "题型": "主观" if has_subj else ("客观" if has_obj else "其他"),
        "星级": (timu.count("✨")),
        "title": title,
        "口诀": g("口诀"),
        "P1必背高精": g("P1必背高精"),
        "P2必背": g("P2必背"),
        "P3选背": g("P3选背"),
        "P4浏览": g("P4浏览"),
        "客观点": g("客观点"),
        "极重要客观点": g("极重要客观点"),
        "原文全文": plain(f.get("原文", "") or f.get("Back", "")),
        # 原始 HTML（保真层）：前端直接渲染，颜色/排版与 Anki 完全一致
        "章节HTML": raw_html(chap_raw),
        "题目HTML": timu_html,
        "原文HTML": yuanwen_html,
        "笔记HTML": biji_html,
    })
db.close()

with io.open(OUT, "w", encoding="utf-8") as fp:
    json.dump(notes, fp, ensure_ascii=False)

print(f"抽取 {len(notes)} 张 → {OUT}")
print("科目:", dict(Counter(n["subject"] for n in notes)))
print("题型:", dict(Counter(n["题型"] for n in notes)))
withP1 = sum(1 for n in notes if n["P1必背高精"])
withMn = sum(1 for n in notes if n["口诀"])
withObj = sum(1 for n in notes if n["客观点"] or n["极重要客观点"])
print(f"有P1必背高精: {withP1} | 有口诀: {withMn} | 有客观点: {withObj}")
withHtml = sum(1 for n in notes if n["题目HTML"] or n["原文HTML"])
print(f"有原始HTML: {withHtml}")
