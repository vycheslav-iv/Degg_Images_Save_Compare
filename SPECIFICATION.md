# Degg_Images_Save_Compare — SPECIFICATION

## 1. Назначение

Одна нода вместо двух: **сохранение/превью основного изображения** (как
`Custom_node_Images` / `SavePreviewImage`) и **интерактивное сравнение двух
изображений** (как `↔️ OreX Image Compare`), плюс кнопка открытия Image 1 в
программе просмотра Windows по умолчанию.

| Источник | Что взято |
|---|---|
| `Custom_node_Images` (`SavePreviewImage`) | режим Save/Preview с префиксом, метаданные PNG, API-роут открытия файла в системном просмотрщике |
| `↔️ OreX Image Compare` | 5 режимов сравнения (к ним добавлен свой `Off` — просмотрщик), зум/панорама, подписи размеров, «Сохранить текущий вид», GIF для Blink |

## 2. Файлы

| Файл | Назначение |
|---|---|
| `degg_images_save_compare.py` | класс `DeggImagesSaveCompare` + 3 API-роута |
| `web/js/degg_images_save_compare.js` | LiteGraph-расширение: тумблер Save/Preview, префикс, кнопки, **DOM-виджет** сравнения |
| `__init__.py` | экспорт маппингов, `WEB_DIRECTORY = "web"` |
| `tests/` | Python-песочница, JS-смоук, статический аудит |
| `check.json` | 3 проверки для `_process/check.py` |

## 3. Python: класс DeggImagesSaveCompare

### 3.1. INPUT_TYPES

Виджеты идут в порядке объявления — сверху вниз, как в задаче.

| Поле | Тип | По умолчанию | Описание |
|---|---|---|---|
| `image_1` | `IMAGE` | — | **обязательный** вход: основное изображение (проходное) |
| `save_mode` | `BOOLEAN` | `True` | `True` = Save (output + префикс), `False` = Preview (temp). Подписи: **Save** / **Preview** |
| `filename_prefix` | `STRING` | `"ComfyUI"` | префикс файла Image 1 (только в режиме Save) |
| `mode` | combo | `"Off"` | `Off` (просмотрщик Image 1, по умолчанию) / `Slider` / `Side-by-Side` / `Overlap` / `Difference` / `Blink` |
| `opacity` | `FLOAT` | `0.5` | 0.0–1.0, для режима Overlap |
| `blink_speed` | `FLOAT` | `1.0` | 1.0–3.0 сек, длительность фазы Blink |
| `image_2` | `IMAGE` | — | **опциональный** вход: изображение для сравнения |

`hidden`: `prompt`, `extra_pnginfo` (метаданные в PNG).

Вход `output_path` из OreX **не переносится** (по задаче): кнопка «Сохранить
текущий вид» всегда пишет в `output/<дата>/<режим>/`.

### 3.2. Выходы

- `RETURN_TYPES = ("IMAGE",)`, `RETURN_NAMES = ("image_1",)` — проходной Image 1.
- `OUTPUT_NODE = True`.

### 3.3. Что и куда сохраняется

| Что | Режим | Куда | Префикс | compress_level |
|---|---|---|---|---|
| Image 1 | Save (по умолчанию) | `output/` | `filename_prefix` | 4 |
| Image 1 | Preview | `temp/` | `_temp_deggcmp_<rand5>` | 1 |
| Image 2 | всегда | `temp/` | `_deggcmp2_deggcmp_<rand5>` | 1 |

- Image 1 сохраняется **целым батчем** (как кнопка «Save Image»).
- Image 2 сохраняется **только первым кадром**: она нужна для сравнения и для
  сборки GIF, а не как результат.
- Метаданные (prompt + extra_pnginfo) пишутся в PNG, если не включён
  `--disable-metadata`.

### 3.4. UI-контракт (важно)

`save_compare` возвращает **свои** ключи, а не `images`:

```python
{"ui": {"degg_compare_images": [...], "degg_open_path": [<путь Image 1>]},
 "result": (image_1,)}
```

⛔ Ключ `images` не отдаётся намеренно: по нему фронтенд рисует **своё** превью
(`nodeMedia` в Nodes 2.0 / `$$canvas-image-preview` в classic), и под холстом
сравнения появилось бы второе изображение. Свой ключ эту ветку не задевает
(в `Degg_Crop` ради того же приходилось ставить `node.hideOutputImages`).

