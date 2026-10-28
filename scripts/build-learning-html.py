# -*- coding: utf-8 -*-
"""学习材料汇编 HTML 生成器：把 md 源转换为带侧栏目录的单文件 docs/learning-bundle.html。
覆盖语法：标题/表格/ fenced 代码/列表/粗体/行内码/引用/分隔线（项目文档所用子集）。"""
import io, re, html, pathlib

def esc(s): return html.escape(s, quote=False)

def inline(s):
    s = esc(s)
    s = re.sub(r'`([^`]+)`', r'<code>\1</code>', s)
    s = re.sub(r'\*\*([^*]+)\*\*', r'<strong>\1</strong>', s)
    s = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', r'<a href="\2" target="_blank" rel="noopener">\1</a>', s)
    return s

def md_to_html(text):
    lines = text.split('\n'); out = []; i = 0; in_code = False; code_buf = []
    list_stack = []
    def close_lists():
        while list_stack: out.append(f'</{list_stack.pop()}>')
    while i < len(lines):
        ln = lines[i]
        if ln.strip().startswith('```'):
            if in_code:
                out.append('<pre><code>' + esc('\n'.join(code_buf)) + '</code></pre>'); code_buf = []; in_code = False
            else:
                close_lists(); in_code = True
            i += 1; continue
        if in_code: code_buf.append(ln); i += 1; continue
        st = ln.strip()
        if not st: close_lists(); i += 1; continue
        m = re.match(r'^(#{1,4})\s+(.*)$', ln)
        if m:
            close_lists(); lvl = len(m.group(1)) + 1  # 章节 h2 起（h1 被章节标题占用）
            out.append(f'<h{lvl}>{inline(m.group(2))}</h{lvl}>'); i += 1; continue
        if st.startswith('|') and i + 1 < len(lines) and re.match(r'^\|[\s:|-]+\|$', lines[i+1].strip()):
            close_lists()
            rows = []; j = i
            while j < len(lines) and lines[j].strip().startswith('|'):
                cells = [c.strip() for c in lines[j].strip().strip('|').split('|')]
                rows.append(cells); j += 1
            out.append('<table><thead><tr>' + ''.join(f'<th>{inline(c)}</th>' for c in rows[0]) + '</tr></thead><tbody>')
            for r in rows[2:]:
                out.append('<tr>' + ''.join(f'<td>{inline(c)}</td>' for c in r) + '</tr>')
            out.append('</tbody></table>'); i = j; continue
        if st in ('---', '***'):
            close_lists(); out.append('<hr>'); i += 1; continue
        if st.startswith('>'):
            close_lists(); out.append(f'<blockquote>{inline(st[1:].strip())}</blockquote>'); i += 1; continue
        m = re.match(r'^(\s*)[-*]\s+(.*)$', ln)
        if m:
            if not list_stack or list_stack[-1] != 'ul': close_lists(); out.append('<ul>'); list_stack.append('ul')
            out.append(f'<li>{inline(m.group(2))}</li>'); i += 1; continue
        m = re.match(r'^(\s*)(\d+)\.\s+(.*)$', ln)
        if m:
            if not list_stack or list_stack[-1] != 'ol': close_lists(); out.append('<ol>'); list_stack.append('ol')
            out.append(f'<li>{inline(m.group(3))}</li>'); i += 1; continue
        close_lists(); out.append(f'<p>{inline(st)}</p>'); i += 1
    close_lists()
    if in_code and code_buf: out.append('<pre><code>' + esc('\n'.join(code_buf)) + '</code></pre>')
    return '\n'.join(out)

