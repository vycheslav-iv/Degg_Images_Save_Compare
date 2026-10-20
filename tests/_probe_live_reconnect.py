"""Живая проба Degg_Images_Save_Compare: прогон, завершившийся в РАЗРЫВЕ связи.

Сценарий пользователя:
  1. ComfyUI только что перезапущен (первая генерация после рестарта);
  2. генерация запущена, пользователь ушёл на другую страницу браузера;
  3. генерация завершилась, пока вкладка была в фоне;
  4. при возврате в ноде — СТАРОЕ изображение, новый файл на диске.

Механика (исходники фронтенда 1.55.18):
  • `executed` сервер шлёт КОНКРЕТНОМУ клиенту (sid = client_id промпта);
  • пока сокет клиента закрыт (рестарт сервера / долгий реконнект в скрытой
    вкладке), событие некому доставить — оно теряется безвозвратно;
  • на `reconnected` фронтенд делает только `queueStore.update()` +
    `clearActiveJobIfStale()` (useReconnectQueueRefresh.ts) — выходы нод
    из `/history` НЕ перечитываются, `onNodeOutputsUpdated` не зовётся.
  Поэтому ни `onExecuted`, ни фон-катчап (хук восстановления) не срабатывают:
  у ноды нет ни события, ни снимка, который можно восстановить.

Проба воспроизводит разрыв БЕЗ перезапуска сервера: у страницы подменяется
`api_host` на мёртвый порт (реконнект падает), промпт уходит с client_id
страницы, затем `api_host` возвращается и сокет переподключается штатно.

Запуск (ComfyUI должен быть запущен):
    cd Degg_Images_Save_Compare
    python tests/_probe_live_reconnect.py --recon
    python tests/_probe_live_reconnect.py
    python tests/_probe_live_reconnect.py --keep
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
INPUT_DIR = os.environ.get(
    "DSC_INPUT_DIR", r"D:\ComfyUI_windows_portable\ComfyUI\input")

IMG_OLD = "01.webp"
DEAD_HOST = "127.0.0.1:9"


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


def ensure_fixture() -> None:
    """Старое изображение должно реально отдаваться /view (иначе прибор слеп)."""
    url = f"{COMFY_URL}view?filename={IMG_OLD}&subfolder=&type=input"
    try:
        with urllib.request.urlopen(url, timeout=5) as r:
            if r.status == 200:
                return
    except Exception:
        pass
    try:
        from PIL import Image
    except ImportError:
        raise SystemExit("нет 01.webp в input/ и нет PIL, чтобы его создать")
    p = Path(INPUT_DIR)
    if not p.is_dir():
        raise SystemExit(f"нет папки input: {p} (задай DSC_INPUT_DIR)")
    Image.new("RGB", (512, 512), (200, 30, 30)).save(p / IMG_OLD, "WEBP")
    print(f"→ фикстура создана: {p / IMG_OLD}")


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
        await self.ws.send(json.dumps({"id": mid, "method": method,
                                      "params": params or {}}))
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
            d = res["exceptionDetails"].get("exception", {}).get(
                "description", "eval error")
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
        await asyncio.sleep(0.4)
    raise SystemExit(f"не дождались: {label or expr} (последнее: {last!r})")


def http_json(path: str, payload: dict | None = None):
    data = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(
        COMFY_URL.rstrip("/") + path, data=data,
        headers={"Content-Type": "application/json"} if data else {})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode() or "{}")


def history_record(prompt_id: str):
    try:
        h = http_json(f"/history/{prompt_id}")
    except Exception:
        return None
    return (h.get("History") or h).get(prompt_id)


WF_A = {
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

STATE_JS = r"""
(() => {
  const n = window.app.graph.getNodeById(1);
  if (!n) return { noNode: true };
  const P = window.DeggImagesSaveCompare;
  const st = P.ensureState(n);
  const img = st.dom ? st.dom.a.img : null;
  return {
    meta: st.meta1 ? st.meta1.filename : null,
    src: img ? img.getAttribute("src") : null,
    display: img ? img.style.display : null,
    loaded: !!(img && img.complete && img.naturalWidth > 0),
    propsMeta: (n.properties && n.properties.dsc_meta && n.properties.dsc_meta["1"]
                && n.properties.dsc_meta["1"].filename) || null,
    executedSeen: (window.__execSeen || []).slice(-8),
    reconEvents: window.__reconEvents || 0,
    socketState: window.app.api.socket ? window.app.api.socket.readyState : null,
  };
})()
"""


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=COMFY_URL)
    ap.add_argument("--port", type=int, default=9482)
    ap.add_argument("--keep", action="store_true")
    ap.add_argument("--recon", action="store_true")
    args = ap.parse_args()

    try:
        import websockets  # noqa: WPS433
    except ImportError:
        raise SystemExit("нет модуля websockets — запускай через python_embeded")

    ensure_fixture()

    profile = Path(tempfile.mkdtemp(prefix="dsc-reconnect-"))
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
            await cdp.eval(
                "window.app.ui.settings.setSettingValue"
                "('Comfy.VueNodes.Enabled', false); 1")
            await asyncio.sleep(2.0)

            if args.recon:
                print(json.dumps(await cdp.eval(STATE_JS), ensure_ascii=False))
                print(json.dumps(await cdp.eval(r"""(() => ({
                  apiHost: window.app.api.api_host,
                  clientId: window.app.api.clientId,
                  stored: sessionStorage.getItem("clientId"),
                  hasApiHost: "api_host" in window.app.api,
                }))()"""), ensure_ascii=False))
                return 0

            # 1. Граф с нашей нодой + рабочее «старое» превью.
            await cdp.eval(
                "window.app.loadGraphData(" + json.dumps(WF_A, ensure_ascii=False) + ")",
                await_promise=True)
            await asyncio.sleep(2.0)
            await cdp.eval(r"""