Запись в `degg_compare_images`:
`{filename, subfolder, type, full_path, width, height, slot}`.

### 3.5. API-роуты

| Роут | Тело | Действие |
|---|---|---|
| `/degg_images_save_compare/open_file` | `{"path": "..."}` | `os.startfile(path)` — открыть в программе Windows по умолчанию. Путь проверяется на принадлежность `output/` или `temp/` |
| `/degg_images_save_compare/save_compare` | `{"mode", "image"}` | снимок холста (JPEG base64) → `output/<дата>/<режим>/Degg_Compare_<режим>_NNNNN.jpg` |
| `/degg_images_save_compare/save_blink_gif` | `{"img1", "img2"}` | GIF с плавным кроссфейдом A→B→A по исходникам на диске |

Blink GIF: тайминг фиксирован (`BLINK_PHASE_MS = 1500` мс на фазу,
`BLINK_TRANSITION_FRAMES = 10` кадров кроссфейда), от виджета `blink_speed`
не зависит — как в OreX. Общая палитра на все кадры (иначе мерцание цветов).

## 4. JS: расширение

### 4.1. Порядок элементов ноды

```
[сокеты] image_1, image_2
[save_mode]          ← тумблер Save/Preview (по умолчанию Save)
[filename_prefix]    ← гасится и скрывается в режиме Preview
[Open in Viewer]                   ← добавлен через insertWidgetAfter (подпись без иконки 📷 — по задаче, как в Image Save/Preview)
[mode] [opacity] [blink_speed]     ← перенесённый функционал OreX
[Сохранить текущий вид]            ← подпись без иконки 💾 (по задаче)
[превью сравнения]                 ← DOM-виджет (addDOMWidget), последний
```

### 4.2. Превью — DOM-виджет (растяжение и события, оба режима)

Превью регистрируется как `addDOMWidget(name, type, element, options)`. Почему
именно DOM, а не canvas-виджет (`draw`/`mouse`/`computeSize`):

| Проблема canvas-виджета | Механика (исходники фронтенда) |
|---|---|
| Не растёт вместе с нодой | `LegacyWidget.drawWidget` передаёт `H = LiteGraph.NODE_WIDGET_HEIGHT` (константа), а `WidgetLegacy.vue` берёт высоту из `computedHeight`/`computeSize` — реальную высоту строки виджет не получает |
| Слайдер не работает в Nodes 2.0 | `WidgetLegacy.vue` не пробрасывает hover, а `pointerdown` приходит из `LGraphCanvas.processWidgetClick` с координатами **ноды**, тогда как `pointermove` — с координатами **виджета** (микс систем координат) |
| Подсказки залипают | canvas-тултип жил в `node.onMouseMove`: увёл курсор с ноды — событий больше нет и подсказка остаётся на экране |

DOM-виджет фронтенд раскладывает в **обоих** режимах одним оверлеем
(`DomWidgets.vue`: позиция `node.pos + widget.y`, размер `widget.width ×
widget.computedHeight`), а высоту раздаёт `LGraphNode._arrangeWidgets`:

```js
if (w.computeSize) { height = w.computeSize()[1] + 4; fixedWidgetHeight += height }
else if (w.computeLayoutSize) growableWidgets.push({...})   // ← сюда попадает DOMWidgetImpl
... distributeSpace(Math.max(0, freeSpace), spaceRequests) // всё свободное место
```

Отсюда контракт растяжения (проверен статическим аудитом):

