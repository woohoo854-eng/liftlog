"""Generate LiftLog app icons (barbell on a solid color). Standard library only.

Run from the project root: python make-icons.py
"""

import struct
import zlib
from pathlib import Path

BG = (0xF5, 0xA5, 0x24)   # accent amber
FG = (0x0E, 0x11, 0x16)   # app background

# Barbell shapes in units of 1/100 of the glyph width, centered on (0, 0):
# (x0, x1, half-height)
SHAPES = [
    (-50, 50, 3.5),    # bar
    (-31, -22, 26),    # inner plates
    (22, 31, 26),
    (-39, -32, 18),    # outer plates
    (32, 39, 18),
    (-44, -40, 7),     # collars
    (40, 44, 7),
]


def draw(size, glyph_fraction):
    px = [[BG] * size for _ in range(size)]
    unit = size * glyph_fraction / 100
    c = size / 2
    for x0, x1, hh in SHAPES:
        left, right = round(c + x0 * unit), round(c + x1 * unit)
        top, bottom = round(c - hh * unit), round(c + hh * unit)
        for y in range(top, bottom):
            row = px[y]
            for x in range(left, right):
                row[x] = FG
    return px


def write_png(path, px):
    h, w = len(px), len(px[0])
    raw = b"".join(b"\x00" + bytes(v for p in row for v in p) for row in px)

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw, 9))
           + chunk(b"IEND", b""))
    path.write_bytes(png)


def main():
    out = Path(__file__).parent / "icons"
    out.mkdir(exist_ok=True)
    write_png(out / "icon-192.png", draw(192, 0.80))
    write_png(out / "icon-512.png", draw(512, 0.80))
    # Maskable: keep the glyph inside the central 80% safe zone.
    write_png(out / "maskable-512.png", draw(512, 0.62))
    print("Wrote icons to", out)


if __name__ == "__main__":
    main()
