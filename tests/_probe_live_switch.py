"""Живая проба Degg_Images_Save_Compare: превью после ФОНОВОГО прогона.

Сценарий бага (со слов пользователя):
  1. запущена генерация;
  2. пользователь уходит на ДРУГОЙ воркфлоу (или в другую закладку браузера);
  3. генерация завершается;
  4. при возврате в воркфлоу генерации в ноде — СТАРОЕ изображение
     (сгенерированное при этом сохранено на диск).

Механика (прочитана в исходниках фронтенда 1.55.17,
static/assets/settingStore-*.js):

    q.addEventListener(`executed`, ({detail:e}) => {
      let t = _N();                                  // node output store
      let n = tryNormalizeNodeExecutionId(e.display_node || e.node);
      if (!n) return;
      t.setNodeOutputsByExecutionId(n, e.output, {merge: e.merge});
      let r = getNodeByExecutionId(this.rootGraph, n);   // ← АКТИВНЫЙ граф
      r && r.onExecuted && r.onExecuted(e.output);
    });

— пока активен ДРУГОЙ воркфлоу, узла в `rootGraph` нет, поэтому
`node.onExecuted` не вызывается вовсе: превью не обновляется, хотя выход
пишется в `queuedJobs[prompt_id].workflow.changeTracker.nodeOutputs`.
Возврат идёт через `ChangeTracker.restore()`:

    restore(){
      this.ds && (Q.canvas.ds.scale = …, …),
      this.nodeOutputs && _N().restoreOutputs(this.nodeOutputs),  // → app.nodeOutputs = snapshot
      …
    }

а присваивание `app.nodeOutputs = …` дёргает хук расширений
`useExtensionService().invokeExtensions("onNodeOutputsUpdated", e)` — именно
по нему штатные расширения (PreviewAny / Preview3D / PreviewAudio) возвращают
свои виджеты после смены воркфлоу.

Проба проверяет ФАКТЫ на живой странице (не рассуждение):
  A. при активном другом воркфлоу вход `executed` НЕ доходит до нашей ноды
     (причина бага) — состояние живого объекта ноды не меняется;
  B. при возврате фронтенд восстанавливает выходы (`app.nodeOutputs`) и зовёт
     `onNodeOutputsUpdated` — превью обязано показать НОВЫЙ файл.

Запуск (ComfyUI должен быть запущен):
    cd Degg_Images_Save_Compare
    python tests/_probe_live_switch.py --recon      # только разведка API
    python tests/_probe_live_switch.py              # сценарий
    python tests/_probe_live_switch.py --keep       # не закрывать Chrome
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


RECON_JS = r"""
(() => {
  const out = {};
  const app = window.app;
  out.vueAppReady = !!(app && app.vueAppReady);
  const wf = app && app.extensionManager && app.extensionManager.workflow;
  out.wfKeys = wf ? Object.keys(wf).filter((k) => /open|create|active/i.test(k)) : null;
  out.hasNodeOutputs = !!(app && "nodeOutputs" in app);
  const wm = app && app.extensionManager && app.extensionManager.workflow;
  if (wm) {
    out.openPaths = (wm.openWorkflows || []).map((w) => w && w.path);
    out.allPaths = (wm.workflows || []).map((w) => w && w.path).slice(0, 12);
    out.active = wm.activeWorkflow && wm.activeWorkflow.path;
  }
  out.exported = !!window.DeggImagesSaveCompare;
  return out;
})()
"""

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

# «Другой воркфлоу»: граф БЕЗ нашей ноды (переход на другую вкладку).
WF_EMPTY = {
    "last_node_id": 7,
    "last_link_id": 0,
    "nodes": [
        {
            "id": 7,
            "type": "Note",
            "pos": [40, 40],
            "size": [240, 120],
            "flags": {},
            "order": 0,
            "mode": 0,
            "inputs": [],
            "outputs": [],
            "properties": {},
            "widgets_values": ["other workflow"],
            "title": "Note",
        }
    ],
    "links": [],
    "groups": [],
    "config": {},
    "extra": {},
    "version": 0.4,
}

# Два РАЗНЫХ реальных файла в input/ — «старое» и «новое» изображение.
IMG_OLD = {"filename": "01.webp", "subfolder": "", "type": "input", "slot": 1}
IMG_NEW = {"filename": "055.webp", "subfolder": "", "type": "input", "slot": 1}

SCENARIO_JS = r"""
(async () => {
  const out = { steps: [] };
  const app = window.app;
  const wf = app.extensionManager.workflow;
  const P = window.DeggImagesSaveCompare;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const settle = async () => { await sleep(700); for (let i = 0; i < 12; i++) await new Promise((r) => requestAnimationFrame(r)); await sleep(500); };
  out.exported = !!P;
  if (!P) { out.error = "window.DeggImagesSaveCompare не экспортирован"; return out; }

  const stateOf = (n) => {
    if (!n) return null;
    const st = P.ensureState(n);
    const img = st.dom ? st.dom.a.img : null;
    return {
      id: n.id,
      meta: st.meta1 ? st.meta1.filename : null,
      type: st.meta1 ? st.meta1.type : null,
      dim: st.dim1,
      src: img ? img.getAttribute("src") : null,
      display: img ? img.style.display : null,
      loaded: !!(img && img.complete && img.naturalWidth > 0),
      propsMeta: (n.properties && n.properties.dsc_meta && n.properties.dsc_meta["1"]
                  && n.properties.dsc_meta["1"].filename) || null,
    };
  };
  const outputOf = (img) => ({
    degg_compare_images: [{
      filename: img.filename, subfolder: img.subfolder, type: img.type,
      full_path: img.filename, width: 512, height: 512, slot: 1,
    }],
    degg_open_path: [""],
  });
  // Ровно то, что делает фронтенд из websocket-сообщения:
  //   app.api.dispatchCustomEvent("executed", detail)
  const fireExecuted = (img) => app.api.dispatchCustomEvent("executed", {
    node: 1, display_node: 1, prompt_id: "probe-" + img.filename, output: outputOf(img),
  });

  // ── 1. Воркфлоу A: граф с нашей нодой ────────────────────────────────
  await app.loadGraphData(PROBE_WF);
  await settle();
  out.nodeA = !!app.graph.getNodeById(1);
  out.readyA = !!(app.graph.getNodeById(1) && app.graph.getNodeById(1)._dscReady);
  const A = wf.activeWorkflow;
  out.trackerA = !!(A && A.changeTracker);
  out.pathA = A && A.path;
  const nodeA = app.graph.getNodeById(1);
  window.__probeA = nodeA;                 // живой объект ноды A

  // ── 2. Базовый прогон: A активен → превью показывает СТАРОЕ ──────────
  fireExecuted(PROBE_OLD);
  await settle();
  out.baseline = stateOf(nodeA);

  // ── 3. Проба-хук: фиксируем, зовёт ли фронтенд onNodeOutputsUpdated ──
  //  Именно на этот хук опирается фикс (так же возвращают свои виджеты
  //  штатные PreviewAny / Preview3D / PreviewAudio).
  window.__hookCalls = [];
  app.registerExtension({
    name: "__dscProbeHook",
    onNodeOutputsUpdated(o) {
      try { window.__hookCalls.push(Object.keys(o || {})); } catch (e) { /* ignore */ }
    },
  });

  // ── 4. Уход из воркфлоу A: реальный ChangeTracker.deactivate() ───────
  //  (то же вызывает фронтенд в beforeLoadNewGraph при смене воркфлоу-таба)
  A.changeTracker.deactivate();
  const snap = A.changeTracker.nodeOutputs || {};
  out.trackerSnapshot = Object.keys(snap);
  out.trackerSnapshotFile = snap[1] && snap[1].degg_compare_images
    ? snap[1].degg_compare_images[0].filename : null;

  // ── 5. Активен ДРУГОЙ граф (как при переходе на другой воркфлоу) ─────
  await app.loadGraphData(PROBE_EMPTY);
  await settle();
  out.otherGraph = !!(app.graph && app.graph.nodes.length)
    && !app.graph.getNodeById(1);
  out.nodesInOther = (app.graph.nodes || []).map((n) => n.id + ":" + n.type);

  // Генерация завершается, пока активен другой граф.
  const hookBefore = window.__hookCalls.length;
  fireExecuted(PROBE_NEW);
  await settle();
  out.hooksAfterBackground = window.__hookCalls.length - hookBefore;
  // Живой объект ноды A: если фронтенд не нашёл узел в активном графе,
  // onExecuted не звался и состояние НЕ тронуто (причина бага).
  out.nodeA_afterBackground = stateOf(window.__probeA);
  out.liveNodeTouched = out.nodeA_afterBackground
    ? out.nodeA_afterBackground.meta === PROBE_NEW.filename : null;

  // Зеркало кода фронтенда (static/assets/settingStore-*.js):
  //   q.addEventListener(`executed`, ({detail:e}) => {
  //     let n = ih().queuedJobs[t.prompt_id]?.workflow?.changeTracker;
  //     if (!n) return; n.nodeOutputs ??= {}; n.nodeOutputs[t.node] = t.output; })
  // Настоящая запись требует реального queued-прогона (prompt_id в очереди
  // и запущенная генерация), поэтому её повторяем руками — дальше до конца
  // работает РЕАЛЬНЫЙ код фронтенда (loadGraphData + ChangeTracker.restore).
  A.changeTracker.nodeOutputs = A.changeTracker.nodeOutputs || {};
  A.changeTracker.nodeOutputs[1] = outputOf(PROBE_NEW);
  out.trackerAfter = A.changeTracker.nodeOutputs[1].degg_compare_images[0].filename;

  // ── 6. Возврат в воркфлоу A: граф грузится заново из своего состояния ─
  //  (как делает фронтенд: changeTracker.activeState → loadGraphData)
  const savedA = A.changeTracker.activeState
    ? structuredClone(A.changeTracker.activeState) : PROBE_WF;
  out.loadedFromSaved = !!A.changeTracker.activeState;
  await app.loadGraphData(savedA);
  await settle();
  const back = app.graph.getNodeById(1);
  out.backInA = !!back;
  out.newNodeInstance = !!back && back !== window.__probeA;
  out.afterReturn = stateOf(back);        // тут и виден баг: СТАРОЕ

  // ── 7. Фронтенд восстанавливает выходы (ChangeTracker.restore) ───────
  out.nodeOutputsBefore = app.nodeOutputs ? Object.keys(app.nodeOutputs) : [];
  A.changeTracker.restore();
  await settle();
  const fin = app.graph.getNodeById(1);
  out.hookCalls = window.__hookCalls.map((a) => a.length);
  out.hookSawNode1 = window.__hookCalls.some((keys) => keys.map(String).includes("1"));
  out.nodeOutputsAfter = app.nodeOutputs ? Object.keys(app.nodeOutputs) : [];
  out.final = stateOf(fin);
  try {
    const list = (app.nodeOutputs && app.nodeOutputs[1]
                  && app.nodeOutputs[1].degg_compare_images) || null;
    out.restoredOutput = list && list[0] ? list[0].filename : null;
  } catch (e) { out.restoredOutput = "ERR " + e; }
  return out;
})()
"""


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=COMFY_URL)
    ap.add_argument("--port", type=int, default=9481)
    ap.add_argument("--keep", action="store_true")
    ap.add_argument("--recon", action="store_true")
    args = ap.parse_args()

    try:
        import websockets  # noqa: WPS433
    except ImportError:
        raise SystemExit("нет модуля websockets — запускай через python_embeded")

    profile = Path(tempfile.mkdtemp(prefix="dsc-switch-"))
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
                "window.app.ui.settings.setSettingValue('Comfy.VueNodes.Enabled', false); 1")
            await asyncio.sleep(2.5)

            recon = await cdp.eval(RECON_JS) or {}
            print("→ разведка: " + json.dumps(recon, ensure_ascii=False))
            if args.recon:
                return 0

            check("наш JS-экспорт виден странице", recon.get("exported") is True)
            check("фронтенд: vueAppReady (хук onNodeOutputsUpdated живой)",
                  recon.get("vueAppReady") is True)
            check("фронтенд: публичный API воркфлоу доступен",
                  bool(recon.get("wfKeys")), json.dumps(recon.get("wfKeys")))

            script = (SCENARIO_JS
                      .replace("PROBE_WF", json.dumps(WF_A, ensure_ascii=False))
                      .replace("PROBE_EMPTY", json.dumps(WF_EMPTY, ensure_ascii=False))
                      .replace("PROBE_OLD", json.dumps(IMG_OLD, ensure_ascii=False))
                      .replace("PROBE_NEW", json.dumps(IMG_NEW, ensure_ascii=False)))
            res = await cdp.eval(script, await_promise=True) or {}
            print("→ сценарий: " + json.dumps(res, ensure_ascii=False, indent=1))
            if res.get("error"):
                check("сценарий выполнен без ошибки страницы", False, str(res["error"]))
            else:
                check("воркфлоу A: нода загружена из графа (id 1)", res.get("nodeA") is True)
                check("воркфлоу A: нода готова (_dscReady)", res.get("readyA") is True)
                check("воркфлоу A: у воркфлоу есть changeTracker",
                      res.get("trackerA") is True)

                base = res.get("baseline") or {}
                check("базовый прогон: превью показало СТАРОЕ изображение",
                      base.get("meta") == IMG_OLD["filename"],
                      "meta=%s props=%s" % (base.get("meta"), base.get("propsMeta")))
                check("базовый прогон: картинка реально загружена",
                      base.get("loaded") is True, str(base.get("src")))

                # Уход из воркфлоу: снимок выходов сделан ДО генерации.
                check("уход: снимок выходов устарел (там СТАРОЕ изображение)",
                      res.get("trackerSnapshotFile") == IMG_OLD["filename"],
                      "snapshot=%s (%s)" % (res.get("trackerSnapshotFile"),
                                            res.get("trackerSnapshot")))
                check("активен другой граф — нашей ноды в нём нет",
                      res.get("otherGraph") is True, str(res.get("nodesInOther")))

                # Причина бага: узла нет в активном графе → onExecuted НЕ звался.
                check("фоновый прогон НЕ тронул ноду A (onExecuted не вызван)",
                      res.get("liveNodeTouched") is False,
                      "meta=%s" % ((res.get("nodeA_afterBackground") or {}).get("meta")))
                check("фоновый прогон записан в tracker нового прогона (зеркало фронтенда)",
                      res.get("trackerAfter") == IMG_NEW["filename"],
                      str(res.get("trackerAfter")))

                # Возврат: граф загружен заново — в ноде СТАРОЕ (симптом бага).
                ret = res.get("afterReturn") or {}
                check("возврат: нода создана заново из сохранённого графа",
                      res.get("newNodeInstance") is True and res.get("backInA") is True)
                check("возврат: до restore() в превью СТАРОЕ изображение (симптом)",
                      ret.get("meta") == IMG_OLD["filename"],
                      "meta=%s src=%s" % (ret.get("meta"), ret.get("src")))

                after = [str(x) for x in (res.get("nodeOutputsAfter") or [])]
                check("фронтенд на возврате вызвал onNodeOutputsUpdated (хук наш)",
                      res.get("hookSawNode1") is True,
                      "calls=%s" % res.get("hookCalls"))
                check("возврат: фронтенд восстановил выходы (app.nodeOutputs[1])",
                      "1" in after,
                      "before=%s after=%s" % (res.get("nodeOutputsBefore"), after))
                check("возврат: восстановлен выход НОВОГО прогона",
                      res.get("restoredOutput") == IMG_NEW["filename"],
                      str(res.get("restoredOutput")))

                fin = res.get("final") or {}
                check("ГЛАВНОЕ: превью показывает НОВОЕ изображение",
                      fin.get("meta") == IMG_NEW["filename"],
                      "meta=%s props=%s" % (fin.get("meta"), fin.get("propsMeta")))
                check("ГЛАВНОЕ: новое изображение реально загружено и видимо",
                      fin.get("loaded") is True and fin.get("display") != "none",
                      "display=%s loaded=%s" % (fin.get("display"), fin.get("loaded")))
                check("в превью стоит src нового файла",
                      isinstance(fin.get("src"), str)
                      and IMG_NEW["filename"] in fin.get("src"), str(fin.get("src")))
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
