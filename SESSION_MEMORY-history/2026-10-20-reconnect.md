# Память сессии — Degg_Images_Save_Compare (2026-10-20)

> Покажи этот файл агенту, чтобы продолжить работу.
> Всегда сверяйся с `AGENTS.md` и `SPECIFICATION.md`.

---

## 1. Что делали в этой сессии (кратко)

- **Багфикс «превью не обновляется / показывает старый кадр»** (SPECIFICATION.md §4.10).
  Замер `tests/_probe_live_stale.py` (реальный Chrome + фронтенд): **11 ok / 4 FAIL**
  до правки → **15 ok / 0 FAIL** после. S2 (нода вне кадра, Nodes 2.0) — НЕ баг:
  DOM не выгружается, `executed` доходит, превью обновляется.
- **Причина S1**: counter `get_save_image_path` считается по файлам в папке →
  после удаления файла следующий прогон пишет ТО ЖЕ имя → `slotShows` считал
  «уже показано» (и браузер отдавал старые байты из кэша `/view`).
  **Причина S3**: `onNodeOutputsUpdated`/restore присылал выход ПРОШЛОГО прогона
  и откатывал превью назад.
- **Лечение — «штамп файла»**: Python `_stamp_for()` (`st_mtime_ns` строкой +
  модульный `_STAMP_LAST` для монотонности, шаг часов Windows ~15 мс); JS
  `stampOf`/`cmpStamp` (сравнение цифровых строк), `&v=<stamp>` в **обеих**
  ветках `metaUrl`, сверка штампа в `slotShows`, guard `cmpStamp(...) < 0 →
  continue` в `applyOutput`, persist штампа в `dsc_meta`, `ensureSlotSrc` +
  обёртка `onDrawForeground` (самоизлечение `src`; сверка через
  `getAttribute("src")`, иначе абсолютное свойство → перезагрузка каждый кадр).
- `DSC_JS_VERSION`: `2.16.0-bg-run-catchup` → **`2.17.0-file-stamp`**.
- Тесты: python **61/0**, smoke **281/0**, audit **266/0**; `check.py` — провалов 0,
  предупреждений 0 (поставлен предохранитель git: `.githooks/{pre-commit,commit-msg}`
  + `core.hooksPath`).
- Мутации доказали чувствительность: живая проба M1 (`slotShows` без штампа → 12/3),
  M2 (снят guard → 14/1), M3 (`v=""` → 13/2); аудит A1–A4 → RED.
  ⛔ A1 вскрыл слепоту моего же детектора: `metaUrl`-чек смотрел только запасную
  ветку, а в браузере работает `api.apiURL` — теперь требуется `&v=` в ОБЕИХ.
- **Закоммичено и запушено**: `5d66048` «Превью: штамп файла вместо имени
  (cache-bust + монотонный guard)» → `origin/master` (11 файлов, +1084/−70).
  В коммит вошли фикс, SPEC §4.10, три теста, живая проба `_probe_live_stale.py`,
  `.githooks/` (pre-commit + commit-msg, `core.hooksPath`), снапшот памяти.

## 2. Итоговое состояние кода

- `web/js/degg_images_save_compare.js` (`DSC_JS_VERSION` js:51 — `2.17.0-file-stamp`):
  - `stampOf(meta)` js:423, `cmpStamp(a,b)` js:433 — штамп как цифровая строка;
  - `metaUrl(meta)` js:~446 — `&v=<stamp>` в ветках `api.apiURL` И запасной `/view`;
  - `slotShows(st, slot, item)` js:~510 — идемпотентность ПО ШТАМПУ;
  - `ensureSlotSrc(node)` js:~528 — самолечение `src` по метаданным (сверка атрибута);
  - `applyOutput(node, output)` js:~1784 — единая точка; устаревший штамп пропускается;
  - `persistImages`/`restoreImages` — `dsc_meta.*.stamp`;
  - `onDrawForeground` js:~1753 — обёртка с `ensureSlotSrc(this)`;
  - экспорты `stampOf`/`cmpStamp`/`ensureSlotSrc` js:~2013.
- `degg_images_save_compare.py`: `_STAMP_LAST`/`_stamp_for()` (строки 61–79),
  запись `"stamp": stamp` в UI (~197), штамп = `_stamp_for(full_path)`.
- `tests/_probe_live_stale.py` — живая проба S1/S2/S3 (SETUP + STEP1..4, штампы
  передаются строкой; S2-файл пишется ПОСЛЕ S1, иначе монотонный guard справедливо
  отклоняет его как старый). В `check.py` не входит.
- Тесты: python **61/0**, smoke **281/0**, audit **266/0**.

## 3. Проблемы, которые встречались (и как решали)

- Проба «слепла» на `document.getElementById(stage)`: первым `<img>` в stage идёт
  слой b → `domIsLive` через `img.closest("[data-node-id]")`.
- `getAttribute` нет у заглушки smoke → упало с TypeError; и хуже: сверка
  `img.src` (абсолютный) с относительным `/view` вызвала бы перезагрузку каждый
  кадр — сверяем атрибут с фолбэком на свойство.
- Мутация A1: детектор аудита проверял только запасную ветку `metaUrl`;
  в браузере идёт `api.apiURL` → чек расширен на обе ветки.
- `_stamp_for` нужен из-за разрешения часов Windows (~15 мс): два прогона подряд
  могли получить одинаковый `mtime_ns`.

## 4. Что важно не сломать при продолжении работы

- `onNodeOutputsUpdated` зовётся на КАЖДОЕ присваивание `app.nodeOutputs` —
  без `slotShows` превью мигало бы; гейт по типу ноды обязателен.
- Guard `cmpStamp(...) < 0 → continue` — защита от выхода ПРОШЛОГО прогона; без
  него S3 откатывает превью (мутация M2 → RED).
- `&v=` нужен в ОБЕИХ ветках `metaUrl` (мутация A1 → RED аудита).
- Штамп в Python — ТОЛЬКО строкой (`int` в JSON → JS теряет точность > 2^53).
- `hideOnZoom: false` (§4.7); `forwardPointerToCanvas` точечный (§4.8);
  `MODES` — протокольные значения (comfyui-combo-protocol-values).
- `check.json`: ровно 3 проверки, expect-строки не менять.
- `sync.py` не копирует `tests/`; Hard Reload после JS-правок, Python-правки —
  только после перезапуска ComfyUI.

## 5. Следующие шаги (идеи, не сделано)

- Если симптом повторится при СМЕНЕ имени файла — смотреть уже не штамп, а
  кэш `/view` на стороне сервера (заголовки кэширования ComfyUI).
- Вынести в скил `comfyui-background-run-catchup` (или отдельный) правило
  «имя файла ≠ версия содержимого: штамп + cache-bust + монотонный guard» —
  спросить разрешение у пользователя.

## 6. Связанные файлы

- `web/js/degg_images_save_compare.js` — JS-расширение (вся логика превью)
- `degg_images_save_compare.py` — `_stamp_for`, запись `stamp` в UI
- `SPECIFICATION.md` §4.10 — контракт штампа; §4.9 — фоновый догон
- `tests/_probe_live_stale.py` — живая проба S1/S2/S3 (ComfyUI + Chrome)
- `tests/_smoke_degg_images_save_compare.mjs` — блок «штамп: …» (11 проверок)
- `tests/_audit_degg_images_save_compare.mjs` — статические чеки штампа (9)
- Рабочая копия: `D:\ComfyUI_windows_portable\ComfyUI\custom_nodes\Degg_Images_Save_Compare\`
