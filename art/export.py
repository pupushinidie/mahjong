"""把 selection.json 里选中的美术导出到 apps/web/public/art/（牌面图集由 tiles.py 导出）。

用法：python art/export.py
"""
import json
import shutil
from pathlib import Path

from PIL import Image

ART = Path(__file__).resolve().parent
OUT = ART.parent / "apps/web/public/art"
R1 = ART / "out/r1"


def trim_avatar(src: Path, dst: Path) -> None:
    """头像：32×32 透明底，原样导出（只按整数倍显示）。"""
    image = Image.open(src).convert("RGBA")
    assert image.size == (32, 32), image.size
    image.save(dst)


def main() -> None:
    selection = json.loads((ART / "selection.json").read_text())
    OUT.mkdir(parents=True, exist_ok=True)
    for key in ("scene-night", "scene-day"):
        shutil.copyfile(R1 / f"{selection[key]}.png", OUT / f"{key}.png")
    for seat, index in enumerate(selection["avatars"]):
        name = "avatar.png" if index == 0 else f"avatar-{index}.png"
        trim_avatar(R1 / "avatar" / name, OUT / f"avatar-{seat}.png")
    print("exported to", OUT)


if __name__ == "__main__":
    main()
