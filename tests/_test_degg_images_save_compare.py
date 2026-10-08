"""Функциональный тест Degg_Images_Save_Compare (Python).

Проверяет ноду headless: структуру INPUT_TYPES, режимы Save/Preview, батч,
метаданные PNG, UI-контракт (свои ключи вместо "images") и хелперы путей.
Folder_paths / comfy.cli_args подменяются заглушками, сами tensors — реальный torch.

Запуск: cd Degg_Images_Save_Compare && python tests/_test_degg_images_save_compare.py
"""

import os
import subprocess
import sys
from pathlib import Path

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def _p(text):
    try:
        enc = sys.stdout.encoding or "utf-8"
        sys.stdout.write(str(text).encode(enc, "replace").decode(enc, "replace") + "\n")
    except Exception:
        try:
            sys.stdout.write(str(text) + "\n")
        except Exception:
            pass


def _reexec_with_torch():
    try:
        import torch  # noqa: F401
        return
    except ImportError:
        pass
    cand = os.environ.get("COMFY_PY") or r"D:\ComfyUI_windows_portable\python_embeded\python.exe"
    me = Path(__file__).resolve()
    if cand and os.path.exists(cand) and os.path.abspath(cand) != os.path.abspath(sys.executable):
        try:
            probe = subprocess.run([cand, "-c", "import torch"], capture_output=True, timeout=180)
        except Exception:
            probe = None
        if probe is not None and probe.returncode == 0:
            r = subprocess.run([cand, str(me)], capture_output=True)
            sys.stdout.write(r.stdout.decode("utf-8", "replace"))
            sys.stderr.write(r.stderr.decode("utf-8", "replace"))
            sys.stdout.flush()
            sys.exit(r.returncode)
    _p("ТЕСТ НЕ ЗАПУЩЕН: нет интерпретатора с torch")
    _p("FAIL: 1")
    sys.exit(1)


_reexec_with_torch()

import importlib.util  # noqa: E402
import shutil  # noqa: E402
import tempfile  # noqa: E402
import types  # noqa: E402

import torch  # noqa: E402
from PIL import Image  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
NODE = ROOT / "degg_images_save_compare.py"

fails = []
oks = []


def check(name, cond, extra=""):
    (oks if cond else fails).append(name)
    _p(("  ok  " if cond else "  FAIL") + f"  {name}" + (f"  [{extra}]" if extra and not cond else ""))


# ── заглушки ComfyUI (реальный torch/PIL/numpy) ───────────────────────────
TMP = Path(tempfile.mkdtemp(prefix="degg_dsc_"))
OUT_DIR = TMP / "output"
TEMP_DIR = TMP / "temp"
IN_DIR = TMP / "input"
for d in (OUT_DIR, TEMP_DIR, IN_DIR):
    d.mkdir(parents=True, exist_ok=True)

_installs = []


def install_fakes(disable_metadata=True):
    fp = types.ModuleType("folder_paths")
    fp.get_output_directory = lambda: str(OUT_DIR)
    fp.get_temp_directory = lambda: str(TEMP_DIR)
    fp.get_input_directory = lambda: str(IN_DIR)

    def get_save_image_path(prefix, out_dir, width=0, height=0, filename=None):
        os.makedirs(out_dir, exist_ok=True)
        head = os.path.basename(prefix)
        folder = os.path.join(out_dir, os.path.dirname(prefix)) if os.path.dirname(prefix) else out_dir
        os.makedirs(folder, exist_ok=True)
        existing = [f for f in os.listdir(folder) if f.startswith(head + "_")]
        return folder, head, len(existing) + 1, "", head

    fp.get_save_image_path = get_save_image_path

    cli = types.ModuleType("comfy.cli_args")
    cli.args = types.SimpleNamespace(disable_metadata=disable_metadata)
    comfy = types.ModuleType("comfy")
    comfy.cli_args = cli

    sys.modules["folder_paths"] = fp
    sys.modules["comfy"] = comfy
    sys.modules["comfy.cli_args"] = cli
    _installs.append(fp)


install_fakes(disable_metadata=True)

