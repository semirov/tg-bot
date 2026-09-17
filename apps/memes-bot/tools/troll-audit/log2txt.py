#!/usr/bin/env python3
"""Превращает сырые логи тролль-бота в читаемый транскрипт.

Использование: python3 troll-audit/log2txt.py /tmp/all.log [начало] [конец]
  начало/конец — подстроки времени, например "09/16/2026, 6:40" и "09/16/2026, 7:20".
"""

import re
import sys
from collections import OrderedDict

LINE = re.compile(
    r"^(?:\S+Z\s+)?\[Nest\]\s+\d+\s+-\s+(\d{2}/\d{2}/\d{4}),\s+(\d+:\d+:\d+\s+[AP]M)\s+"
    r"(\w+)\s+\[([^\]]+)\]\s*(.*)$"
)

ANSI = re.compile(r"\x1b\[[0-9;]*m")

KINDS = (
    "сообщение [msg",
    "отправлено [msg",
    "отправлено (без ответа)",
    "LLM-ответ",
    "статья",
    "Похоже на статью",
    "Почти наверняка",
    "кривляюсь",
    "кривляние отправлено",
    "сарказм",
    "реакция",
    "ответ отправлен",
    "ответы на обращения",
    "команда",
    "/sumarize",
    "/future",
    "/stat",
    "/meme",
    "DEEPSEEK_API_KEY",
    "не задан",
)


def main() -> None:
    path = sys.argv[1]
    start = sys.argv[2] if len(sys.argv) > 2 else None
    end = sys.argv[3] if len(sys.argv) > 3 else None

    seen = OrderedDict()
    with open(path, "r", encoding="utf-8", errors="replace") as handle:
        for raw in handle:
            raw = ANSI.sub("", raw)
            match = LINE.match(raw.rstrip("\n"))
            if not match:
                continue
            _, time, level, component, message = match.groups()
            if not any(kind in message for kind in KINDS):
                continue
            key = (time, component, message)
            if key in seen:
                continue
            seen[key] = True

    for (time, component, message) in seen:
        text = f"{time} [{component}] {message}"
        if start and time < start:
            continue
        if end and time > end:
            continue
        if len(text) > 700:
            text = text[:700] + "…"
        print(text)


if __name__ == "__main__":
    main()