SECTIONS = [
    ('guide',   '① 项目指导书', 'docs/PROJECT-GUIDE.md', '零基础入口：项目是什么、技术栈白话、数据模型、六大流程跟代码、设计思想、逐文件导读、上手任务'),
    ('demo',    '② 十分钟演示脚本', '/tmp/DEMO-SCRIPT.md', '按六幕演示全部核心能力，每步含预期现象——演示即验收'),
    ('glossary','③ 业务术语表', 'GLOSSARY.md', '排班领域的精确用语与"避免使用"注记（例如节次≠节次序号）'),
    ('accept',  '④ 验收矩阵', 'docs/implementation/ACCEPTANCE.md', 'FE-01~24 验收状态、原始需求 F01~F08 映射、基线缺陷 P01~P08 核销'),
    ('verify',  '⑤ 验证台账', 'docs/implementation/VERIFICATION.md', 'V-001~V-026 每条验证的命令、结果与边界——所有"已完成"的证据链'),
    ('trouble', '⑥ 排障手册', 'docs/troubleshooting.md', 'T-001~T-015 真实踩坑：现象→根因→解决→教训'),
    ('adr',     '⑦ 架构决策记录', None, 'ADR-001 存储/打包选型、ADR-002 框架/算法/撤销选型、ADR-0001 保留前端架构'),
    ('learn',   '⑧ 学习指南（AI 完成后）', '/tmp/LEARNING-GUIDE.md', '代码地图、五条关键调用链、算法与事务讲解、分步练习、项目经历事实表'),
]

sections_html = []
toc_html = []
for sid, title, path, desc in SECTIONS:
    if sid == 'adr':
        body = []
        for p, t in [('docs/adr/0001-retain-frontend-desktop.md', 'ADR-0001 保留纯前端业务与本地桌面架构（2026-10-26）'),
                     ('docs/ADR-001.md', 'ADR-001 技术选型与架构决策（2026-09-10）'),
                     ('docs/ADR-002.md', 'ADR-002 前端框架、排班算法与撤销/重做机制选型（2026-09-10）')]:
            body.append(f'<h3>{t}</h3>')
            body.append(md_to_html(io.open(p, encoding='utf-8').read()))
        body_html = '\n'.join(body)
    else:
        src = pathlib.Path(path)
        body_html = md_to_html(src.read_text(encoding='utf-8')) if src.exists() else '<p>（源文件缺失）</p>'
    sections_html.append(f'<section id="sec-{sid}"><h1>{title}</h1><p class="sec-desc">{esc(desc)}</p>{body_html}</section>')
    toc_html.append(f'<a href="#sec-{sid}"><span class="toc-t">{title}</span><span class="toc-d">{esc(desc[:18])}…</span></a>')

CSS = """
:root{--p:#4f6ef2;--ink:#1f2430;--mut:#6b7280;--bg:#f4f6fa;--card:#fff;--line:#e5e8f0}
*{box-sizing:border-box}
body{margin:0;font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif;color:var(--ink);background:var(--bg)}
.layout{display:flex;min-height:100vh}
nav{width:292px;flex:none;background:linear-gradient(180deg,#232a4d,#1c2240);color:#c8cdea;padding:22px 0;position:sticky;top:0;height:100vh;overflow-y:auto}
nav .brand{padding:0 20px 16px;border-bottom:1px solid rgba(255,255,255,.12);margin-bottom:14px}
nav .brand b{color:#fff;font-size:17px;display:block}
nav .brand span{font-size:11.5px;opacity:.6}
nav a{display:block;padding:9px 20px;color:#b6bdd9;text-decoration:none;border-left:3px solid transparent}
nav a:hover{background:rgba(255,255,255,.06);color:#fff}
nav a.on{border-left-color:var(--p);background:linear-gradient(90deg,rgba(79,110,242,.35),transparent);color:#fff}
nav .toc-t{display:block;font-size:13.5px;font-weight:600}
nav .toc-d{display:block;font-size:11px;opacity:.55;margin-top:2px}
main{flex:1;padding:34px 44px 90px;max-width:1060px}
.hero{background:linear-gradient(135deg,#4f6ef2,#7a5cf0);color:#fff;border-radius:16px;padding:30px 34px;margin-bottom:30px;box-shadow:0 10px 30px rgba(79,110,242,.25)}
.hero h1{margin:0 0 8px;font-size:25px}
.hero p{margin:4px 0;opacity:.92;font-size:13.5px;line-height:1.8}
.badge{display:inline-block;background:rgba(255,255,255,.18);border-radius:20px;padding:3px 12px;font-size:12px;margin:6px 8px 0 0}
section{background:var(--card);border-radius:14px;box-shadow:0 2px 10px rgba(30,41,82,.06);padding:30px 36px;margin-bottom:30px}
section h1{margin:0 0 6px;font-size:22px;color:#232a4d;border-bottom:2px solid var(--p);padding-bottom:10px}
.sec-desc{color:var(--mut);font-size:13px;margin:10px 0 22px}
h2{font-size:18px;margin:30px 0 10px;color:#2c3350;border-left:4px solid var(--p);padding-left:10px}
h3{font-size:15.5px;margin:24px 0 8px;color:#37406b}
h4{font-size:14px;margin:18px 0 6px}
p,li{font-size:13.8px;line-height:1.95}
table{border-collapse:collapse;width:100%;margin:14px 0;font-size:12.8px}
th{background:#f0f3fc;text-align:left}
th,td{border:1px solid var(--line);padding:7px 10px;vertical-align:top}
tr:nth-child(even) td{background:#fafbfd}
code{background:#eef1f8;border-radius:4px;padding:1px 6px;font-family:Consolas,monospace;font-size:12.5px;color:#3b49c4}
pre{background:#20243d;color:#dbe2ff;border-radius:10px;padding:14px 16px;overflow-x:auto}
pre code{background:none;color:inherit;padding:0}
blockquote{border-left:4px solid #b9c3f5;background:#f2f4fd;margin:12px 0;padding:8px 14px;border-radius:0 8px 8px 0;color:#41506e}
hr{border:none;border-top:1px dashed var(--line);margin:22px 0}
a{color:var(--p)}
ul,ol{padding-left:24px}
@media print{nav{display:none}main{padding:0}section{box-shadow:none;border:1px solid var(--line);page-break-inside:avoid}}
footer{color:var(--mut);font-size:12px;text-align:center;padding:10px 0 40px}
"""

