"""麻将 · 第一轮选图画廊。python art/gallery_r1.py 生成 art/out/gallery/（可以反复运行）。
本地查看：python -m http.server 8768 --directory art/out/gallery，然后打开 http://localhost:8768/gallery.html
页面（gallery.html，和海盐与纸同一个模板）：选择存 localStorage，每 30 秒重读 gallery.json，底部汇总成一段可复制的文字。
"""
from __future__ import annotations

import json
import shutil
import time
from pathlib import Path

from PIL import Image

import pixellab

ART = Path(__file__).resolve().parent
OUT = ART / "out" / "gallery"
R1 = ART / "out" / "r1"
COVERS = Path.home() / "projects/game-center/art/out/covers"


def copy_in(path: Path, folder: str) -> str:
    target = OUT / folder / path.name
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(path, target)
    return target.relative_to(OUT).as_posix()


def item(item_id: str, title: str, note: str, sources: list[tuple[str, str, str]], recommended: str | None, **extra) -> dict:
    return {
        "id": item_id, "title": title, "note": note, "kind": "image", **extra,
        "candidates": [{"id": cid, "src": src, "label": label, **({"recommended": True} if cid == recommended else {})} for cid, src, label in sources],
    }


def avatar_set(cid: str, picks: list[int]) -> str:
    seat = ["#f0b53a", "#3f8fe8", "#ef6b57", "#47b968"]
    strip = Image.new("RGBA", (4 * 44 - 4, 40), (0, 0, 0, 0))
    for index, pick in enumerate(picks):
        name = "avatar.png" if pick == 0 else f"avatar-{pick}.png"
        face = Image.open(R1 / "avatar" / name).convert("RGBA")
        box = Image.new("RGBA", (40, 40), seat[index])
        box.paste(Image.new("RGBA", (36, 36), (29, 42, 72, 255)), (2, 2))
        box.alpha_composite(face, (4, 4))
        strip.alpha_composite(box, (index * 44, 0))
    strip = strip.resize((strip.width * 3, strip.height * 3), Image.NEAREST)
    target = OUT / "avatars" / f"{cid}.png"
    target.parent.mkdir(parents=True, exist_ok=True)
    strip.save(target)
    return target.relative_to(OUT).as_posix()


def build() -> dict:
    items = []
    items.append(item("scene-night", "牌桌背景 · 夜间（成都老茶馆，灯笼）",
                      "512×288，按整数倍放大铺满牌桌，上面盖一层深色罩，中间是绿呢牌桌。首页主图也用它。",
                      [(f"s{s}", copy_in(R1 / f"teahouse-night-s{s}.png", "scenes"), label) for s, label in
                       ((32, "一排排红灯笼，纵深最好（现在用的）"), (31, "灯笼少一点，更暗"), (33, "暖黄墙、木地板"), (34, "灯笼挂在两边"))],
                      "s32", scale=1))
    items.append(item("scene-day", "牌桌背景 · 白天（竹帘透进阳光）",
                      "白天版用这张（盖一层很淡的罩）。第 4 张墙上的卷轴像写了字，没放进来。",
                      [(f"s{s}", copy_in(R1 / f"teahouse-day-s{s}.png", "scenes"), label) for s, label in
                       ((42, "竹帘、绿植、窗外老街（现在用的）"), (41, "近景一张茶桌，最亮"), (43, "茶柜、吊灯"))],
                      "s42", scale=1))
    items.append(item("avatars", "座位头像（一组 4 个，边框是座位色）",
                      "64 个候选见下面「全部头像候选」那张图（带编号）。想换哪几个，点「都不满意」在备注里写编号，比如「13 0 38 56」。",
                      [("A", avatar_set("A", [13, 0, 38, 21]), "茶馆大爷 / 扎发髻的姑娘 / 端茶碗的小伙 / 奶奶（现在用的）"),
                       ("B", avatar_set("B", [44, 14, 12, 57]), "白胡子老爷子 / 戴花的姑娘 / 戴帽子的大哥 / 银发奶奶"),
                       ("C", avatar_set("C", [56, 51, 42, 62]), "长须老爷子 / 长发姑娘 / 小伙 / 戴眼镜的大爷")],
                      "A", scale=1))
    sheet = ART / "out" / "r1-avatars.png"
    if sheet.exists():
        items.append(item("avatars-all", "全部头像候选（64 个，带编号）", "只是参考，不用选；在上一项的备注里写编号。",
                          [("all", copy_in(sheet, "avatars"), "")], None, scale=1, wide=True))
    tiles = ART / "out" / "tiles-preview.png"
    items.append(item("tiles", "牌面（代码画的像素牌，四川用前 27 张）",
                      "万字用像素字体写（字准、小尺寸也认得出），筒是圆点、条是竹节，一条是小鸟。字牌和红五是给立直麻将准备的。想改哪里写在备注里（比如条子颜色、小鸟样子、牌背颜色）。",
                      [("v1", copy_in(tiles, "tiles"), "第一版（现在用的）")], "v1", scale=1, wide=True))
    if COVERS.exists():
        items.append(item("cover", "大厅卡片封面",
                          "384×192，统一的封面画风。中间那张（s812）牌上有乱码字母数字，没放进来。原图上下有黑边，导出时裁掉了。",
                          [(f"s{s}", copy_in(COVERS / f"mahjong-s{s}.png", "covers"), label) for s, label in
                           ((813, "一圈麻将牌、竹椅、灯笼（现在用的）"), (811, "红地毯、牌像骨牌"))],
                          "s813", scale=1))
    return {
        "round": "r1",
        "title": "麻将 · 第一轮：场景、头像、牌面、封面",
        "updated": time.strftime("%m-%d %H:%M"),
        "spent": pixellab.spent_usd(),
        "intro": ("四川麻将已经能玩、也上线了，美术先用我挑的（每项标「推荐」的就是现在用的）。\n"
                  "每项点「选这张」，或者「都不满意，重画」并写备注。最后把页面底部那段文字复制给我。"),
        "preview": [],
        "items": items,
    }


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    data = build()
    shots = OUT / "shots"
    if shots.exists():
        data["preview"] = [{"src": f"shots/{p.name}", "caption": caption} for p, caption in [
            (shots / "table-night.png", "牌桌 · 夜间版（1440×790，血流成河后半盘）"),
            (shots / "table-day.png", "牌桌 · 白天版（1024×690）"),
            (shots / "home.png", "首页"),
        ] if p.exists()]
    (OUT / "gallery.json").write_text(json.dumps(data, ensure_ascii=False, indent=1))
    shutil.copyfile(ART / "gallery.html", OUT / "gallery.html")
    print("gallery ok, items", len(data["items"]), "spent", round(pixellab.spent_usd(), 4))