| Требование | Как выполнено |
|---|---|
| Пол высоты | `getMinHeight: () => PREVIEW_MIN_H` (320) → `computeLayoutSize().minHeight`; в CSS `root { min-height: 320px }` для Vue (высоту там задаёт min-content замер) |
| Растяжение вниз | **`computeSize` НЕ задаётся и `options.getHeight`/`getMaxHeight` НЕ задаются**: `prefHeight` становится `maxHeight` распределения и зафиксировал бы высоту |
| `height:100%` + `overflow:hidden` на `root` | элемент заполняет выданную высоту в обоих режимах и обрезает содержимое |
| `isolation:isolate` на stage | группa смешивания ограничена превью: `mix-blend-mode: difference` смешивается с Image 1, а не с фоном ноды |
| Blend на КОРОБКЕ слоя, не на `<img>` | `<img>` лежит внутри `scene` (transform/will-change → stacking context), а stacking context изолирует mix-blend-mode — на `<img>` режим Difference смешивался только с пустотой сцены и не работал (регрессия DOM-переписывания, поймана красным тестом) |
| Без `z-index` | порядок слоёв — DOM-порядок (`appendChild` переносит узел): `z-index` создаёт stacking context и сломал бы `mix-blend-mode` |
| Панель свойств | `hideInPanel: true` — иначе панель пишет `widget.width` и сжимает превью |
| Ширина в Vue | `[data-node-id]` → `style.minWidth`, повторно через один `requestAnimationFrame` (Vue монтирует ноду асинхронно) |
| Запрещённые приёмы | нет `setInterval`, `MutationObserver`, `scrollHeight`/`offsetHeight`, нет перехвата `proto.computeSize`/`node.onMouseMove`, нет глобальных слушателей |

### 4.3. События: никакого моста координат

В classic-режиме DOM-виджет лежит в оверлее **над** холстом графа, поэтому
события доходят до самого элемента — как и в Nodes 2.0. Все обработчики
висят на узлах превью (`bindPreviewEvents`):

- `wheel`: зум — только `Alt` при разрешённой навигации (гейт ниже); всё
  остальное колесо (без `Alt`, либо `Alt` при выключенной навигации)
  **форвардится синтетическим `WheelEvent` на `app.canvas.canvas`**
  (`forwardWheelToCanvas`, без `altKey`, чтобы граф не зумился повторно, и с
  `preventDefault`/`stopPropagation` на оригинале): в classic-режиме наш
  DOM-виджет — сосед канвы, и событие без форварда до неё не доходит
  (аналог `forwardEventToCanvas` во Vue-режиме);
- `pointerdown`/`pointermove`/`pointerup`/`pointercancel` — шторка и панорама
  (через `setPointerCapture` продолжение драга вне элемента);
- **гейт навигации** `navEnabled(node)`: в stage wheel — условие
  `e.altKey && navEnabled(node)`, в остальных обработчиках зума/панорамы
  (stage pointerdown, guard wheel, guard pointerdown) — ранний `return`;
  зум/панорама работают **только в режиме Side-by-Side с видимой парой кадров** —
  режимы Off/Slider и одиночные виды Image 1 / Image 2 показывают один кадр,
  там навигировать нечего; при закрытом гейте событие уходит графу
  (ранний `return` без `preventDefault`/`stopPropagation`, а для wheel —
  форвард через `forwardWheelToCanvas`);
- `dblclick` — сброс зума/панорамы;
- `mouseenter`/`mouseleave` на кнопке `?` — подсказка.

`node.onMouseMove` **не перехватывается**, `window`/`document`-слушателей нет —
именно они и оставляли подсказки на экране.

**Nodes 2.0, capture-guard:** `TransformPane` в Nodes 2.0 висит над холстом и в
capture-фазе перехватывает `wheel`/`pointermove` раньше наших target-слушателей
на `stage`. Поэтому зум и панорама дублируются capture-слушателями на предке
**выше** TransformPane: `canvasGuardEl(node)` идёт от элемента ноды
`[data-node-id]` вверх до корня документа, `bindGuardEvents(node)` вешает
`wheel`/`pointerdown`/`pointermove`/`pointerup` (третий аргумент `true`) и
принимает событие только если `stage.contains(e.target)` (наши события) и
`e.altKey` для колеса. Слушатели снимаются в `onRemoved` (`st.guard.dispose()`).

### 4.4. Управление

