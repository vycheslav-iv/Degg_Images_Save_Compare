# Память сессии — Degg_Images_Save_Compare (2026-10-08)

> Покажи этот файл агенту, чтобы продолжить работу.
> Всегда сверяйся с `AGENTS.md` и `SPECIFICATION.md`.

---

## 1. Что делали в этой сессии (кратко)
- Выполнена 5-пунктовая правка JS (п.2 отменён пользователем): (1) форвард колеса
  без Alt/при закрытом гейте на `app.canvas.canvas`; (3) SBS-селектор вида:
  два кружка Шторка/Сетка → 3 кнопки (Пара с иконкой / Image 1 / Image 2);
  (4) тест «alt+wheel в паре зумит обе сцены»; (5) `background: transparent`
  в root/footer превью; (6) `slider_color: #666` для `opacity`/`blink_speed`.
- Процесс red-first (§2.3): красная база ДО правок — smoke 199/16, audit 182/9;
  после — smoke 215/0, audit 191/0, python 60/0.
- Мутационное тестирование: 11 мутаций (M1–M11) — все RED(OK), восстановление зелёное.
- Обновлены `SPECIFICATION.md` (§4.3 события, селектор вида, таблица отличий)
  и `check.json` (обоих description под новые факты; expect не тронуты).
- Создан git-репозиторий: `https://github.com/vycheslav-iv/Degg_Images_Save_Compare`
  (commit `1b30ec9`, 9 файлов, master → origin). Строка добавлена в AGENTS.md §6.1.
- Синхронизация `python sync.py Degg_Images_Save_Compare` выполнена (4 файла,
  `__pycache__` очищен); `check.py` и `check.bat` — зелёные (провалов 0).

## 2. Итоговое состояние кода
- `web/js/degg_images_save_compare.js` (CRLF, версия `2.14.0-wheel-fwd-viewpair`):
  - `VIEW_ITEMS` — 3 пункта `{id:"dsc-view-split", pair:true}` + img1/img2 (js:119);
  - сборка кнопок вида: `borderRadius: item.pair ? "3px" : "50%"` + иконка из
    2 child-узлов 5×10, фолбэк — пустой квадрат (js:983–1028);
  - `forwardWheelToCanvas(e)` — синтетический WheelEvent на `app.canvas.canvas`
    без `altKey`, c preventDefault/stopPropagation (js:1094, вызов js:1142);
  - stage wheel: `if (e.altKey && navEnabled(node))` зум, иначе форвард (js:1132);
  - root/footer `background: "transparent"`; захват канваса `fillStyle="#18181c"` — НЕ трогать;
  - `hookModeWidgets`: `w.options.slider_color = "#666"` (js:1663–1670).
- Тесты: `tests/_smoke_degg_images_save_compare.mjs` — 215 ok / 0 FAIL;
  `tests/_audit_...` — 191/0; `tests/_test_...py` — 60/0.
- Мутационный драйвер: `C:\Users\dggio\AppData\Local\Temp\opencode\dsc_mutations.py`
  (M1–M11, бэкап JS рядом в temp).

## 3. Проблемы, которые встречались (и как решали)
- Событие колеса от legacy DomWidget не доходит до канвы (она — сосед в DOM) —
  решено форвардом `forwardWheelToCanvas` (аналог Vue `forwardEventToCanvas`).
- Синтетика БЕЗ `altKey`, иначе граф зумится повторно; на оригинале — preventDefault/stopPropagation.
- Мутация M3 показала: `altKey` в opts ломает ровно одну audit-проверку — так и должно.

## 4. Что важно не сломать при продолжении работы
- Запрещено в JS: `zIndex`, `scrollHeight|offsetHeight`, `getHeight:`,
  `setInterval`, глобальные слушатели; сохранить 3 API-роута, `mixBlendMode:"difference"`
  на `st.dom.b.box`, help-кнопку `rgba(24,24,28,0.75)`, `fillStyle="#18181c"` канваса.
- `check.json`: ровно 3 проверки; expect-строки не менять.
- Python `degg_images_save_compare.py` в этой сессии НЕ менялся (60/0).
- Перед правками sizing/layout — читать исходники фронтенда (скил `comfyui-frontend-sources`).

## 5. Следующие шаги (идеи, не сделано)
- Перезапуск ComfyUI + Hard Reload пользователем (JS синхронизирован, но не подтверждён живьём).
- Скил-предложение (ждёт «да»): вынести паттерн «forward wheel с legacy DomWidget
  на канву графа» — дополнить `comfyui-js-extension` или новый скил.
- Живые пробы `_probe_live_*` не писались (headless-покрытия хватило).

## 6. Связанные файлы
- `F:\AI_projects\Custom_node_ComfyUI\Degg_Images_Save_Compare\` — исходник (`.git` здесь)
- `D:\ComfyUI_windows_portable\ComfyUI\custom_nodes\Degg_Images_Save_Compare\` — рабочая копия
- `SPECIFICATION.md`, `check.json` — обновлены под эту сессию
- `C:\Users\dggio\AppData\Local\Temp\opencode\dsc_mutations.py` — мутатор (temp)