_spec = importlib.util.spec_from_file_location("degg_images_save_compare", NODE)
node = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(node)

NODE_KEY = "Degg_Images_Save_Compare"


def make_img(batch=1, h=4, w=6, channels=3):
    rows = torch.arange(h, dtype=torch.float32).view(h, 1).expand(h, w)
    cols = torch.arange(w, dtype=torch.float32).view(1, w).expand(h, w)
    pix = (rows * 10 + cols).view(1, h, w, 1).expand(1, h, w, channels).contiguous()
    return pix.repeat(batch, 1, 1, 1) / 255.0


def ui_list(res):
    return res["ui"]["degg_compare_images"]


# ── 1. импорт без ComfyUI ─────────────────────────────────────────────────
import re  # noqa: E402

SRC = NODE.read_text(encoding="utf-8")
top_level_heavy = re.findall(
    r"^(?:import|from)\s+(folder_paths|server|aiohttp|numpy|PIL|comfy)\b", SRC, re.M)
check("нет тяжёлых импортов на уровне модуля (folder_paths/server/numpy/PIL/comfy)",
      not top_level_heavy, str(top_level_heavy))
check("folder_paths импортируется лениво (внутри функций)",
      re.search(r"^\s+import folder_paths$", SRC, re.M) is not None)
check("register_routes не падает без ComfyUI", callable(node.register_routes))

# ── 2. INPUT_TYPES ────────────────────────────────────────────────────────
it = node.DeggImagesSaveCompare.INPUT_TYPES()
req = it["required"]
opt = it["optional"]

check("INPUT_TYPES: image_1 обязателен и IMAGE", req["image_1"][0] == "IMAGE")
check("INPUT_TYPES: image_2 опционален и IMAGE", opt["image_2"][0] == "IMAGE")
check("INPUT_TYPES: save_mode по умолчанию True (Save)", req["save_mode"][1]["default"] is True)
check("INPUT_TYPES: save_mode подписи Save/Preview",
      req["save_mode"][1]["label_on"] == "Save" and req["save_mode"][1]["label_off"] == "Preview")
check("INPUT_TYPES: порядок виджетов save_mode → filename_prefix → mode → opacity → blink_speed",
      [k for k in req if k != "image_1"] == ["save_mode", "filename_prefix", "mode", "opacity", "blink_speed"],
      str(list(req)))
check("INPUT_TYPES: 6 режимов, Off первым (по умолчанию просмотрщик)",
      req["mode"][0] == ["Off", "Slider", "Side-by-Side", "Overlap", "Difference", "Blink"],
      str(req["mode"][0]))
check("INPUT_TYPES: режим по умолчанию — Off",
      req["mode"][1].get("default") == "Off",
      str(req["mode"][1].get("default")))
check("INPUT_TYPES: opacity 0..1, blink_speed 1..3",
      req["opacity"][1]["min"] == 0.0 and req["opacity"][1]["max"] == 1.0
      and req["blink_speed"][1]["min"] == 1.0 and req["blink_speed"][1]["max"] == 3.0)
check("INPUT_TYPES: нет входa output_path (убран по задаче)", "output_path" not in req and "output_path" not in opt)
check("INPUT_TYPES: hidden prompt/extra_pnginfo",
      it["hidden"]["prompt"] == "PROMPT" and it["hidden"]["extra_pnginfo"] == "EXTRA_PNGINFO")

# ── 3. класс и маппинги ───────────────────────────────────────────────────
check("класс: RETURN_TYPES = (IMAGE,)", node.DeggImagesSaveCompare.RETURN_TYPES == ("IMAGE",))
check("класс: RETURN_NAMES = (image_1,)", node.DeggImagesSaveCompare.RETURN_NAMES == ("image_1",))
check("класс: FUNCTION = save_compare", node.DeggImagesSaveCompare.FUNCTION == "save_compare")
check("класс: OUTPUT_NODE = True", node.DeggImagesSaveCompare.OUTPUT_NODE is True)
check("класс: CATEGORY", node.DeggImagesSaveCompare.CATEGORY == "My_custom_nodes/Image")
check("маппинг класса", node.NODE_CLASS_MAPPINGS.get(NODE_KEY) is node.DeggImagesSaveCompare)
check("маппинг имени", NODE_KEY in node.NODE_DISPLAY_NAME_MAPPINGS)
# Задача 2 (красная): отображаемое имя ноды в меню ComfyUI.
check("T2: отображаемое имя «Degg Images Save/Compare»",
      node.NODE_DISPLAY_NAME_MAPPINGS.get(NODE_KEY) == "Degg Images Save/Compare",
      str(node.NODE_DISPLAY_NAME_MAPPINGS))
