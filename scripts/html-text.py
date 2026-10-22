#!/usr/bin/env python3
"""只解析 HTML，不执行页面；用标准库解 HTML5 实体。"""
from html.parser import HTMLParser
import sys

# 只有块级标签断开文字；<a>、<strong> 这类行内标签前后不加空格，不然「system</a>.」会变成「system .」，原句对不上。
BLOCK = {
    'address', 'article', 'aside', 'blockquote', 'br', 'caption', 'dd', 'details', 'dialog', 'div', 'dl', 'dt',
    'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr',
    'li', 'main', 'nav', 'ol', 'option', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th',
    'thead', 'tr', 'ul', 'body', 'html', 'head', 'title',
}


class Text(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.hidden = []
        self.parts = []

    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style', 'noscript', 'template'):
            self.hidden.append(tag)
        if not self.hidden and tag in BLOCK:
            self.parts.append(' ')

    def handle_endtag(self, tag):
        if self.hidden and self.hidden[-1] == tag:
            self.hidden.pop()
        if not self.hidden and tag in BLOCK:
            self.parts.append(' ')

    def handle_data(self, text):
        if not self.hidden:
            self.parts.append(text)


parser = Text()
parser.feed(sys.stdin.read())
sys.stdout.write(''.join(parser.parts))
