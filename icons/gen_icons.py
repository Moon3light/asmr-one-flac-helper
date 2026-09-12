# -*- coding: utf-8 -*-
# 生成扩展图标：蓝色方块 + 白色音符（16x16 位图最近邻放大）
# 运行：python gen_icons.py
import struct, zlib, os

ART = [
    "................",
    "..############..",
    ".#bbbbbbbbbbbb#.",
    "#bbbbbbbbbbbbbb#",
    "#bbbbwwwwwbbbbb#",
    "#bbbbwbbbbwbbbb#",
    "#bbbbwbbbbwbbbb#",
    "#bbbbwbbbbwwwwb#",
    "#bbbbwbbbbwbbbb#",
    "#bbbbwbbbbwbbbb#",
    "#bbbbwbbbbwbbbb#",
    "#bbbwwwwwbbwwww#",
    "#bbbwwwwwwwwwwb#",
    ".#bbbbbbbbbbbb#.",
    "..############..",
    "................",
]

COLORS = {
    "#": (23, 78, 166, 255),
    "b": (33, 118, 218, 255),
    "w": (255, 255, 255, 255),
    ".": (0, 0, 0, 0),
}


def crc32(data: bytes) -> int:
    crc = 0xFFFFFFFF
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = (0xEDB88320 ^ (crc >> 1)) if (crc & 1) else (crc >> 1)
    return crc ^ 0xFFFFFFFF


def chunk(typ: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + typ
        + data
        + struct.pack(">I", crc32(typ + data))
    )


def make_png(size: int, scale: int) -> bytes:
    rows = []
    for y in range(size):
        row = bytearray(b"\x00")
        for x in range(size):
            bx = min(15, x // scale)
            by = min(15, y // scale)
            row.extend(COLORS[ART[by][bx]])
        rows.append(bytes(row))
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return b"".join([
        b"\x89PNG\r\n\x1a\n",
        chunk(b"IHDR", ihdr),
        chunk(b"IDAT", zlib.compress(b"".join(rows))),
        chunk(b"IEND", b""),
    ])


here = os.path.dirname(os.path.abspath(__file__))
for name, size, scale in (("icon16.png", 16, 1), ("icon48.png", 48, 3), ("icon128.png", 128, 8)):
    with open(os.path.join(here, name), "wb") as f:
        f.write(make_png(size, scale))
print("icons written")