check("WEB_DIRECTORY = web", node.WEB_DIRECTORY == "web")
check("JS-файл существует", (ROOT / "web" / "js" / "degg_images_save_compare.js").is_file())

# ── 4. хелперы ────────────────────────────────────────────────────────────
sfx = node.random_suffix()
check("random_suffix: 5 символов из алфавита",
      len(sfx) == 5 and all(c in node.ALPHABET for c in sfx))

try:
    node.open_file_in_viewer(str(TMP / "nope.png"))
    check("open_file_in_viewer: отсутствующий файл → FileNotFoundError", False)
except FileNotFoundError:
    check("open_file_in_viewer: отсутствующий файл → FileNotFoundError", True)
except Exception as e:
    check("open_file_in_viewer: отсутствующий файл → FileNotFoundError", False, repr(e))

# ── 5. save_compare: Save mode ────────────────────────────────────────────
install_fakes(disable_metadata=False)
N = node.DeggImagesSaveCompare()
img1 = make_img(batch=1)
res = N.save_compare(img1, save_mode=True, filename_prefix="TestPrefix",
                     mode="Slider", prompt={"1": {"class_type": "X"}})

check("Save: результат — тот же tensor Image 1", res["result"][0] is img1)
check("Save: ui без ключа images (фронтенд не рисует своё превью)", "images" not in res["ui"])
check("Save: ui.degg_open_path заполнен", bool(res["ui"]["degg_open_path"][0]))
check("Save: одна запись в degg_compare_images", len(ui_list(res)) == 1)
one = ui_list(res)[0]
check("Save: slot = 1", one["slot"] == 1)
check("Save: type = output", one["type"] == "output")
check("Save: имя с префиксом", one["filename"].startswith("TestPrefix_"))
check("Save: файл лежит в output-каталоге",
      os.path.dirname(one["full_path"]) == str(OUT_DIR))
check("Save: файл создан", os.path.isfile(one["full_path"]))
check("Save: размеры в записи", one["width"] == 6 and one["height"] == 4)
check("Save: open_path == путь Image 1", res["ui"]["degg_open_path"][0] == one["full_path"])

with Image.open(one["full_path"]) as im:
    check("Save: PNG 6x4", im.size == (6, 4))
    check("Save: метаданные prompt записаны", '"class_type": "X"' in (im.text or {}).get("prompt", ""))

# ── 6. save_compare: Preview mode ─────────────────────────────────────────
N2 = node.DeggImagesSaveCompare()
res_prev = N2.save_compare(make_img(), save_mode=False, filename_prefix="TestPrefix", mode="Slider")
prev = ui_list(res_prev)[0]
check("Preview: type = temp", prev["type"] == "temp")
check("Preview: файл во временной папке", os.path.dirname(prev["full_path"]) == str(TEMP_DIR))
check("Preview: префикс _temp", os.path.basename(prev["full_path"]).startswith("_temp"))
check("Preview: префикс виджета игнорируется", "TestPrefix" not in prev["filename"])
check("Preview: open_path ведёт в temp", res_prev["ui"]["degg_open_path"][0] == prev["full_path"])

# ── 7. батч Image 1 ───────────────────────────────────────────────────────
N3 = node.DeggImagesSaveCompare()
res_b = N3.save_compare(make_img(batch=3), save_mode=True, filename_prefix="Batch")
check("Батч: запись в ui — только первый кадр",
      len(ui_list(res_b)) == 1 and ui_list(res_b)[0]["filename"].endswith("00001_.png"))
