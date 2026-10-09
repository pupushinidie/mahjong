"""麻将美术第一轮：四川麻将的茶馆场景和座位头像。结果在 out/r1/。

- 牌面由 tiles.py 用代码画（字要准）。
- 场景（牌桌后面的背景）用 /create-image-pixen 512×288，每种 4 个种子；夜间是灯笼暖光的老茶馆，白天是竹帘透进阳光的茶馆。
  牌桌的绿呢方阵盖在场景中间，两边和四角露出场景。
- 头像用 /generate-image-v2（32px，一次 64 个候选），挑 4 个当座位头像（等候房间、牌桌名牌）。
PixelLab 同一时间只跑一个任务，按顺序来。

用法：python art/r1.py [名字 ...]（不写就全跑；已经出过的跳过）
"""
from __future__ import annotations

import sys

import pixellab

OUT = pixellab.ART / "out" / "r1"

SCENES: dict[str, tuple[str, tuple[int, ...]]] = {
    "teahouse-night": (
        "interior of an old Chengdu teahouse at night, dark wooden beams and lattice windows, rows of glowing red paper lanterns, "
        "bamboo chairs, low wooden tea tables with white porcelain gaiwan tea cups, warm orange lantern light, cozy, no people, no text, wide view",
        (31, 32, 33, 34),
    ),
    "teahouse-day": (
        "interior of an old Chengdu teahouse on a sunny afternoon, bamboo blinds letting in soft sunlight, green potted plants, "
        "wooden tea tables with white porcelain gaiwan tea cups and a bowl of sunflower seeds, bamboo chairs, bright and airy, no people, no text, wide view",
        (41, 42, 43, 44),
    ),
}

SPRITES: dict[str, tuple[str, int, int, bool]] = {
    "avatar": (
        "cute pixel art portrait of a friendly teahouse regular for a game avatar, head and shoulders, front view, big eyes, "
        "chinese style clothing, colorful, simple background removed",
        32,
        32,
        True,
    ),
}


def scene(name: str) -> None:
    prompt, seeds = SCENES[name]
    for seed in seeds:
        target = f"{name}-s{seed}"
        if (OUT / f"{target}.png").exists():
            continue
        pixellab.generate_image(target, {
            "description": prompt,
            "image_size": {"width": 512, "height": 288},
            "detail": "highly detailed",
            "seed": seed,
        }, OUT, endpoint="/create-image-pixen")
        print(target, "ok; spent", round(pixellab.spent_usd(), 4), flush=True)


def sprite(name: str) -> None:
    prompt, width, height, transparent = SPRITES[name]
    folder = OUT / name
    if folder.exists() and any(folder.glob("*.png")):
        print(name, "已有，跳过", flush=True)
        return
    pixellab.generate_async(name, {
        "description": prompt,
        "image_size": {"width": width, "height": height},
        "no_background": transparent,
        "seed": 801,
    }, folder, endpoint="/generate-image-v2")


if __name__ == "__main__":
    names = sys.argv[1:] or [*SCENES, *SPRITES]
    for name in names:
        try:
            if name in SPRITES:
                sprite(name)
            else:
                scene(name)
        except Exception as error:  # 一项失败不影响后面的
            print(name, "失败：", error, flush=True)
            continue
        print(name, "done; spent", round(pixellab.spent_usd(), 4), flush=True)
