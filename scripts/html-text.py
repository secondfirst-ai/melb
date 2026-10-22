#!/usr/bin/env python3
"""只解析 HTML，不执行页面；用标准库解 HTML5 实体。"""
from html.parser import HTMLParser
import sys


class Text(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.hidden = []
        self.parts = []

    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style', 'noscript', 'template'):
            self.hidden.append(tag)
        if not self.hidden:
            self.parts.append(' ')

    def handle_endtag(self, tag):
        if self.hidden and self.hidden[-1] == tag:
            self.hidden.pop()
        if not self.hidden:
            self.parts.append(' ')

    def handle_data(self, text):
        if not self.hidden:
            self.parts.append(text)


parser = Text()
parser.feed(sys.stdin.read())
sys.stdout.write(''.join(parser.parts))
