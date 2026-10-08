# -*- coding: utf-8 -*-
"""
Degg_Images_Save_Compare — один узел вместо двух:

  • сохранение/превью основного изображения (как Custom_node_Images /
    SavePreviewImage): Save -> output с префиксом, Preview -> temp;
  • интерактивное сравнение двух изображений (как ↔️ OreX Image Compare):
    режимы Slider / Side-by-Side / Overlap / Difference / Blink,
    кнопка «Сохранить текущий вид» (роуты save_compare / save_blink_gif),
    кнопка открытия Image 1 в программе просмотра Windows по умолчанию.

Входы:  Image 1 (основное, проходное), Image 2 (для сравнения).
Выход:  Image 1.

Фронтенд: web/js/degg_images_save_compare.js

⛔ Модуль ОБЯЗАН импортироваться без ComfyUI (tests/_test_*.py):
   numpy / PIL / folder_paths / comfy.cli_args / server / aiohttp
   импортируются ЛЕНИВО, внутри функций; роуты регистрируются в try/except
   (нет ComfyUI — просто нет роутов, импорт не падает).
"""

import base64
import datetime
import glob
import json
import logging
import os
import random
import re

logger = logging.getLogger(__name__)

ALPHABET = "abcdefghijklmnopqrstuvwxyz"

# Режим сравнения -> подпапка для «как видишь» (output/<дата>/<подпапка>/)
MODE_FOLDER_MAP = {
    "Slider": "slider",
    "Side-by-Side": "sidebyside",
    "Overlap": "overlap",
    "Difference": "difference",
    "Blink": "blink",
    "Off": "off",
}

MODES = ["Off", "Slider", "Side-by-Side", "Overlap", "Difference", "Blink"]

# Тайминг GIF режима Blink: длительность одной фазы (мс) и число кадров
# кроссфейда на переход. Полный цикл A->B->A = 2 * BLINK_PHASE_MS.
BLINK_PHASE_MS = 1500
BLINK_TRANSITION_FRAMES = 10

# Имя файлов, которые сохраняет кнопка «Сохранить текущий вид»
COMPARE_STEM = "Degg_Compare"

NODE_KEY = "Degg_Images_Save_Compare"


# ─────────────────────────────────────────────────────────────────────────────
#  Хелперы (без тяжёлых импортов на уровне модуля)
# ─────────────────────────────────────────────────────────────────────────────

def random_suffix(n: int = 5) -> str:
    return "".join(random.choice(ALPHABET) for _ in range(n))


def today_folder() -> str:
    """Актуальная дата на момент вызова (не дата старта сервера)."""
    return datetime.datetime.now().strftime("%Y-%m-%d")


def ensure_mode_dir(mode_key: str) -> str:
    """output/<дата>/<режим>/ — создаёт при необходимости, возвращает путь."""
    import folder_paths

    mode_dir = os.path.join(folder_paths.get_output_directory(), today_folder(), mode_key)
    os.makedirs(mode_dir, exist_ok=True)
    return mode_dir


def next_counter(mode_dir: str, suffix: str, ext: str) -> int:
    """Отдельный счётчик на каждый режим: сканирует папку и берёт max+1."""
    pattern = os.path.join(mode_dir, f"{COMPARE_STEM}_{suffix}_*.{ext}")
    rx = re.compile(rf"{re.escape(COMPARE_STEM)}_{re.escape(suffix)}_(\d+)\.{re.escape(ext)}$")
    max_idx = 0
    for fp in glob.glob(pattern):
        m = rx.search(os.path.basename(fp))
        if m:
            max_idx = max(max_idx, int(m.group(1)))
    return max_idx + 1


def resolve_source_path(filename: str, subfolder: str, img_type: str) -> str:
    """Полный путь к уже сохранённому исходнику (temp / output / input)."""
    import folder_paths

    if img_type == "temp":
        root = folder_paths.get_temp_directory()
    elif img_type == "input":
        root = folder_paths.get_input_directory()
    else:
        root = folder_paths.get_output_directory()
    return os.path.join(root, subfolder, filename) if subfolder else os.path.join(root, filename)


