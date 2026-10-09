"""
麻将牌面（代码画的像素牌）。整个系列共用一张图集 apps/web/public/art/tiles.png：

- 每张牌 20×32 像素：牌面 18×26（含高光），下面 4 像素是牌身的厚度（露出牌背颜色），外面 1 像素描边。
- 顺序：0–33 按牌种（万 0–8、筒 9–17、条 18–26、东南西北白发中 27–33），34–36 是红五（五万、五筒、五索），
  37 是牌背（别人手里立着的牌、暗杠）。
- 万字用 Fusion Pixel 12px 写（字要准，不让模型写字）；筒的圆点、条的竹节按格子画。一条的小鸟先用代码画，美术轮再换。

用法：python art/tiles.py  →  public/art/tiles.png 和 art/out/tiles-preview.png（放大 4 倍的预览）
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
FONT = ImageFont.truetype(str(ROOT / "art/out/fusion12.ttf"), 12)
W, H = 20, 32
FACE_H = 26  # 牌面高度（第 1–26 行）

OUTLINE = (40, 36, 34, 255)
IVORY = (246, 240, 222, 255)
IVORY_HI = (255, 252, 242, 255)
IVORY_LO = (226, 216, 190, 255)
BACK = (46, 132, 92, 255)
BACK_HI = (78, 168, 120, 255)
BACK_LO = (30, 98, 68, 255)
INK = (34, 40, 70, 255)
RED = (200, 46, 52, 255)
RED_LO = (140, 28, 36, 255)
GREEN = (36, 132, 80, 255)
GREEN_LO = (20, 88, 52, 255)
BLUE = (40, 86, 168, 255)
BLUE_LO = (24, 52, 112, 255)
GOLD = (214, 160, 52, 255)

NUMERALS = "一二三四五六七八九"


def blank(face=IVORY, hi=IVORY_HI, lo=IVORY_LO, side=BACK, side_lo=BACK_LO) -> Image.Image:
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    px = img.load()
    for y in range(H):
        for x in range(W):
            edge = x == 0 or x == W - 1 or y == 0 or y == H - 1
            if edge:
                # 四个角缺一格，像素风的圆角。
                if (x in (0, W - 1)) and (y in (0, H - 1)):
                    continue
                px[x, y] = OUTLINE
            elif y <= FACE_H:
                px[x, y] = face
            else:
                px[x, y] = side if y < H - 2 else side_lo
    # 高光和阴影
    for x in range(1, W - 1):
        px[x, 1] = hi
        px[x, FACE_H] = lo
    for y in range(1, FACE_H + 1):
        px[1, y] = hi
        px[W - 2, y] = lo
    px[1, FACE_H] = lo
    # 牌面和牌身之间一条暗线
    for x in range(1, W - 1):
        px[x, FACE_H + 1] = side_lo
    return img


def text(img: Image.Image, glyph: str, top: int, color) -> None:
    """把一个 12px 字放在牌面中间（左右居中），top 是字框的顶。"""
    layer = Image.new("L", (16, 12), 0)
    draw = ImageDraw.Draw(layer)
    draw.fontmode = "1"
    box = draw.textbbox((0, 0), glyph, font=FONT)
    width = box[2] - box[0]
    draw.text(((16 - width) // 2 - box[0], -box[1] + (12 - (box[3] - box[1])) // 2), glyph, font=FONT, fill=255)
    px = img.load()
    for y in range(12):
        for x in range(16):
            if layer.getpixel((x, y)) > 128:
                px[2 + x, top + y] = color


# ---------------------------------------------------------------------------
# 筒：5×5 的圆点

DOT = [
    ".###.",
    "#...#",
    "#.#.#",
    "#...#",
    ".###.",
]


def dot(img, cx, cy, color, dark):
    px = img.load()
    for dy, row in enumerate(DOT):
        for dx, ch in enumerate(row):
            if ch == "#":
                px[cx - 2 + dx, cy - 2 + dy] = color if (dx, dy) != (2, 2) else dark
    # 中间点用深色
    px[cx, cy] = dark


def big_circle(img):
    """一筒：大圆盘，外圈蓝、中圈红、中心绿。"""
    px = img.load()
    cx, cy = 10, 13
    for y in range(2, 26):
        for x in range(2, 18):
            d2 = (x - cx + 0.5) ** 2 + (y - cy + 0.5) ** 2
            if d2 <= 7.2 ** 2:
                if d2 > 6.0 ** 2:
                    px[x, y] = BLUE_LO
                elif d2 > 4.6 ** 2:
                    px[x, y] = BLUE if (x + y) % 2 else (90, 130, 200, 255)
                elif d2 > 3.2 ** 2:
                    px[x, y] = RED
                elif d2 > 1.8 ** 2:
                    px[x, y] = IVORY
                else:
                    px[x, y] = GREEN


DOT_COLORS = {"b": (BLUE, BLUE_LO), "g": (GREEN, GREEN_LO), "r": (RED, RED_LO)}

# 每种筒子：(中心 x, 中心 y, 颜色)。牌面可用区域 x 2–17、y 2–25。
CX = [5, 10, 14]
DOT_LAYOUT = {
    2: [(10, 7, "g"), (10, 20, "b")],
    3: [(5, 5, "b"), (10, 13, "r"), (14, 21, "g")],
    4: [(6, 8, "b"), (14, 8, "g"), (6, 19, "g"), (14, 19, "b")],
    5: [(5, 5, "b"), (15, 5, "g"), (10, 13, "r"), (5, 21, "g"), (15, 21, "b")],
    6: [(6, 5, "g"), (14, 5, "g"), (6, 14, "r"), (14, 14, "r"), (6, 21, "r"), (14, 21, "r")],
    7: [(5, 4, "g"), (10, 7, "g"), (15, 10, "g"), (6, 16, "r"), (14, 16, "r"), (6, 22, "r"), (14, 22, "r")],
    8: [(6, 4, "b"), (14, 4, "b"), (6, 10, "b"), (14, 10, "b"), (6, 16, "b"), (14, 16, "b"), (6, 22, "b"), (14, 22, "b")],
    9: [(x, y, c) for y, c in ((5, "b"), (13, "r"), (21, "g")) for x in (4, 10, 16)],
}


def pin(rank: int, red=False) -> Image.Image:
    img = blank()
    if rank == 1:
        big_circle(img)
        return img
    for x, y, c in DOT_LAYOUT[rank]:
        color, dark = DOT_COLORS["r" if red else c]
        dot(img, x, y, color, dark)
    return img


# ---------------------------------------------------------------------------
# 条：竹节（3 像素宽：暗-亮-暗的竹筒，上中下三道竹节）

LIGHT = {"g": (98, 190, 128, 255), "r": (236, 110, 110, 255), "b": (110, 150, 220, 255)}


def stick(img, cx, top, color, dark, light, height):
    px = img.load()
    nodes = {0, height // 2, height - 1}
    for dy in range(height):
        y = top + dy
        if dy in nodes:
            for dx in (-1, 0, 1):
                px[cx + dx, y] = dark
        else:
            px[cx - 1, y] = color
            px[cx, y] = light
            px[cx + 1, y] = dark


STICK_COLORS = {"g": (GREEN, GREEN_LO), "r": (RED, RED_LO), "b": (BLUE, BLUE_LO)}
# (中心 x, 顶 y, 颜色)；两排的牌竹节高 11，三排的高 7。
STICK_LAYOUT = {
    2: [(10, 2, "g"), (10, 14, "b")],
    3: [(10, 2, "g"), (6, 14, "b"), (14, 14, "b")],
    4: [(6, 2, "g"), (14, 2, "b"), (6, 14, "b"), (14, 14, "g")],
    5: [(5, 2, "g"), (15, 2, "b"), (10, 8, "r"), (5, 14, "b"), (15, 14, "g")],
    6: [(x, y, c) for y, c in ((2, "g"), (14, "b")) for x in (5, 10, 15)],
    7: [(10, 2, "r")] + [(x, y, "g") for y in (10, 18) for x in (5, 10, 15)],
    8: [(x, y, "g" if x in (4, 16) else "b") for y in (2, 14) for x in (4, 8, 12, 16)],
    9: [(x, y, "r" if x == 10 else c) for y, c in ((2, "g"), (10, "b"), (18, "g")) for x in (5, 10, 15)],
}
STICK_HEIGHT = {2: 11, 3: 11, 4: 11, 5: 11, 6: 11, 7: 7, 8: 11, 9: 7}


def bird(img):
    """一条：一只站着的小鸟（之后美术轮可以换成 PixelLab 画的）。"""
    sprite = [
        "......GGG.......",
        ".....GGGGG......",
        "....GGKGGGG.....",
        "....GGGGGGYY....",
        "....GGGGGG......",
        "...GGGGGGG......",
        "..GGGGRGGGG.....",
        ".GGGGRRRGGGG....",
        ".GGGRRRRRGGGG...",
        "GGGGRRRRRGGGGG..",
        "GGGGGRRRGGGGGGG.",
        ".GGGGGRGGGGGGGGG",
        "..GGGGGGGGGGGGG.",
        "...GGGGGGGGGG...",
        ".....BBBBBB.....",
        "......BBBB......",
        "......Y..Y......",
        "......Y..Y......",
        ".....YY.YY......",
        "................",
    ]
    colors = {"G": GREEN, "K": OUTLINE, "Y": GOLD, "R": RED, "B": BLUE}
    px = img.load()
    for dy, row in enumerate(sprite):
        for dx, ch in enumerate(row):
            if ch in colors:
                px[2 + dx, 4 + dy] = colors[ch]


def sou(rank: int, red=False) -> Image.Image:
    img = blank()
    if rank == 1:
        bird(img)
        return img
    height = STICK_HEIGHT[rank]
    for x, y, c in STICK_LAYOUT[rank]:
        key = "r" if red else c
        color, dark = STICK_COLORS[key]
        # 五条中间那根比较短，放在两排之间
        h = 7 if rank == 5 and x == 10 else height
        stick(img, x, y + (2 if rank == 5 and x == 10 else 0), color, dark, LIGHT[key], h)
    return img


def man(rank: int, red=False) -> Image.Image:
    img = blank()
    text(img, NUMERALS[rank - 1], 2, RED if red else INK)
    text(img, "万", 14, RED)
    return img


def honor(index: int) -> Image.Image:
    img = blank()
    if index < 4:
        text(img, "东南西北"[index], 8, INK)
    elif index == 4:  # 白：蓝色方框
        px = img.load()
        for y in range(5, 23):
            for x in range(4, 16):
                if y in (5, 22) or x in (4, 15):
                    px[x, y] = BLUE
                elif y in (7, 20) or x in (6, 13):
                    px[x, y] = (150, 180, 220, 255)
    elif index == 5:
        text(img, "发", 8, GREEN)
    else:
        text(img, "中", 8, RED)
    return img


def back() -> Image.Image:
    img = blank(face=BACK, hi=BACK_HI, lo=BACK_LO, side=IVORY_LO, side_lo=(196, 184, 156, 255))
    px = img.load()
    # 牌背的小菱形花纹
    for y in range(4, 24):
        for x in range(4, 16):
            if (x + y) % 6 == 0 and (x - y) % 6 == 0:
                px[x, y] = BACK_HI
    return img


def build() -> Image.Image:
    sprites = []
    sprites += [man(r) for r in range(1, 10)]
    sprites += [pin(r) for r in range(1, 10)]
    sprites += [sou(r) for r in range(1, 10)]
    sprites += [honor(i) for i in range(7)]
    sprites += [man(5, True), pin(5, True), sou(5, True)]
    sprites.append(back())
    atlas = Image.new("RGBA", (W * len(sprites), H), (0, 0, 0, 0))
    for i, sprite in enumerate(sprites):
        atlas.paste(sprite, (i * W, 0))
    return atlas


if __name__ == "__main__":
    atlas = build()
    out = ROOT / "apps/web/public/art"
    out.mkdir(parents=True, exist_ok=True)
    atlas.save(out / "tiles.png")
    # 预览：每行 9 张，放大 4 倍，深色底
    cols = 10
    rows = (atlas.width // W + cols - 1) // cols
    preview = Image.new("RGBA", (cols * (W + 4) * 4, rows * (H + 4) * 4), (24, 30, 40, 255))
    for i in range(atlas.width // W):
        tile = atlas.crop((i * W, 0, (i + 1) * W, H)).resize((W * 4, H * 4), Image.NEAREST)
        preview.paste(tile, ((i % cols) * (W + 4) * 4 + 8, (i // cols) * (H + 4) * 4 + 8), tile)
    preview.save(ROOT / "art/out/tiles-preview.png")
    print("tiles:", atlas.size)
    # 网页图标：一张「中」放在 32×32 里
    icon = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
    icon.paste(atlas.crop((33 * W, 0, 34 * W, H)), (6, 0))
    icon.save(out / "icon.png")