| Действие | Как |
|---|---|
| Slider | позиция идёт за курсором по X (как в стандартной ноде ComfyUI `ImageCompare` → `WidgetImageCompare.vue`/`useMouseInElement`), drag не нужен |
| Подписи размеров | футер `dsc-footer` (18px) ПОД областью изображения, на сером поле — не поверх кадра; Image 1 — белым (`#ffffff`), Image 2 — серым (`#999999`), без цветной подсветки |
| Классы превью | `clip-path: inset(0 <100-pos>% 0 0)` на слое Image 1 — клип в локальных координатах слоя, линия шторки остаётся на месте при зуме/панораме |
| Зум (кроме Blink) | `Alt` + колесо, 1.0×–10.0×; **только в Side-by-Side с видимой парой** (`navEnabled`) |
| Панорама | средняя кнопка + перетаскивание (при зуме > 1); **только в Side-by-Side с видимой парой** (`navEnabled`) |
| Сброс зума/панорамы | двойной клик по превью |
| Подсказка | DOM-блок под кнопкой `?`: показывается на `mouseenter`, гасится на `mouseleave`, при клике по превью и при `blur` |
| Сохранить текущий вид | кнопка — снимок «как видишь» (JPEG 0.80, offscreen-canvas повторяет геометрию превью); для Blink — GIF |