(() => {
  window.__execSeen = [];
  window.__reconEvents = 0;
  window.app.api.addEventListener("reconnected", () => { window.__reconEvents++; });
  window.app.api.addEventListener("executed", (e) => {
    const d = e && e.detail || {};
    try { window.__execSeen.push((d.output && d.output.degg_compare_images
      && d.output.degg_compare_images[0] || {}).filename || d.node); } catch (_) {}
  });
  const out = { degg_compare_images: [{ filename: "01.webp", subfolder: "",
    type: "input", full_path: "01.webp", width: 512, height: 512, slot: 1 }],
    degg_open_path: [""] };
  window.app.api.dispatchCustomEvent("executed",
    { node: 1, display_node: 1, prompt_id: "probe-old", output: out });
  return 1;
})()
""")
            await asyncio.sleep(1.5)
            base = await cdp.eval(STATE_JS) or {}
            check("база: в превью СТАРОЕ изображение (01.webp)",
                  base.get("meta") == IMG_OLD,
                  "meta=%s loaded=%s" % (base.get("meta"), base.get("loaded")))
            check("база: страница получает executed (прибор слышит события)",
                  IMG_OLD in (base.get("executedSeen") or []),
                  str(base.get("executedSeen")))

            # 2. Разрыв: мёртвый api_host + закрыть текущий сокет.
            client_id = await cdp.eval("window.app.api.clientId")
            await cdp.eval(
                "window.__apiHost = window.app.api.api_host;"
                f"window.app.api.api_host = {json.dumps(DEAD_HOST)};"
                "window.app.api.socket && window.app.api.socket.close(); 1")
            await asyncio.sleep(2.5)
            dead = await cdp.eval(STATE_JS) or {}
            check("разрыв: сокет страницы закрыт (client_id = %s)" % client_id,
                  dead.get("socketState") is None or dead.get("socketState") != 1,
                  "readyState=%s" % dead.get("socketState"))

            # 3. Промпт от имени ЭТОЙ страницы, пока связи нет.
            prompt_id = http_json("/prompt", {
                "prompt": {
                    "3": {"class_type": "LoadImage", "inputs": {"image": IMG_OLD}},
                    "1": {"class_type": NODE_TYPE, "inputs": {
                        "image_1": ["3", 0], "save_mode": False,
                        "filename_prefix": "PROBE_RECON", "mode": "Off",
                        "opacity": 0.5, "blink_speed": 1.0}},
                },
                "client_id": client_id,
            }).get("prompt_id")
            print("→ промпт в разрыве: " + str(prompt_id))

            rec = None
            deadline = time.time() + 180
            while time.time() < deadline:
                rec = history_record(prompt_id)
                if rec and rec.get("status", {}).get("completed"):
                    break
                await asyncio.sleep(0.5)
            check("прогон завершился, пока связи не было (файл на диске)",
                  bool(rec), str(prompt_id))

            outputs = (rec or {}).get("outputs") or {}
            imgs = (outputs.get("1") or {}).get("degg_compare_images") or []
            new_file = imgs[0].get("filename") if imgs else None
            check("в /history есть выход НОВОГО прогона", bool(new_file), str(new_file))

            # 4. Связь возвращается: штатный реконнект страницы.
            await cdp.eval("window.app.api.api_host = window.__apiHost; 1")
            await wait_for(cdp, "window.app.api.socket && window.app.api.socket.readyState === 1",
                           90, "сокет переподключился")
            # Транспортная перепроверка: единожды наблюдалось, что <img> с уже
            # поставленным src не успевал загрузиться (запрос /view висел) —
            # повторный src=src инициирует новую загрузку и не меняет контракт.
            LOADED_JS = ("(() => { const n = window.app.graph.getNodeById(1);"
                         " if (!n) return false; const st = window.DeggImagesSaveCompare"
                         ".ensureState(n); const im = st.dom && st.dom.a.img;"
                         " return !!(im && im.complete && im.naturalWidth > 0); })()")
            for attempt in (1, 2):
                try:
                    await wait_for(cdp, LOADED_JS, 20, "новое изображение загрузилось")
                    break
                except SystemExit:
                    if attempt == 2:
                        break
                    await cdp.eval("(() => { const n = window.app.graph.getNodeById(1);"
                                   " const st = window.DeggImagesSaveCompare.ensureState(n);"
                                   " const im = st.dom && st.dom.a.img;"
                                   " if (im) { im.src = im.src; } return true; })()")
            await asyncio.sleep(0.5)

            fin = await cdp.eval(STATE_JS) or {}
            print("→ после реконнекта: " + json.dumps(fin, ensure_ascii=False))
            check("сокет переподключился штатно (reconnected дошёл до страницы)",
                  (fin.get("reconEvents") or 0) >= 1, "reconEvents=%s" % fin.get("reconEvents"))
            check("разрыв: событие executed нового прогона страница НЕ получила",
                  bool(new_file) and new_file not in (fin.get("executedSeen") or []),
                  str(fin.get("executedSeen")))

            # ГЛАВНОЕ: после реконнекта превью обязано догнать новый файл.
            check("ГЛАВНОЕ: после реконнекта превью показывает НОВЫЙ файл",
                  bool(new_file) and fin.get("meta") == new_file,
                  "meta=%s new=%s" % (fin.get("meta"), new_file))
            check("ГЛАВНОЕ: новое изображение реально загружено",
                  fin.get("loaded") is True,
                  "src=%s loaded=%s" % (fin.get("src"), fin.get("loaded")))
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

    print("")
    print(f"ok: {len(oks)}   FAIL: {len(errors)}")
    for e in errors:
        print("  - " + e)
    return 1 if errors else 0


if __name__ == "__main__":
    _force_utf8()
    _reexec_with_websockets()
    sys.exit(asyncio.run(main()))