JS = """
const links=[...document.querySelectorAll('nav a')];
const obs=new IntersectionObserver(es=>{es.forEach(e=>{if(e.isIntersecting){links.forEach(l=>l.classList.toggle('on',l.getAttribute('href')==='#'+e.target.id))}})},{rootMargin:'-20% 0px -70% 0px'});
document.querySelectorAll('section').forEach(s=>obs.observe(s));
const q=document.getElementById('q');
q.addEventListener('input',()=>{const k=q.value.trim();links.forEach(l=>{const t=l.textContent;l.style.display=!k||t.includes(k)?'':'none'})});
"""

html_doc = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CRSM 学习材料汇编</title>
<style>{CSS}</style>
</head>
<body>
<div class="layout">
<nav>
  <div class="brand"><b>CRSM 学习材料汇编</b><span>学院行政办助理排班系统 · 全部学习资源单文件版</span></div>
  <div style="padding:4px 20px 12px"><input id="q" placeholder="🔍 搜索章节…" style="width:100%;padding:7px 12px;border-radius:8px;border:none;background:rgba(255,255,255,.12);color:#fff;outline:none"></div>
  {''.join(toc_html)}
</nav>
<main>
  <div class="hero">
    <h1>学院行政办助理排班系统（CRSM）· 学习材料汇编</h1>
    <p>本页面整合项目全部学习资源：从零基础项目指导书，到验收矩阵、验证台账、排障手册与架构决策。左侧目录按<b>推荐学习顺序</b>排列，点击跳转；顶部搜索框可过滤章节。</p>
    <span class="badge">304 项测试全绿</span><span class="badge">FE-01~22 已验收</span><span class="badge">P01~P08 已关闭</span><span class="badge">入口包 101KB</span><span class="badge">离线桌面应用</span>
    <p style="margin-top:10px;font-size:12.5px;opacity:.85">建议路线：先读 ①② 建立全貌 → 跑一遍演示 → 用 ⑧ 的五条调用链跟代码 → 遇到问题查 ⑥ → 想知道"为什么这样设计"读 ⑦ 和 ⑤。</p>
  </div>
  {''.join(sections_html)}
  <footer>生成于 2026-10-28 · 源文件见仓库 docs/ 目录 · 此 HTML 为汇编快照（内容以仓库 md 为准）</footer>
</main>
</div>
<script>{JS}</script>
</body>
</html>"""

pathlib.Path('docs/learning-bundle.html').write_text(html_doc, encoding='utf-8')
print('生成完成 docs/learning-bundle.html', len(html_doc)//1024, 'KB')
