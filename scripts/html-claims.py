"""用标准库拆指南中的引用块及 Sources，不执行 HTML。"""
from html.parser import HTMLParser
import json
import re
import sys

VOID = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'}
HIDDEN = {'script', 'style', 'noscript', 'template', 'head'}
BLOCK = {'p', 'li', 'blockquote', 'dd', 'dt', 'tr', 'div', 'section', 'article', 'main', 'aside', 'header', 'footer'}


class Node:
    def __init__(self, tag='', attrs=()):
        self.tag, self.attrs, self.children = tag, dict(attrs), []


class Tree(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Node()
        self.stack = [self.root]

    def handle_starttag(self, tag, attrs):
        # HTML 允许省略这些结束标签；不把下一行/下一项误嵌进前一行。
        def close_optional(tags, boundaries=()):
            for i in range(len(self.stack) - 1, 0, -1):
                if self.stack[i].tag in boundaries:
                    return
                if self.stack[i].tag in tags:
                    del self.stack[i:]
                    return

        if tag in BLOCK or tag in ('table', 'ul', 'ol', 'pre', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'):
            close_optional({'p'})
        if tag == 'li':
            close_optional({'li'}, {'ul', 'ol'})
        elif tag == 'tr':
            close_optional({'tr'}, {'table'})
        elif tag in ('td', 'th'):
            close_optional({'td', 'th'}, {'tr', 'table'})
        node = Node(tag, attrs)
        self.stack[-1].children.append(node)
        if tag not in VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i].tag == tag:
                del self.stack[i:]
                break

    def handle_data(self, text):
        self.stack[-1].children.append(text)


def walk(node):
    if node.tag in HIDDEN:
        return
    yield node
    for child in node.children:
        if isinstance(child, Node):
            yield from walk(child)


def text(node, nested=False, row=False):
    if isinstance(node, str):
        return node
    if node.tag in HIDDEN or nested and node.tag in BLOCK and not row:
        return ' '
    href = node.attrs.get('href', '')
    if node.tag == 'a' and re.fullmatch(r'#s\d+', href):
        return '\ue000' + href[1:] + '\ue001'
    body = ''.join(text(c, True, row) for c in node.children)
    return (' | ' if row and node.tag in ('td', 'th') else ' ' if node.tag == 'br' or row and node.tag in BLOCK else '') + body


parser = Tree()
parser.feed(sys.stdin.read())
sources, blocks = {}, []
for node in walk(parser.root):
    source_id = node.attrs.get('id', '')
    if node.tag == 'li' and re.fullmatch(r's\d+', source_id):
        sources[source_id] = [n.attrs['href'] for n in walk(node) if n.tag == 'a' and n.attrs.get('href') and not n.attrs['href'].startswith('#')]


def claims(node, in_row=False, in_source=False):
    if node.tag in HIDDEN:
        return
    in_source = in_source or node.tag == 'li' and re.fullmatch(r's\d+', node.attrs.get('id', ''))
    if not in_source and not in_row and node.tag in BLOCK:
        value = text(node, row=node.tag == 'tr').strip(' |\n\t')
        # 表格也接受文字 [N]；正文引用必须是站点的 #sN 链接。
        if node.tag == 'tr':
            value = re.sub(r'\[(\d+)\]', lambda m: '\ue000s' + m[1] + '\ue001', value)
        if '\ue000' in value:
            blocks.append({'text': value, 'row': node.tag == 'tr'})
    for child in node.children:
        if isinstance(child, Node):
            claims(child, in_row or node.tag == 'tr', in_source)


claims(parser.root)
print(json.dumps({'sources': sources, 'blocks': blocks}, ensure_ascii=False))
