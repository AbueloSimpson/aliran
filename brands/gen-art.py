#!/usr/bin/env python3
"""Generate the SomaliStream brand artwork (icon/logo/wallpaper/banner).

Pure Pillow, deterministic. Brand palette matches service.json:
  primary  #12A150 (green)   background #06140E   surface #0C2418
  accent   #4ADE80 (mint)    text #EAFBF1          textDim #8FBFa6
"""
from PIL import Image, ImageDraw, ImageFont

OUT = "brands/somalistream"

PRIMARY = (18, 161, 80)
BG = (6, 20, 14)
SURFACE = (12, 36, 24)
ACCENT = (74, 222, 128)
TEXT = (234, 251, 241)
TEXT_DIM = (143, 191, 166)
BRAND_SURFACE = (234, 251, 241)
BRAND_TEXT = (10, 32, 20)

FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FONT_REG = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"


def font(path, size):
    return ImageFont.truetype(path, size)


def play_glyph(draw, cx, cy, r, color, width):
    """A rounded 'play' triangle centred at (cx, cy)."""
    h = r * 1.7
    pts = [(cx - r * 0.62, cy - h / 2), (cx - r * 0.62, cy + h / 2), (cx + r * 0.9, cy)]
    draw.polygon(pts, fill=color)
    return pts


def centered_text(draw, cx, cy, text, fnt, fill):
    l, t, r, b = draw.textbbox((0, 0), text, font=fnt)
    draw.text((cx - (r - l) / 2 - l, cy - (b - t) / 2 - t), text, font=fnt, fill=fill)


def make_icon(size=1024):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # rounded-square badge, transparent outside
    pad = int(size * 0.08)
    radius = int(size * 0.22)
    d.rounded_rectangle([pad, pad, size - pad, size - pad], radius=radius, fill=PRIMARY)
    # subtle top highlight
    d.rounded_rectangle([pad, pad, size - pad, int(size * 0.5)], radius=radius, fill=(255, 255, 255, 22))
    # glyph within the middle ~60% (adaptive-icon safe zone)
    cx = cy = size / 2
    play_glyph(d, cx, cy, size * 0.22, BRAND_SURFACE, 0)
    img.save(f"{OUT}/icon.png")
    print("icon.png", img.size)


def make_logo(w=1200, h=360):
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # glyph on the left
    play_glyph(d, h * 0.5, h * 0.5, h * 0.30, PRIMARY, 0)
    fnt = font(FONT_BOLD, int(h * 0.44))
    d.text((h * 0.78, h * 0.5), "SomaliStream", font=fnt, fill=PRIMARY, anchor="lm")
    img.save(f"{OUT}/logo.png")
    print("logo.png", img.size)


def make_wallpaper(w=1920, h=1080):
    img = Image.new("RGB", (w, h), BG)
    d = ImageDraw.Draw(img)
    # vertical gradient
    for y in range(h):
        t = y / h
        r = int(BG[0] + (SURFACE[0] - BG[0]) * t)
        g = int(BG[1] + (SURFACE[1] - BG[1]) * t)
        b = int(BG[2] + (SURFACE[2] - BG[2]) * t)
        d.line([(0, y), (w, y)], fill=(r, g, b))
    # concentric faint rings from the lower-right
    for i in range(9):
        rr = int(w * (0.12 + i * 0.11))
        d.ellipse([w - rr, h - rr, w + rr, h + rr], outline=(18, 161, 80, 30) if False else (24, 70, 46), width=3)
    # soft accent glow centre-left
    glow = Image.new("L", (w, h), 0)
    gd = ImageDraw.Draw(glow)
    gd.ellipse([w * 0.08, h * 0.22, w * 0.55, h * 0.78], fill=90)
    glow = glow.filter(__import__("PIL.ImageFilter", fromlist=["ImageFilter"]).GaussianBlur(180))
    accent_layer = Image.new("RGB", (w, h), (24, 120, 66))
    img = Image.composite(accent_layer, img, glow)
    d = ImageDraw.Draw(img)
    # faint wordmark, bottom-left
    fnt = font(FONT_BOLD, 64)
    d.text((80, h - 150), "SomaliStream", font=fnt, fill=(30, 90, 60))
    img.save(f"{OUT}/wallpaper.png")
    print("wallpaper.png", img.size)


def make_banner(w=320, h=180):
    img = Image.new("RGB", (w, h), BG)
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([6, 6, w - 6, h - 6], radius=18, fill=SURFACE)
    play_glyph(d, w * 0.30, h * 0.5, h * 0.24, PRIMARY, 0)
    centered_text(d, w * 0.63, h * 0.5, "SomaliStream", font(FONT_BOLD, 22), TEXT)
    img.save(f"{OUT}/banner.png")
    print("banner.png", img.size)


if __name__ == "__main__":
    make_icon()
    make_logo()
    make_wallpaper()
    make_banner()