saved_files = sorted(f for f in os.listdir(OUT_DIR) if f.startswith("Batch_"))
check("Батч: все 3 кадра на диске", len(saved_files) == 3, str(saved_files))

# ── 8. Image 2 ────────────────────────────────────────────────────────────
N4 = node.DeggImagesSaveCompare()
res2 = N4.save_compare(make_img(), mode="Overlap", save_mode=True,
                       filename_prefix="WithTwo", image_2=make_img(batch=3, h=2, w=3))
slots = {r["slot"]: r for r in ui_list(res2)}
check("Image 2: две записи (slot 1 и 2)", sorted(slots) == [1, 2])
check("Image 2: slot 2 всегда temp", slots[2]["type"] == "temp")
check("Image 2: в temp", os.path.dirname(slots[2]["full_path"]) == str(TEMP_DIR))
check("Image 2: префикс _deggcmp2", os.path.basename(slots[2]["full_path"]).startswith("_deggcmp2"))
check("Image 2: только первый кадр батча (2x3)", slots[2]["width"] == 3 and slots[2]["height"] == 2)
check("Image 2: Image 1 в output (Save)", slots[1]["type"] == "output")

# ── 9. кривой режим не роняет ноду ────────────────────────────────────────
try:
    N5 = node.DeggImagesSaveCompare()
    res_bad = N5.save_compare(make_img(), mode="НетТакого", save_mode=True, filename_prefix="Bad")
    check("Неизвестный режим не роняет save_compare", len(ui_list(res_bad)) == 1)
except Exception as e:
    check("Неизвестный режим не роняет save_compare", False, repr(e))

# ── 10. метаданные выключены ──────────────────────────────────────────────
install_fakes(disable_metadata=True)
N6 = node.DeggImagesSaveCompare()
res_nm = N6.save_compare(make_img(), save_mode=True, filename_prefix="NoMeta", prompt={"x": 1})
with Image.open(ui_list(res_nm)[0]["full_path"]) as im:
    check("--disable-metadata: промпт в PNG не пишется", not (im.text or {}).get("prompt"))

# ── 11. регистрация роутов (заглушка server вместо ComfyUI) ───────────────
# Задача 1 (красная): роуты сохранения удалены вместе с кнопкой.
check("T1: python-роут save_compare удалён",
      "/degg_images_save_compare/save_compare" not in SRC)
check("T1: python-роут save_blink_gif удалён",
      "/degg_images_save_compare/save_blink_gif" not in SRC)

# Проверяем САМ механизм: с реальным aiohttp и поддельным PromptServer
# register_routes() обязан повесить ровно 1 async-обработчик (open_file),
# который дёргает JS (иначе кнопка молча не работает — 404 без ошибки в UI).
try:
    import aiohttp  # noqa: F401
    _has_aiohttp = True
except ImportError:
    _has_aiohttp = False

if _has_aiohttp:
    handlers = {}

    class FakeRoutes:
        def post(self, path):
            def deco(fn):
                handlers[path] = fn
                return fn
            return deco

    class FakePromptServer:
        instance = types.SimpleNamespace(routes=FakeRoutes())

    fake_server = types.ModuleType("server")
    fake_server.PromptServer = FakePromptServer
    sys.modules["server"] = fake_server

    node.register_routes()

    expected_routes = sorted([
        "/degg_images_save_compare/open_file",
    ])
    check("register_routes: 1 роут (open_file)",
          sorted(handlers) == expected_routes, str(sorted(handlers)))
    import asyncio
    check("register_routes: все обработчики — async def",
          bool(handlers) and all(asyncio.iscoroutinefunction(f) for f in handlers.values()))
else:
    _p("  ..  aiohttp недоступен — проверка регистрации роутов пропущена")

shutil.rmtree(str(TMP), ignore_errors=True)

_p(f"\nИТОГО: ок={len(oks)} FAIL: {len(fails)}")
if fails:
    for f in fails:
        _p("  - " + f)
    sys.exit(1)
_p("ТЕСТ ПРОЙДЕН")
sys.exit(0)