def open_file_in_viewer(filepath: str):
    """
    Открывает файл программой по умолчанию (Windows Explorer / просмотрщик).
    Бросает FileNotFoundError, если файла нет, и RuntimeError вне Windows.
    """
    if not hasattr(os, "startfile"):
        raise RuntimeError("Открытие файла поддерживается только в Windows")
    if not os.path.isfile(filepath):
        raise FileNotFoundError(filepath)
    os.startfile(filepath)


# ─────────────────────────────────────────────────────────────────────────────
#  Нода
# ─────────────────────────────────────────────────────────────────────────────

class DeggImagesSaveCompare:
    """
    Save/Preview основного изображения + интерактивное сравнение двух кадров.

    Save mode (по умолчанию) — Image 1 пишется в output/ с префиксом.
    Preview mode             — Image 1 пишется во временную папку (temp).
    Image 2 всегда пишется в temp: она нужна только для сравнения (и для GIF
    режима Blink, который собирается на бэкенде из исходников на диске).
    """

    def __init__(self):
        self.prefix_append = "_deggcmp_" + random_suffix()
        self.compress_level = 4

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # IMAGE-сокеты рисуются над виджетами в порядке объявления
                "image_1": ("IMAGE", {
                    "tooltip": "Основное изображение: сохраняется/превью и уходит на выход."
                }),
                # порядок виджетов = порядок объявления (сверху вниз)
                "save_mode": ("BOOLEAN", {
                    "default": True,
                    "label_on": "Save",
                    "label_off": "Preview",
                    "tooltip": "Save — в output с префиксом; Preview — во временную папку."
                }),
                "filename_prefix": ("STRING", {
                    "default": "ComfyUI",
                    "tooltip": "Префикс файла Image 1 (используется только в режиме Save)."
                }),
                "mode": (MODES, {
                    "default": "Off",
                    "tooltip": "Режим сравнения Image 1 и Image 2 (Off — просмотрщик Image 1, по умолчанию)."
                }),
                "opacity": ("FLOAT", {
                    "default": 0.5,
                    "min": 0.0,
                    "max": 1.0,
                    "step": 0.01,
                    "display": "slider",
                    "tooltip": "Непрозрачность Image 1 в режиме Overlap."
                }),
                "blink_speed": ("FLOAT", {
                    "default": 1.0,
                    "min": 1.0,
                    "max": 3.0,
                    "step": 0.05,
                    "display": "slider",
                    "tooltip": "Длительность фазы мигания в режиме Blink, сек."
                }),
            },
            "optional": {
                "image_2": ("IMAGE", {
                    "tooltip": "Изображение для сравнения (только для просмотра)."
                }),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image_1",)
    FUNCTION = "save_compare"
    OUTPUT_NODE = True
    CATEGORY = "My_custom_nodes/Image"
    DESCRIPTION = (
        "Save/Preview основного изображения и интерактивное сравнение с вторым "
        "(Slider / Side-by-Side / Overlap / Difference / Blink)."
    )

    # ── сохранение ───────────────────────────────────────────────────────────

    def _save_batch(self, tensor, out_dir, prefix, img_type, compress_level,
                    prompt=None, extra_pnginfo=None):
        """Пишет весь батч тензора как PNG. Возвращает список записей для UI."""
        import numpy as np
        import folder_paths
        from PIL import Image
        from PIL.PngImagePlugin import PngInfo
        from comfy.cli_args import args

        height = int(tensor[0].shape[0])
        width = int(tensor[0].shape[1])
        full_output_folder, filename, counter, subfolder, _ = folder_paths.get_save_image_path(
            prefix, out_dir, width, height
        )

        metadata = None
        if not args.disable_metadata:
            metadata = PngInfo()
            if prompt is not None:
                metadata.add_text("prompt", json.dumps(prompt))
            if extra_pnginfo is not None:
                for key in extra_pnginfo:
                    metadata.add_text(key, json.dumps(extra_pnginfo[key]))

        results = []
        for batch_number, image in enumerate(tensor):
            arr = 255.0 * image.cpu().numpy()
            img = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))
            name = filename.replace("%batch_num%", str(batch_number))
            file = f"{name}_{counter:05}_.png"
            full_path = os.path.join(full_output_folder, file)
            img.save(full_path, pnginfo=metadata, compress_level=compress_level)
            results.append({
                "filename": file,
                "subfolder": subfolder,
                "type": img_type,
                "full_path": full_path,
                "width": width,
                "height": height,
            })
            counter += 1
        return results

    def save_compare(self, image_1, save_mode=True, filename_prefix="ComfyUI",
                     mode="Slider", opacity=0.5, blink_speed=1.0,
                     image_2=None, prompt=None, extra_pnginfo=None):
        import folder_paths

        if mode not in MODE_FOLDER_MAP:
            mode = "Slider"

        ui_images = []
        open_path = ""

        # ── Image 1: по режиму Save/Preview (как SavePreviewImage) ──────────
        if image_1 is not None:
            if save_mode:
                saved1 = self._save_batch(
                    image_1,
                    folder_paths.get_output_directory(),
                    filename_prefix,
                    "output",
                    self.compress_level,
                    prompt,
                    extra_pnginfo,
                )
            else:
                saved1 = self._save_batch(
                    image_1,
                    folder_paths.get_temp_directory(),
                    "_temp" + self.prefix_append,
                    "temp",
                    1,
                    prompt,
                    extra_pnginfo,
                )
            first = dict(saved1[0])
            first["slot"] = 1
            ui_images.append(first)
            open_path = first["full_path"]

        # ── Image 2: всегда temp, только первый кадр (нужна для сравнения) ──
        if image_2 is not None:
            saved2 = self._save_batch(
                image_2[:1],
                folder_paths.get_temp_directory(),
                "_deggcmp2" + self.prefix_append,
                "temp",
                1,
                prompt,
                extra_pnginfo,
            )
            second = dict(saved2[0])
            second["slot"] = 2
            ui_images.append(second)

        # Свои ключи вместо "images": фронтенд не должен рисовать СВОЁ превью
        # (у ноды собственный холст сравнения — иначе два превью подряд).
        return {
            "ui": {
                "degg_compare_images": ui_images,
                "degg_open_path": [open_path],
            },
            "result": (image_1,),
        }


