# -*- coding: utf-8 -*-
"""
Degg_Images_Save_Compare — один узел вместо двух:

  • сохранение/превью основного изображения (как Custom_node_Images /
    SavePreviewImage): Save -> output с префиксом, Preview -> temp;
  • интерактивное сравнение двух изображений (как ↔️ OreX Image Compare):
    режимы Slider / Side-by-Side / Overlap / Difference / Blink,
    кнопка открытия Image 1 в программе просмотра Windows по умолчанию.

Входы:  Image 1 (основное, проходное), Image 2 (для сравнения).
Выход:  Image 1.

Фронтенд: web/js/degg_images_save_compare.js

⛔ Модуль ОБЯЗАН импортироваться без ComfyUI (tests/_test_*.py):
   numpy / PIL / folder_paths / comfy.cli_args / server / aiohttp
   импортируются ЛЕНИВО, внутри функций; роуты регистрируются в try/except
   (нет ComfyUI — просто нет роутов, импорт не падает).
"""

import json
import logging
import os
import random

logger = logging.getLogger(__name__)

ALPHABET = "abcdefghijklmnopqrstuvwxyz"

MODES = ["Off", "Slider", "Side-by-Side", "Overlap", "Difference", "Blink"]

NODE_KEY = "Degg_Images_Save_Compare"


# ─────────────────────────────────────────────────────────────────────────────
#  Хелперы (без тяжёлых импортов на уровне модуля)
# ─────────────────────────────────────────────────────────────────────────────

def random_suffix(n: int = 5) -> str:
    return "".join(random.choice(ALPHABET) for _ in range(n))


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
    Image 2 всегда пишется в temp: она нужна только для сравнения
    (серверная сборка GIF удалена — задача T1).
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
                    "tooltip": "Main image: saved/previewed and passed to the output."
                }),
                # порядок виджетов = порядок объявления (сверху вниз)
                "save_mode": ("BOOLEAN", {
                    "default": True,
                    "label_on": "Save",
                    "label_off": "Preview",
                    "tooltip": "Save — into output with the prefix; Preview — into the temp folder."
                }),
                "filename_prefix": ("STRING", {
                    "default": "ComfyUI",
                    "tooltip": "Image 1 filename prefix (Save mode only)."
                }),
                "mode": (MODES, {
                    "default": "Off",
                    "tooltip": "Image 1 / Image 2 comparison mode (Off — Image 1 viewer, default)."
                }),
                "opacity": ("FLOAT", {
                    "default": 0.5,
                    "min": 0.0,
                    "max": 1.0,
                    "step": 0.01,
                    "display": "slider",
                    "tooltip": "Image 1 opacity in Overlap mode."
                }),
                "blink_speed": ("FLOAT", {
                    "default": 1.0,
                    "min": 1.0,
                    "max": 3.0,
                    "step": 0.05,
                    "display": "slider",
                    "tooltip": "Blink phase duration in Blink mode, sec."
                }),
            },
            "optional": {
                "image_2": ("IMAGE", {
                    "tooltip": "Image to compare with (view only)."
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
        "Save/Preview the main image and compare it interactively with a second one "
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

        if mode not in MODES:
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
NODE_DISPLAY_NAME_MAPPINGS = {NODE_KEY: "Degg Images Save/Compare"}
WEB_DIRECTORY = "web"
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]


# ─────────────────────────────────────────────────────────────────────────────
#  HTTP-роут: открытие файла в Windows-просмотрщике
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

register_routes()
