# Память сессии — Degg_Images_Save_Compare (2026-10-09)

> Покажи этот файл агенту, чтобы продолжить работу.
> Всегда сверяйся с `AGENTS.md` и `SPECIFICATION.md`.

---

## 1. Что делали в этой сессии (кратко)
- Форвард pointer-событий на канву графа (средняя кнопка панорамирует воркфлоу во всех режимах, кроме внутренней панорамы SBS): `forwardPointerToCanvas(e)` — зеркало `forwardEventToCanvas` из `useCanvasInteractions.ts`, синтетический `PointerEvent` на `app.canvas.canvas`, `preventDefault+stopPropagation` на оригинале ДО диспатча.
- Добавлены проверки §4.7 (LOD: `hideOnZoom:false`, иначе превью пропадает на 56% — дефолт `addDOMWidget` true, порог 0.6) и §4.8 (средняя кнопка).
- Обновлены `check.json` (описания), `tests/_smoke_degg_images_save_compare.mjs` (+10 проверок п.1: Off/Slider/2.0/SBS — форвард down/move/up, prevention/propagation, левая кнопка не форвардится, SBS-исключение), `tests/_audit_degg_images_save_compare.mjs` (+6 статических проверок; контракт навигации переписан с bare-gates на форвард с обоснованием).
- Версия `DSC_JS_VERSION`: `2.14.0-wheel-fwd-viewpair` → `2.15.0-midbtn-pan-fwd`.
- Красная база до правки: smoke FAIL 247/6, audit FAIL 241/6. Мутации M1–M5 → RED.
- Закоммичено и запушено: `c4c5b6b` + push в `origin/master`.
- **Локализация ноды**: русский интерфейс ComfyUI → RU, любой другой → EN.
  Предыдущая модель сломала ноду (превью перестало появляться) — выполнен откат
  рабочей копии из чистого исходника, затем переписано правильно.
- **Найден настоящий баг прошлой попытки**: подмена `w.options.values`
  русскими строками → `currentMode()` всегда возвращал `"Off"` → ветки
  Slider/Overlap/Difference/Blink молча не работали (Python дополнительно
  приводил значение к `"Slider"` — traceback отсутствовал).
- **Подписи режимов** переведены через `widget.options.getOptionLabel`
  (значения и `w.value` не тронуты).
- Обновлена `SPECIFICATION.md` (новая §5 «Локализация», §5.1/5.2/5.3;
  прежние §5–§7 → §6–§8), описания в `check.json` (expect не тронуты).
- Red-first: аудит 180/12 → 239/0, смоук 229/7 → 241/0; подзадача режимов —
  красная база 235/4 (аудит) и 238/3 (смоук). Мутации M1–M6 — все RED.
- Вне репозитория (корень бандла — не git): созданы/дописаны скилы
  `comfyui-combo-protocol-values` (новый), `comfyui-localization`,
  `comfyui-bilingual-node` + строка в `AGENTS.md` §3/§5.

## 2. Итоговое состояние кода

- `web/js/degg_images_save_compare.js` (`DSC_JS_VERSION` js:51 — `2.15.0-midbtn-pan-fwd`):
  - `forwardPointerToCanvas(e)` js:1289 — форвард pointer-событий на `app.canvas.canvas` (зеркало `forwardEventToCanvas`, `preventDefault+stopPropagation` на оригинале ДО диспатча).
  - `bindPreviewEvents` — stage `pointerdown`/`pointermove`/`pointerup`: средняя кнопка → форвард, кроме внутренней панорамы SBS (`navEnabled && zoom > 1`).
  - `bindGuardEvents` (`canvasGuardEl`/`onPointerDown`, Nodes 2.0, js:1487) — capture-guard тем же форвардом выше TransformPane; не зависит от режима рендера.
  - `addPreviewWidget` (`hideOnZoom:false`, js:1566) — снят дефолт `addDOMWidget`, иначе превью пропадает на 56% (LOD).
  - `SPECIFICATION.md` §4.7 (LOD) и §4.8 (средняя кнопка) — документация контракта.
- `degg_images_save_compare.py` — все `tooltip` и `DESCRIPTION` **по-английски** (EN-источник; для локали без файла фронтенд отдаёт backend-текст).
- `locales/en/nodeDefs.json` и `locales/ru/nodeDefs.json` — по 41 строке: `display_name`, `description`, `inputs.*.name|tooltip` (7 слотов), `outputs.0.name`.
- Тесты: python **57/0**, smoke **253/0**, audit **247/0**; `check.py` — провалов 0 (предупреждение `предохранитель git` — предсуществующее).
- Bundle-root скил `.agents/skills/comfyui-js-extension/SKILL.md` (+ зеркала `.kilo/`, `.opencode/`) — добавлен раздел «Форвард событий на канву графа» (3 зеркала идентичны по содержимому нового раздела).

## 3. Проблемы, которые встречались (и как решали)

- Превью не появлялось, ошибок нет → подмена протокольных значений combo.
  Правильно — только `getOptionLabel`; оба фронтенда его читают
  (legacy `ComboWidget.ts:149`, Nodes 2.0 `useWidgetSelectItems` →
  `WidgetSelectDropdown.vue:88`).