| Режим | Как отрисован |
|---|---|
| Slider | **всегда шторка** — выбор вида кнопками здесь игнорируется (`st.sliderView` применяется только в Side-by-Side, по задаче): Image 2 снизу, Image 1 сверху с `clip-path` по позиции шторки. Линия шторки — тонкая **серая** вертикаль **1px** (`#808080`) **без ручки `dsc-knob` и сегментов** (по задаче; `dsc-knob` и жёлтый `#FFEE00` удалены) |
| Side-by-Side | вид выбирается кнопками в футере (`st.sliderView`): **Пара** (иконка «два прямоугольника рядом»; «Сетка» удалена — дублировала Шторку) — пара половинок (`sbsHalfLayout`, визуально одинаковая раскладка), **Image 1**/**Image 2** — одиночный кадр на весь превью. Ориентация (`sbsOrientation`): **ландшафт → кадры друг над другом** (`calc(50% ± 1px)` по Y), **портрет → слева и справа** (по X); выбор по Image 1 (fallback Image 2), без картинок — слева/справа; у каждой половины свой фокус (`sbsHalfTransform`) с **панорамой** (`translate(tx + st.panX, ty + st.panY)`), канвас-композит тоже учитывает `st.panX/panY` в `dX/dY`; при сбросе зума панорама обнуляется; захват «как видишь» повторяет ориентацию (канвас ×2 по высоте или по ширине, одиночный вид — обычный размер) |
| Overlap | Image 2 снизу, Image 1 сверху с `opacity` |
| Difference | Image 1 снизу, Image 2 сверху; `mix-blend-mode: difference` — на **коробке слоя** (не на `<img>`: внутри `scene` blend изолирован transform-ом и не работал) |
| Blink | CSS-анимация `@keyframes dscBlink` (1→0→1 за две фазы, длительность `2 × blink_speed`), без перерисовки канвы |
| Off | чистый просмотрщик Image 1: без шторки/клипа/blend/анимации, Image 1 поверх Image 2; подпись размера — **одна (Image 1) по центру футера**, подпись Image 2 скрыта. **Режим по умолчанию** (первый в `MODES`, `default: "Off"`), навигация закрыта |

**Селектор вида** (`dsc-view`, 3 кнопки: **Пара** с иконкой «два
прямоугольника рядом» — квадрат 16×16, `borderRadius: 3px`, два child-узла
5×10, **фолбэк — пустой квадрат**; Image 1/Image 2 — круги 16px; старое
значение вида `grid` уходит в fallback `"split"`) лежит в
футере подписей, показан **только в режиме Side-by-Side** (в остальных режимах
`display: none`); выбор хранится в
`st.sliderView` (по умолчанию `"split"`). Режим и вид уважаются и при захвате
«как видишь»: `captureComposite`/`drawComposite` рисуют ровно выбранное
(Off/img1 → только Image 1, img2 → только Image 2, пара → обе, канвас вдвое
шире), `saveCurrentView` для одиночного вида требует только своей картинки.

### 4.5. ⭐ Персистентность картинок (исправление бага OreX)

**Симптом (в OreX):** переключиться на другой воркфлоу и вернуться — картинки
в ноде пропадают.

**Причина:** изображения жили только в памяти JS (`st.img1`/`st.img2`),
заполнялись в `onExecuted`. При переключении воркфлоу нода пересобирается из
JSON, `onExecuted` повторно **не вызывается** — слоты пустеют.

**Решение:** метаданные пишутся в `node.properties` (`dsc_meta`, `dsc_open_path`)
— а `properties` единственное пользовательское поле, которое попадает в
`LGraphNode.serialize()` (`o.properties = cloneObject(state.properties)`).
`onConfigure` читает их и заново грузит файлы из `/view`.

Также учтено: `temp/` чистится при перезапуске ComfyUI — отсутствующий файл
обнуляет слот (`onerror`) и гасит DOM-слой, а не оставляет пустую рамку с
подписью.

### 4.6. ⭐ Битая картинка не роняет отрисовку

У `<img>` с 404 `complete === true`, но `naturalWidth === 0` — это состояние
`'broken'`, и `ctx.drawImage()` на нём бросает
`InvalidStateError: The HTMLImageElement provided is in the 'broken' state`.
Это и давало «глюки изображения при переключении воркфлоу»: файл из `temp/`
исчез, а кадр отрисовки падал с ошибкой (в консоли — пачка исключений).

Правила:

- для отрисовки/захвата элемент обязан пройти `isDrawable(img)`
  (`complete !== false && naturalWidth > 0`); в `drawComposite` это `ok1`/`ok2`,
  в `drawSideBySideComposite` — `if (!isDrawable(box.img)) continue`;
- `captureComposite` при неготовой картинке возвращает `null` (кнопка сообщает
  «Нужны изображения для этого режима»), а не падает;
- сам показ превью — это `<img>` без `drawImage`, так что битый файл просто не
  виден (`onerror` → `display:none` + слот обнулён);
- `setSlotImage` ставит `onerror`/`onload` и состояние **до** `img.src`: кэш
  может ответить синхронно, и проверка `st.img1 === img` по старому значению не
  сработала бы — битый слой остался бы в срезе.

## 5. Отличия от исходников (осознанные)

| Отличие | Почему |
|---|---|
| Верх ноды: тумблер → префикс → кнопка открытия | по задаче; в OreX сверху были виджеты режима |
| Кнопка «Сохранить текущий вид» — после `blink_speed` | в OreX она была первой, но верх занят по задаче |
| Превью — DOM-виджет, а не canvas | только DOM-виджет растягивается вместе с нодой в обоих режимах и даёт настоящие события (см. §4.2); в OreX холст рисовался на канве с фиксированной высотой |
| Подсказка — DOM-блок под кнопкой `?` | гашение по `mouseleave` надёжно; в OreX/старой версии тултип жил в `onMouseMove` и оставался на экране (`drawTooltip` удалён) |
| Шторка идёт за курсором без drag | как в стандартной ноде `ImageCompare`; drag-состояние не требуется в обоих режимах |
| Фон превью и футера подписей — `transparent` | тёмное поле `#18181c` заменено прозрачным: под DOM-виджетом виден серый фон ноды `#353535`, превью выглядит как обычная область ноды |
| Слайдеры `opacity`/`blink_speed` — `options.slider_color = "#666"` | без цветной заливки дорожки: нейтральный серый, как у стандартных виджетов (fallback слайдера `#678` — серо-синий) |
| Файлы режимов: `Degg_Compare_*` вместо `OreX_Compare_*` | своё имя ноды |
| Вход `output_path` убран | по задаче |
| `image_1` обязателен | выход ноды = Image 1, поэтому источник определён всегда |
| В режиме Preview видны только temp-файлы | как в `SavePreviewImage` |

## 6. Проверки

```bash
cd Degg_Images_Save_Compare
python tests/_test_degg_images_save_compare.py   # → FAIL: 0 / ТЕСТ ПРОЙДЕН
node tests/_smoke_degg_images_save_compare.mjs   # → SMOKE OK
node tests/_audit_degg_images_save_compare.mjs   # → аудит чист
python ../_process/check.py Degg_Images_Save_Compare
```

## 7. Рабочая копия

`D:\ComfyUI_windows_portable\ComfyUI\custom_nodes\Degg_Images_Save_Compare\`
(синхронизация: `python sync.py Degg_Images_Save_Compare`, затем перезапуск ComfyUI)
