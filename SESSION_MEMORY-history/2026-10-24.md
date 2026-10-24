# Память сессии — Degg_Images_Save_Compare (2026-10-20)

> Покажи этот файл агенту, чтобы продолжить работу.
> Всегда сверяйся с `AGENTS.md` и `SPECIFICATION.md`.

---

## 1. Что делали в этой сессии (кратко)

- **Багфикс «превью старое после фонового прогона»** — второй, независимый от §4.9
  канал: `executed` сервер шлёт конкретному клиенту (`sid = client_id` промпта),
  при закрытом сокете (первая генерация после рестарта ComfyUI, скрытая вкладка)
  событие теряется безвозвратно; фронтенд на `reconnected` чинит только очередь.
- Лечение — догон по истории: `setup()` подписан на `api.addEventListener("reconnected")`
  → `catchUpFromHistory()` берёт `/history?max_items=10`, сортирует по `prompt[0]`
  и применяет выход самой свежей записи через ту же `applyOutput`.
- Версия JS `2.18.0-reconnect-catchup`; спека §4.11, скил
  `comfyui-background-run-catchup` (3 копии) продлён разделом §2.1.
- Коммит `4fce31c` → https://github.com/vycheslav-iv/Degg_Images_Save_Compare
  (master). Синхронизировано в рабочую копию ComfyUI.

## 2. Итоговое состояние кода

- `web/js/degg_images_save_compare.js:51` — `DSC_JS_VERSION = "2.18.0-reconnect-catchup"`.
- `web/js/degg_images_save_compare.js:1792` — `applyOutput(node, output)` — ЕДИНАЯ
  точка разбора выхода для трёх входов: `onExecuted`, `applyRestoredOutputs`, догон.
- `web/js/degg_images_save_compare.js:1894` — `applyRestoredOutputs(outputs)` —
  хук `onNodeOutputsUpdated` (возврат на другой воркфлоу), гейт по типу + `findNode`.
- `web/js/degg_images_save_compare.js:1935` — `historyQueueNumber(rec)` — номер
  очереди из `rec.prompt[0]`; `:1941` — `catchUpFromHistory()` — один запрос
  истории, `RECONNECT_CATCHUP_BUSY`, `break` после первой найденной записи.
- `web/js/degg_images_save_compare.js:2043` — хук `onNodeOutputsUpdated`;
  `:2053` — `setup()` с подпиской на `reconnected` и флагом `RECONNECT_HOOKED`.
- `tests/_probe_live_reconnect.py` — живая проба разрыва: `wait_for` (174),
  `history_record` (197), промпт с `client_id` страницы; нода в промпте id `1`,
  `LoadImage` id `3`; ретрай загрузки `<img>`.
- `degg_images_save_compare.py:64` — `_stamp_for()`, `:197` — запись PNG + `stamp`,
  `:267` — `ui.degg_compare_images` (штами — предыдущий фикс, не ломать).
- `SPECIFICATION.md` §4.11 — «Прогон в разрыве связи: догон по `/history`»;
  §4.9 — оговорка про `api.addEventListener`.

## 3. Проблемы, которые встречались (и как решали)

- **Ложный FAIL пробы**: ключи `outputs` в истории — id нод **промпта**, а не графа.
  Проба отправляла нашу ноду под id `2` при ноде графа `1` → догон «не находил»
  выход на исправном коде. Исправлено: id совпадают (`1`).
- **Транспортный флейк**: `<img>` с уже выставленным `src` однажды не загрузился
  за 20 с (`loaded=false`, `/view` позже 200). Добавлен ретрай `im.src = im.src`
  + вторая попытка ожидания; контроль — 3 прогона подряд `9/0`.
- **commit-msg хук** блокирует имена файлов, которых нет в индексе: в сообщении
  нельзя упоминать не изменённые файлы (`_probe_live_stale.py`, `check.py`,
  `*.ts`). Переформулировать без имён.

## 4. Что важно не сломать при продолжении работы

- ⛔ Два канала — два разных лечения: хук `onNodeOutputsUpdated` (смена воркфлоу)
  и догон по `/history` (разрыв связи). Не «унифицировать» в один.
- ⛔ Не использовать `api.getHistory()` (в 1.55.x — `JobListItem[]` без `outputs`)
  и не «реконнектить» через `api.resetSocket()` (даёт `isReconnect = false`,
  `reconnected` не приходит).
- ⛔ Никаких timers/`visibilitychange`/`window`-слушателей: только
  `api.addEventListener` — штатная шина фронтенда.
- Идемпотентность и штамп: `applyOutput` не откатывает превью на старый файл;
  повторный реконнект безопасен.
- Nodes 2.0: `const { app } = window.comfyAPI.app`, api — `window.comfyAPI.api.api`
  (namespace ≠ клиент).
- `_process/PROCESS.md`-правила: правки → `python sync.py Degg_Images_Save_Compare`
  → перезапуск ComfyUI + Hard Reload (Ctrl+F5).

## 5. Следующие шаги (идеи, не сделано)

- Живая проверка пользователем: рестарт ComfyUI → генерация при уходе со страницы
  → возврат: превью обязано показать новый файл (проба `9/0` подтверждает код).
- При желании — распространить паттерн на другие ноды с превью (смоук/аудит уже
  переносимы).
- Проба эмулирует разрыв подменой `api_host`; отдельный сценарий «настоящий
  рестарт сервера» не автоматизирован.

## 6. Связанные файлы

- `SPECIFICATION.md`, `check.json`, `SESSION_MEMORY-history/`
- `web/js/degg_images_save_compare.js`, `degg_images_save_compare.py`
- `tests/_test_degg_images_save_compare.py` (61/0), `tests/_smoke_*.mjs` (288/0),
  `tests/_audit_*.mjs` (274/0), `tests/_probe_live_reconnect.py` (9/0),
  `tests/_probe_live_switch.py` (20/0), `tests/_probe_live_stale.py` (15/0)
- Скил: `.opencode|.kilo|.agents/skills/comfyui-background-run-catchup/SKILL.md`