- Ретрай-регистрация (`setTimeout(...,100)` до появления `comfyAPI.app.app`) —
  **мёртвый код**: пространство заполняется до импорта расширения
  (`setup()` → `loadExtensions()` → `import(ext)`); вдобавок рекурсия без
  границы — утечка таймера.
- Детектор аудита ловил проверку на **строке-комментарии** (слепой) → все
  детекторы локализации ищутся в `JSC` (код без комментариев).
- `git diff` по аудиту показывал 865 строк вместо 91 → в файле был `\r\r\n`
  (смешанные окончания). Вычищено до LF, staged diff стал 91/0. Если увидишь
  полную перезапись файла в diff — сначала смотри на окончания строк.
- Средняя кнопка не панорамировала мир в Off/Slider/одиночных видах: legacy
  DomWidgets — сосед канвы, pointerdown(button===1) уходил в пустой return;
  колесо спасал `forwardWheelToCanvas`, pointer-события не форвардились. В
  Nodes 2.0 TransformPane capture есть, но поведение должно быть одинаковым в
  обоих режимах → `forwardPointerToCanvas` эксплицитен.
- Контракт навигации переписан с bare-return-гейтов на форвард: навигация
  закрыта только в capture-wheel (Alt+wheel) и там, где нет сравнения двух
  кадров (`navEnabled` false) — событие в остальных случаях уходит графу,
  а не теряется.

## 4. Что важно не сломать при продолжении работы

- ⛔ **Никогда** не подменять `widget.options.values`, `widget.value` и
  значения `INPUT_TYPES` — только `getOptionLabel` (скил
  `comfyui-combo-protocol-values`).
- Python остаётся EN-источником; русский — только в `locales/ru`.
- После правок `locales/` — **перезапуск ComfyUI** (`@lru_cache` + скан на
  старте) и Hard Reload; после правок `web/js/` — только Hard Reload.
- Запрещено в JS: `zIndex`, `scrollHeight|offsetHeight`, `getHeight:`,
  `setInterval`, глобальные слушатели; сохранить `fillStyle="#18181c"` захвата
  канваса, `mixBlendMode:"difference"` на `st.dom.b.box`, help-кнопку
  `rgba(24,24,28,0.75)`, `dim2 display none` в Off.
- `check.json`: ровно 3 проверки, **expect-строки не менять**.
- `sync.py` не копирует `tests/` — тесты живут только в исходнике.
- `hideOnZoom: false` в `addPreviewWidget` не удалять: дефолт `addDOMWidget`
  true, при `ds.scale < 0.6` (`LGraphCanvas.ts:552`, порог
  `LiteGraph.Canvas.LowQualityRenderingZoomThreshold = 0.6`) превью скрывается.
- `forwardPointerToCanvas` — точечный, без `if(true)/if(false)`; ровно 5
  вызовов в коде + определение.
- SBS-исключение: при `navEnabled && zoom > 1` средняя кнопка — внутренняя
  панорама кадров, графу не уходит; при зуме 1 — уходит графу.
- Левая кнопка (`button===0`) никогда не форвардится.
- Alt+wheel — особая функция SBS (зум превью), без изменений.

## 5. Следующие шаги (идеи, не сделано)

- **Живая проверка**: перезапуск ComfyUI + Hard Reload → в дропдауне режимов
  русские подписи, и все 6 режимов реально работают под RU. Проверено только
  на исходниках фронтенда и в vm-стенде, не в браузере.
- Детектор на голый `setTimeout` в аудите (ждёт «да» пользователя).
- Скилы и `AGENTS.md` лежат **вне git** (корень бандла не репозиторий,
  `git init` запрещён) — не коммитятся, не восстанавливаются.
- `[warn] предохранитель git` в `check.py` — предсуществующий.
- Можно закоммитить и запушить bundle-root скил `comfyui-js-extension`
  (добавлен раздел «Форвард событий на канву графа»), если есть желание
  версионировать навыки.
- Живая проба `forwardPointerToCanvas` после `sync.py` + перезапуск ComfyUI +
  Hard Reload: проверить, что средняя кнопка панорамирует воркфлоу вне SBS.

## 6. Связанные файлы

- `F:\AI_projects\Custom_node_ComfyUI\Degg_Images_Save_Compare\` — исходник (`.git` здесь)
- `D:\ComfyUI_windows_portable\ComfyUI\custom_nodes\Degg_Images_Save_Compare\` — рабочая копия
- `SPECIFICATION.md` (§4.7 LOD, §4.8 средняя кнопка), `check.json` — обновлены под эту сессию
- `SESSION_MEMORY-history/2026-10-09.md` — снапшот предыдущей памяти
- `SESSION_MEMORY-history/2026-10-09-prev.md` — снапшот памяти до перезаписи этой сессией
- Скилы (вне репозитория): `.agents/skills/comfyui-combo-protocol-values/`,
  `comfyui-localization/`, `comfyui-bilingual-node/`, `comfyui-js-extension/`
  (+ зеркала в `.kilo`, `.opencode`)
