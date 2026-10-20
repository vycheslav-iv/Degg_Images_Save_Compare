"""Живая проба Degg_Images_Save_Compare: превью показывает СТАРОЕ.

Два сценария со слов пользователя (не связаны со сменой воркфлоу):

  S1. «Сгенерировал → удалил файл из папки вывода → сгенерировал ещё раз,
      превью не меняется».
      Механика: `folder_paths.get_save_image_path` считает counter по файлам в
      папке, поэтому после удаления ПОСЛЕДНЕГО файла новый прогон пишет файл с
      ТЕМ ЖЕ именем. В JS `slotShows()` сравнивает только
      filename/subfolder/type → решает «уже показано» и не трогает DOM, а
      браузерный кэш для того же URL вообще не перезагружает байты.

  S2. «Нода ушла за пределы экрана (увеличил другую часть графа) — новое
      изображение не появляется».
      Проверяем факты: доходит ли `executed` до ноды в Nodes 2.0 когда DOM
      ноды не в кадре; не снимается ли элемент (пересоздаётся ли <img>);
      показывает ли превью новый файл после возврата в кадр.

  S3. (гипотеза «откат») Если после нового файла приходит восстановление
      СТАРОГО выхода (ChangeTracker.restore со снимком), не откатывается ли
      превью назад.

Проверки печатаются как ok/FAIL; красный прогон ДО правки — база багфикса.

Запуск (ComfyUI должен быть запущен; Node.js/PIL не нужны — PIL в python_embeded):
    cd Degg_Images_Save_Compare
    python tests/_probe_live_stale.py --recon
    python tests/_probe_live_stale.py
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

CHROME_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    "/usr/bin/google-chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
]

NODE_TYPE = "Degg_Images_Save_Compare"
COMFY_URL = "http://127.0.0.1:8188/"
DEFAULT_TEMP = r"D:\ComfyUI_windows_portable\ComfyUI\temp"

# Файлы пробы: имя ФИКСИРОВАНО (это и есть предмет S1), размеры разные, чтобы
# факт подмены байтов читался по naturalWidth.
F_SAME = "_dsc_probe_same_00001_.png"     # 320x200, потом 480x160
F_OFF = "_dsc_probe_off_00002_.png"       # 640x360


def _force_utf8() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def _reexec_with_websockets() -> None:
    try:
        import websockets  # noqa: F401
        return
    except ImportError:
        pass

    me = Path(__file__).resolve()
    candidates = []
    env = os.environ.get("COMFY_PY")
    if env:
        candidates.append(env)
    candidates.append(r"D:\ComfyUI_windows_portable\python_embeded\python.exe")

    for cand in candidates:
        if not Path(cand).exists():
            continue
        probe = subprocess.run([cand, "-c", "import websockets"], capture_output=True)
        if probe.returncode == 0:
            r = subprocess.run([cand, str(me)] + sys.argv[1:], capture_output=True)
            sys.stdout.write(r.stdout.decode("utf-8", "replace"))
            sys.stderr.write(r.stderr.decode("utf-8", "replace"))
            sys.stdout.flush()
            sys.exit(r.returncode)

    print("ЖИВОЙ ЗАМЕР НЕ ЗАПУЩЕН: нет модуля websockets", flush=True)
    print("FAIL: 1", flush=True)
    sys.exit(1)


def find_chrome() -> str:
    env = os.environ.get("CHROME_PATH")
    if env and Path(env).exists():
        return env
    for p in CHROME_CANDIDATES:
        if Path(p).exists():
            return p
    raise SystemExit("Chrome не найден (задай CHROME_PATH)")


def wait_devtools(port: int, timeout: float = 30.0) -> dict:
    url = f"http://127.0.0.1:{port}/json/list"
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as r:
                pages = json.load(r)
            for p in pages:
                if p.get("type") == "page" and p.get("webSocketDebuggerUrl"):
                    return p
        except Exception:
            pass
        time.sleep(0.3)
    raise SystemExit("CDP не отвечает: страница не найдена")


class CDP:
    def __init__(self, ws):
        self.ws = ws
        self._id = 0

    async def call(self, method: str, params: dict | None = None):
        self._id += 1
        mid = self._id
        await self.ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
        while True:
            msg = json.loads(await self.ws.recv())
            if msg.get("id") == mid:
                if "error" in msg:
                    raise RuntimeError(f"{method}: {msg['error']}")
                return msg.get("result", {})

    async def eval(self, expr: str, await_promise: bool = False):
        res = await self.call("Runtime.evaluate", {
            "expression": expr,
            "returnByValue": True,
            "awaitPromise": await_promise,
        })
        if "exceptionDetails" in res:
            d = res["exceptionDetails"].get("exception", {}).get("description", "eval error")
            raise RuntimeError(d)
        return res.get("result", {}).get("value")


async def wait_for(cdp: CDP, expr: str, timeout: float = 120.0, label: str = ""):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            last = await cdp.eval(expr)
            if last:
                return last
        except Exception as e:
            last = repr(e)
        await asyncio.sleep(0.5)
    raise SystemExit(f"не дождались: {label or expr} (последнее: {last!r})")


def make_png(path: Path, w: int, h: int, color) -> int:
    """Пишет PNG и возвращает stamp (mtime_ns) — «версию» файла."""
    from PIL import Image

    Image.new("RGB", (w, h), color).save(path, "PNG")
    return os.stat(path).st_mtime_ns


RECON_JS = r"""
(() => {
  const app = window.app;
  const out = {};
  out.graphReady = !!(app && app.isGraphReady);
  out.exported = !!window.DeggImagesSaveCompare;
  out.vueNodes = !!(app && app.extensionManager && app.extensionManager.setting
                    && app.extensionManager.setting.get("Comfy.VueNodes.Enabled"));
  out.hasNodeOutputs = !!(app && "nodeOutputs" in app);
  out.version = window.DeggImagesSaveCompare ? "js-ok" : null;
  return out;
})()
"""

WF = {
    "last_node_id": 1,
    "last_link_id": 0,
    "nodes": [
        {
            "id": 1,
            "type": NODE_TYPE,
            "pos": [80, 80],
            "size": [460, 640],
            "flags": {},
            "order": 0,
            "mode": 0,
            "inputs": [],
            "outputs": [],
            "properties": {"Node name for S&R": NODE_TYPE},
            "widgets_values": [True, "ComfyUI", "Off", 0.5, 1.0],
            "title": "Degg Save/Compare",
        }
    ],
    "links": [],
    "groups": [],
    "config": {},
    "extra": {},
    "version": 0.4,
}

SETUP_JS = r"""
(async () => {
  const app = window.app;
  const P = window.DeggImagesSaveCompare;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const frames = async (n) => { for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r)); };
  const settle = async () => { await sleep(400); await frames(10); await sleep(400); };

  const stateOf = () => {
    const n = app.graph.getNodeById(1);
    if (!n) return null;
    const st = P.ensureState(n);
    const img = st.dom ? st.dom.a.img : null;
    const nodeEl = img && img.closest ? img.closest("[data-node-id]") : null;
    return {
      id: n.id,
      meta: st.meta1 ? st.meta1.filename : null,
      stamp: st.meta1 ? (st.meta1.stamp || null) : null,
      dim: st.dim1,
      src: img ? img.getAttribute("src") : null,
      display: img ? img.style.display : null,
      loaded: !!(img && img.complete && img.naturalWidth > 0),
      natural: img ? [img.naturalWidth, img.naturalHeight] : null,
      domAttached: !!(img && img.isConnected),
      domIsLive: !!(nodeEl && nodeEl.getAttribute("data-node-id") === "1"),
      nodeEl: document.querySelectorAll('[data-node-id="1"]').length,
    };
  };
  const outputOf = (f, dims, stamp) => ({
    degg_compare_images: [{
      filename: f, subfolder: "", type: "temp",
      full_path: f, width: dims[0], height: dims[1], slot: 1, stamp: stamp,
    }],
    degg_open_path: [""],
  });
  const fire = (f, dims, stamp) => app.api.dispatchCustomEvent("executed", {
    node: 1, display_node: 1, prompt_id: "probe-" + stamp, output: outputOf(f, dims, stamp),
  });

  window.__dscProbe = { app, P, settle, stateOf, outputOf, fire, out: {} };

  await app.loadGraphData(PROBE_WF);
  await settle();
  const node = app.graph.getNodeById(1);
  const out = window.__dscProbe.out;
  out.exported = !!P;
  out.ready = !!(node && node._dscReady);
  out.baseline = stateOf();
  return out;
})()
"""

STEP1_JS = r"""
(async () => {
  const pr = window.__dscProbe;
  pr.fire(PROBE_SAME, PROBE_SAME_DIM, PROBE_SAME_STAMP);
  await new Promise((r) => setTimeout(r, 1200));
  await pr.settle();
  pr.out.s1_first = pr.stateOf();
  return pr.out.s1_first;
})()
"""

STEP2_JS = r"""
(async () => {
  const pr = window.__dscProbe;
  pr.fire(PROBE_SAME, PROBE_SAME_DIM2, PROBE_SAME_STAMP2);
  await new Promise((r) => setTimeout(r, 1500));
  await pr.settle();
  pr.out.s1_second = pr.stateOf();
  return pr.out.s1_second;
})()
"""

STEP3_JS = r"""
(async () => {
  const pr = window.__dscProbe;
  const app = pr.app;
  const ds = app.canvas.ds;
  ds.offset = [-4000, -4000];
  ds.scale = 1;
  app.canvas.setDirty(true, true);
  try { app.canvas.draw(true, true); } catch (e) { /* ignore */ }
  await pr.settle();
  pr.out.offScreen = pr.stateOf();

  pr.fire(PROBE_OFF, PROBE_OFF_DIM, PROBE_OFF_STAMP);
  await new Promise((r) => setTimeout(r, 1500));
  await pr.settle();
  pr.out.offDuring = pr.stateOf();

  ds.offset = [0, 0];
  ds.scale = 1;
  app.canvas.setDirty(true, true);
  try { app.canvas.draw(true, true); } catch (e) { /* ignore */ }
  await pr.settle();
  pr.out.offBack = pr.stateOf();
  return pr.out;
})()
"""

STEP4_JS = r"""
(async () => {
  const pr = window.__dscProbe;
  const app = pr.app;
  const newer = pr.stateOf();
  app.nodeOutputs = { 1: pr.outputOf(PROBE_OFF, PROBE_OFF_DIM, PROBE_OFF_STAMP) };
  await pr.settle();
  app.nodeOutputs = { 1: pr.outputOf(PROBE_SAME, PROBE_SAME_DIM2, PROBE_SAME_STAMP2) };
  await pr.settle();
  pr.out.s3_afterOldRestore = pr.stateOf();
  pr.out.s3_expected = newer.meta;
  return pr.out;
})()
"""


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=COMFY_URL)
    ap.add_argument("--port", type=int, default=9482)
    ap.add_argument("--temp-dir", default=os.environ.get("COMFY_TEMP", DEFAULT_TEMP))
    ap.add_argument("--keep", action="store_true")
    ap.add_argument("--recon", action="store_true")
    args = ap.parse_args()

    try:
        import websockets  # noqa: WPS433
    except ImportError:
        raise SystemExit("нет модуля websockets — запускай через python_embeded")

    temp_dir = Path(args.temp_dir)
    if not temp_dir.is_dir():
        raise SystemExit(f"нет папки temp ComfyUI: {temp_dir}")
    same = temp_dir / F_SAME
    off = temp_dir / F_OFF
    stamp_same = make_png(same, 320, 200, (200, 30, 30))

    profile = Path(tempfile.mkdtemp(prefix="dsc-stale-"))
    chrome = subprocess.Popen([
        find_chrome(),
        "--headless=new",
        f"--remote-debugging-port={args.port}",
        f"--user-data-dir={profile}",
        "--no-first-run", "--no-default-browser-check",
        "--window-size=1600,1000",
        "--disable-features=Translate",
        args.url,
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    errors: list[str] = []
    oks: list[str] = []

    def check(label: str, cond: bool, extra: str = ""):
        (oks if cond else errors).append(label)
        mark = "ok  " if cond else "FAIL"
        print(f"  {mark} {label}" + (f"  [{extra}]" if extra else ""))

    try:
        page = wait_devtools(args.port)
        async with websockets.connect(page["webSocketDebuggerUrl"],
                                      max_size=64 * 1024 * 1024) as ws:
            cdp = CDP(ws)
            await cdp.call("Runtime.enable")
            print("→ ждём загрузку фронтенда…")
            await wait_for(cdp, "!!(window.app && window.app.isGraphReady)", 180,
                           "app.isGraphReady")
            # ⛔ Симптом пользователя — именно Nodes 2.0 (Vue-ноды).
            await cdp.eval(
                "window.app.ui.settings.setSettingValue('Comfy.VueNodes.Enabled', true); 1")
            await asyncio.sleep(3.0)

            recon = await cdp.eval(RECON_JS) or {}
            print("→ разведка: " + json.dumps(recon, ensure_ascii=False))
            if args.recon:
                return 0

            check("наш JS-экспорт виден странице", recon.get("exported") is True)
            check("Nodes 2.0 включены (Vue-ноды)", recon.get("vueNodes") is True)
            check("фронтенд отдаёт app.nodeOutputs", recon.get("hasNodeOutputs") is True)

            stamps = {"off": ""}

            def fill(tpl: str, *, same_stamp=None, dims=(320, 200)) -> str:
                return (tpl
                        .replace("PROBE_WF", json.dumps(WF, ensure_ascii=False))
                        .replace("PROBE_SAME_DIM2", json.dumps([480, 160]))
                        .replace("PROBE_SAME_DIM", json.dumps(list(dims)))
                        .replace("PROBE_OFF_DIM", json.dumps([640, 360]))
                        .replace("PROBE_SAME_STAMP2", json.dumps(str(stamp_same if same_stamp is None else same_stamp)))
                        .replace("PROBE_SAME_STAMP", json.dumps(str(stamp_same)))
                        .replace("PROBE_OFF_STAMP", json.dumps(stamps["off"]))
                        .replace("PROBE_SAME", json.dumps(F_SAME))
                        .replace("PROBE_OFF", json.dumps(F_OFF)))

            res = await cdp.eval(fill(SETUP_JS), await_promise=True) or {}
            print("→ baseline: " + json.dumps(res.get("baseline") or {}, ensure_ascii=False))

            first = await cdp.eval(fill(STEP1_JS, same_stamp=stamp_same),
                                   await_promise=True) or {}
            res["s1_first"] = first

            # ⛔ Тот же путь/имя/тип, ДРУГИЕ байты и mtime — ПОСЛЕ первого показа.
            stamp_same2 = make_png(same, 480, 160, (30, 200, 60))
            print("→ файл перезаписан: %s (%d байт, stamp=%s)"
                  % (F_SAME, same.stat().st_size, stamp_same2))

            res["s1_second"] = await cdp.eval(fill(STEP2_JS, same_stamp=stamp_same2),
                                              await_promise=True) or {}

            # ⛔ Файл S2 пишем ПОСЛЕ S1: его штамп обязан быть НОВЕЕ, иначе
            # монотонный guard справедливо отклонит его как устаревший.
            stamp_off = make_png(off, 640, 360, (30, 120, 200))
            stamps["off"] = str(stamp_off)
            res.update(await cdp.eval(fill(STEP3_JS, same_stamp=stamp_same2),
                                     await_promise=True) or {})
            res.update(await cdp.eval(fill(STEP4_JS, same_stamp=stamp_same2),
                                     await_promise=True) or {})
            print("→ сценарий: " + json.dumps(res, ensure_ascii=False, indent=1))
            if res.get("error"):
                check("сценарий выполнен без ошибки страницы", False, str(res["error"]))
            else:
                base = res.get("baseline") or {}
                check("нода загружена и готова (_dscReady)", res.get("ready") is True)
                check("DOM превью смонтирован и это ЖИВОЙ элемент",
                      base.get("domIsLive") is True and base.get("domAttached") is True,
                      "nodeEl=%s" % (base.get("nodeEl"),))

                first = res.get("s1_first") or {}
                check("S1: первый файл показан (320x200)",
                      first.get("meta") == F_SAME and (first.get("natural") or [0])[0] == 320,
                      "meta=%s natural=%s" % (first.get("meta"), first.get("natural")))

                second = res.get("s1_second") or {}
                check("S1 ГЛАВНОЕ: тот же filename с новыми байтами → превью ОБНОВИЛОСЬ (480x160)",
                      (second.get("natural") or [0])[0] == 480,
                      "natural=%s src=%s" % (second.get("natural"), second.get("src")))
                check("S1: в src есть версия файла (иначе браузер отдаёт кэш)",
                      isinstance(second.get("src"), str) and str(stamp_same2) in second.get("src"),
                      str(second.get("src")))
                check("S1: подпись размера обновилась на 480×160",
                      second.get("dim") == "480×160", str(second.get("dim")))

                off0 = res.get("offScreen") or {}
                check("S2: граф уведён — DOM ноды вне кадра (диагностика)",
                      True, "nodeEl=%s" % (off0.get("nodeEl"),))
                during = res.get("offDuring") or {}
                check("S2: executed дошёл до ноды вне кадра (meta = новый файл)",
                      during.get("meta") == F_OFF,
                      "meta=%s" % during.get("meta"))
                check("S2: картинка загрузилась, пока нода была вне кадра",
                      (during.get("natural") or [0])[0] == 640,
                      "natural=%s" % during.get("natural"))

                back = res.get("offBack") or {}
                check("S2 ГЛАВНОЕ: после возврата в кадр превью показывает НОВЫЙ файл",
                      back.get("meta") == F_OFF and (back.get("natural") or [0])[0] == 640,
                      "meta=%s natural=%s domIsLive=%s"
                      % (back.get("meta"), back.get("natural"), back.get("domIsLive")))
                check("S2: элемент превью не пересоздан (тот же <img>)",
                      back.get("domIsLive") is True and back.get("domAttached") is True)

                s3 = res.get("s3_afterOldRestore") or {}
                check("S3: восстановление СТАРОГО выхода не откатывает превью",
                      s3.get("meta") == res.get("s3_expected"),
                      "meta=%s expected=%s" % (s3.get("meta"), res.get("s3_expected")))
    finally:
        if args.keep:
            print("Chrome оставлен: порт", args.port)
        else:
            chrome.terminate()
            try:
                chrome.wait(timeout=10)
            except Exception:
                chrome.kill()
            shutil.rmtree(profile, ignore_errors=True)
        for f in (same, off):
            try:
                f.unlink()
            except Exception:
                pass

    print("")
    print(f"ok: {len(oks)}   FAIL: {len(errors)}")
    for e in errors:
        print("  - " + e)
    return 1 if errors else 0


if __name__ == "__main__":
    _force_utf8()
    _reexec_with_websockets()
    sys.exit(asyncio.run(main()))