NODE_CLASS_MAPPINGS = {NODE_KEY: DeggImagesSaveCompare}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_KEY: "Degg Images Save_Compare"}
WEB_DIRECTORY = "web"
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]


# ─────────────────────────────────────────────────────────────────────────────
#  HTTP-роуты: открытие файла в Windows-просмотрщике + сохранение «как видишь»
# ─────────────────────────────────────────────────────────────────────────────

def register_routes():
    """Регистрирует роуты. Без ComfyUI/aiohttp молча выходит (импорт модуля жив)."""
    try:
        from aiohttp import web
        from server import PromptServer
    except Exception:
        return

    instance = getattr(PromptServer, "instance", None)
    if instance is None:
        return
    routes = instance.routes

    @routes.post("/degg_images_save_compare/open_file")
    async def degg_open_file(request):
        """Открывает файл из output/temp программой Windows по умолчанию."""
        import folder_paths

        try:
            data = await request.json()
            filepath = (data.get("path") or "").strip()
            if not filepath:
                return web.json_response({"success": False, "error": "No path"}, status=400)

            filepath = os.path.normpath(filepath)
            allowed = (
                os.path.normpath(folder_paths.get_output_directory()),
                os.path.normpath(folder_paths.get_temp_directory()),
            )
            if not filepath.startswith(allowed):
                return web.json_response({"success": False, "error": "Access denied"}, status=403)

            open_file_in_viewer(filepath)
            return web.json_response({"success": True, "path": filepath})
        except FileNotFoundError:
            return web.json_response({"success": False, "error": "Not found"}, status=404)
        except Exception as e:
            logger.error("[Degg Save_Compare] Ошибка открытия файла: %s", e)
            return web.json_response({"success": False, "error": str(e)}, status=500)

    @routes.post("/degg_images_save_compare/save_compare")
    async def degg_save_compare(request):
        """
        Принимает снимок холста (JPEG в base64) для режимов Slider /
        Side-by-Side / Overlap / Difference и сохраняет его в
        output/<дата>/<режим>/Degg_Compare_<суффикс>_NNNNN.jpg.
        """
        try:
            data = await request.json()
            mode = data.get("mode")
            image_data_url = data.get("image", "")

            suffix = MODE_FOLDER_MAP.get(mode)
            if not suffix or suffix == "blink":
                return web.json_response(
                    {"success": False, "error": f"Недопустимый режим для этого роута: {mode}"},
                    status=400,
                )

            if "," in image_data_url:
                image_data_url = image_data_url.split(",", 1)[1]
            jpg_bytes = base64.b64decode(image_data_url)

            mode_dir = ensure_mode_dir(suffix)
            idx = next_counter(mode_dir, suffix, "jpg")
            file_name = f"{COMPARE_STEM}_{suffix}_{idx:05}.jpg"
            file_path = os.path.join(mode_dir, file_name)

            with open(file_path, "wb") as f:
                f.write(jpg_bytes)

            logger.info("[Degg Save_Compare] Сохранён снимок: %s", file_path)
            return web.json_response({"success": True, "path": file_path, "filename": file_name})
        except Exception as e:
            logger.error("[Degg Save_Compare] Ошибка сохранения снимка: %s", e)
            return web.json_response({"success": False, "error": str(e)}, status=500)

    @routes.post("/degg_images_save_compare/save_blink_gif")
    async def degg_save_blink_gif(request):
        """
        Собирает зацикленный GIF из двух исходников, уже сохранённых узлом при
        выполнении схемы. Плавный кроссфейд A -> B -> A с фиксированным циклом
        (BLINK_PHASE_MS), независимым от виджета blink_speed.
        """
        try:
            from PIL import Image

            data = await request.json()
            meta1 = data.get("img1")
            meta2 = data.get("img2")

            if not meta1 or not meta2:
                return web.json_response(
                    {"success": False, "error": "Нужны оба изображения (Image 1 и Image 2)"},
                    status=400,
                )

            path1 = resolve_source_path(meta1["filename"], meta1.get("subfolder", ""),
                                        meta1.get("type", "temp"))
            path2 = resolve_source_path(meta2["filename"], meta2.get("subfolder", ""),
                                        meta2.get("type", "temp"))

            frame_a = Image.open(path1).convert("RGB")
            frame_b = Image.open(path2).convert("RGB")
            if frame_b.size != frame_a.size:
                frame_b = frame_b.resize(frame_a.size)

            static_ms = round(BLINK_PHASE_MS * 2 / 3)
            transition_ms = round(BLINK_PHASE_MS * 1 / 3)
            n = max(1, BLINK_TRANSITION_FRAMES)
            per_frame_ms = max(20, round(transition_ms / n))

            # Общая палитра на все кадры — иначе каждый кадр квантуется отдельно
            # и при воспроизведении видно цветовое мерцание.
            combined = Image.new("RGB", (frame_a.width * 2, frame_a.height))
            combined.paste(frame_a, (0, 0))
            combined.paste(frame_b, (frame_a.width, 0))
            shared_palette = combined.quantize(colors=256)

            def to_gif_frame(img):
                return img.quantize(palette=shared_palette, dither=Image.FLOYDSTEINBERG)

            frames = [to_gif_frame(frame_a)]
            durations = [static_ms]
            for i in range(1, n + 1):
                frames.append(to_gif_frame(Image.blend(frame_a, frame_b, i / (n + 1))))
                durations.append(per_frame_ms)
            frames.append(to_gif_frame(frame_b))
            durations.append(static_ms)
            for i in range(1, n + 1):
                frames.append(to_gif_frame(Image.blend(frame_b, frame_a, i / (n + 1))))
                durations.append(per_frame_ms)

            mode_dir = ensure_mode_dir("blink")
            idx = next_counter(mode_dir, "blink", "gif")
            file_name = f"{COMPARE_STEM}_blink_{idx:05}.gif"
            file_path = os.path.join(mode_dir, file_name)

            frames[0].save(
                file_path,
                save_all=True,
                append_images=frames[1:],
                duration=durations,
                loop=0,
                disposal=2,
            )

            logger.info("[Degg Save_Compare] Сохранён Blink GIF (%d кадров): %s",
                        len(frames), file_path)
            return web.json_response({"success": True, "path": file_path, "filename": file_name})
        except Exception as e:
            logger.error("[Degg Save_Compare] Ошибка сохранения Blink GIF: %s", e)
            return web.json_response({"success": False, "error": str(e)}, status=500)


register_routes()
