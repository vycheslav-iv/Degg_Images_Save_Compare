// Статический аудит Degg_Images_Save_Compare — без ComfyUI и браузера.
// Проверяет согласованность Python ↔ JS ↔ check.json ↔ README и запрещённые
// приёмы из AGENTS.md (§4.1 «Совместимость с Nodes 2.0», §5 «Типичные проблемы»).
//
// Запуск:  cd Degg_Images_Save_Compare && node tests/_audit_degg_images_save_compare.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BUNDLE = fileURLToPath(new URL("../..", import.meta.url));

const errors = [];
const oks = [];
const check = (label, cond, extra = "") => {
  (cond ? oks : errors).push(label);
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}${!cond && extra ? "  [" + extra + "]" : ""}`);
};
const has = (s, re, label) => check(label, re.test(s), String(re));
const read = (rel) => {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) return null;
  // CRLF-нормализация: regex-и чеков пишутся с \n и не должны зависеть
  // от переводов строк (на CRLF-файле аудит иначе падает ложно — красный прогон 167/10).
  return fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
};
// Запрещённые приёмы ищем ТОЛЬКО в коде: в комментариях они упоминаются
// именно как запрещённые, и детектор по сырому тексту давал бы ложный FAIL.
const stripComments = (s) =>
  s
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");

// ── 1. Состав проекта ─────────────────────────────────────────────────────
const PY = read("degg_images_save_compare.py");
const JS = read("web/js/degg_images_save_compare.js");
const INIT = read("__init__.py");
const SPEC = read("SPECIFICATION.md");

check("degg_images_save_compare.py существует", !!PY);
check("web/js/degg_images_save_compare.js существует", !!JS);
check("__init__.py существует", !!INIT);
check("SPECIFICATION.md существует", !!SPEC);

if (INIT) {
  has(INIT, /WEB_DIRECTORY\s*=\s*"web"/, "__init__: WEB_DIRECTORY = 'web'");
  has(INIT, /from \.degg_images_save_compare import (NODE_CLASS_MAPPINGS|NODE_DISPLAY_NAME_MAPPINGS)/,
    "__init__: импорт маппингов из degg_images_save_compare");
  check("__init__: нет лишнего кода",
    INIT.trim().split("\n").filter((l) => l.trim() && !l.startsWith("#")).length <= 8);
}

// ── 2. Python: класс, входы, UI-контракт ──────────────────────────────────
let pyInputs = [];
let pyOptional = [];
if (PY) {
  has(PY, /^class DeggImagesSaveCompare:/m, "python: class DeggImagesSaveCompare");
  has(PY, /RETURN_TYPES\s*=\s*\("IMAGE",\)/, "python: RETURN_TYPES = ('IMAGE',)");
  has(PY, /RETURN_NAMES\s*=\s*\("image_1",\)/, "python: RETURN_NAMES = ('image_1',)");
  has(PY, /FUNCTION\s*=\s*"save_compare"/, "python: FUNCTION = save_compare");
  has(PY, /CATEGORY\s*=\s*"My_custom_nodes\/Image"/, "python: CATEGORY = My_custom_nodes/Image");
  has(PY, /OUTPUT_NODE\s*=\s*True/, "python: OUTPUT_NODE = True");

  const mapKey = (PY.match(/NODE_CLASS_MAPPINGS\s*=\s*\{\s*NODE_KEY\s*:/) || [])[0];
  check("python: маппинги через NODE_KEY", !!mapKey);
  has(PY, /NODE_KEY\s*=\s*"Degg_Images_Save_Compare"/, "python: NODE_KEY = Degg_Images_Save_Compare");

  // Тяжёлые импорты только лениво (модуль импортируется без ComfyUI).
  const topHeavy = PY.match(/^(?:import|from)\s+(folder_paths|server|aiohttp|numpy|PIL|comfy)\b/gm) || [];
  check("python: нет тяжёлых импортов на уровне модуля", topHeavy.length === 0, JSON.stringify(topHeavy));
  has(PY, /^\s+import folder_paths$/m, "python: folder_paths импортируется лениво");
  has(PY, /^\s+from PIL import Image$/m, "python: PIL импортируется лениво");

  // Роуты регистрируются в try/except (нет ComfyUI → нет роутов, импорт жив).
  has(PY, /def register_routes\(\)/, "python: register_routes() есть");
  has(PY, /^\s+from aiohttp import web$/m, "python: aiohttp импортируется внутри register_routes");
  has(PY, /^register_routes\(\)$/m, "python: register_routes() вызывается при импорте");

  // UI-контракт: свои ключи вместо images (иначе фронтенд рисует второе превью).
  has(PY, /"degg_compare_images":\s*ui_images/, "python: ui.degg_compare_images");
  has(PY, /"degg_open_path":\s*\[open_path\]/, "python: ui.degg_open_path");
  check("python: ui НЕ отдаёт ключ images (дубль превью)",
    !/"ui":\s*\{[^}]*"images"/.test(PY));

  has(PY, /def open_file_in_viewer/, "python: open_file_in_viewer()");
  has(PY, /os\.startfile/, "python: открытие файла через os.startfile (Windows)");

  const err404 = /FileNotFoundError/;
  has(PY, err404, "python: open_file различает «нет файла» (404)");

  // Входы INPUT_TYPES
  const block = (PY.match(/def INPUT_TYPES[\s\S]*?RETURN_TYPES/) || [])[0] || "";
  const reqPart = (block.match(/"required":\s*\{([\s\S]*?)\n\s*\},?\n\s*(?:"optional"|"hidden")/) || [])[1] || "";
  const optPart = (block.match(/"optional":\s*\{([\s\S]*?)\n\s*\},?\n\s*(?:"hidden"|\})/) || [])[1] || "";
  pyInputs = [...reqPart.matchAll(/"(\w+)":\s*\(/g)].map((m) => m[1]);
  pyOptional = [...optPart.matchAll(/"(\w+)":\s*\(/g)].map((m) => m[1]);

  check("python: image_1 обязателен", pyInputs.includes("image_1"), JSON.stringify(pyInputs));
  check("python: image_2 опционален", pyOptional.includes("image_2"), JSON.stringify(pyOptional));
  check("python: порядок виджетов = Save/Preview → префикс → OreX-блок",
    JSON.stringify(pyInputs.filter((n) => n !== "image_1")) ===
      JSON.stringify(["save_mode", "filename_prefix", "mode", "opacity", "blink_speed"]),
    JSON.stringify(pyInputs));
  check("python: вход output_path отсутствует (убран по задаче)",
    !pyInputs.includes("output_path") && !pyOptional.includes("output_path"));
  check("python: 6 режимов, Off первым (по умолчанию просмотрщик)",
    /"Off",\s*"Slider",\s*"Side-by-Side",\s*"Overlap",\s*"Difference",\s*"Blink"/.test(PY),
    "порядок MODES");
  check("python: режим по умолчанию — Off",
    /"mode":\s*\(MODES,\s*\{[\s\S]{0,160}?"default":\s*"Off"/.test(PY),
    "default mode");
  check("python: save_mode default True, подписи Save/Preview",
    /"save_mode"[\s\S]{0,160}?"default":\s*True/.test(PY) &&
    /"label_on":\s*"Save"/.test(PY) && /"label_off":\s*"Preview"/.test(PY));
}

// ── 3. JS: контракт фронтенда ─────────────────────────────────────────────
const JSC = JS ? stripComments(JS) : "";
if (JS) {
  has(JS, /const DSC_JS_VERSION\s*=\s*"/, "js: маркер сборки DSC_JS_VERSION");
  has(JS, /console\.log\(`\[Degg_Images_Save_Compare\] JS \$\{DSC_JS_VERSION\} loaded`\)/,
    "js: маркер сборки печатается в консоль");
  has(JS, /window\.comfyAPI\.app/, "js: app через window.comfyAPI.app (Nodes 2.0)");
  has(JS, /comfyAPI\.api\.api/, "js: api через comfyAPI.api.api (не namespace)");
  check("js: нет старого импорта scripts/app.js", !/scripts\/app\.js/.test(JSC));
  check("js: нет top-level import", !/^import\s/m.test(JSC));
  check("js: нет top-level await", !/^await\s/m.test(JSC));
  check("js: нет мёртвой ветки fp.el (фронтенд: widget.el/.el.style — 0 вхождений)", !/fp\.el/.test(JSC));
check("js: help-box рамка монохромная (нет sky-акцента 56,189,248)", !/56,\s*189,\s*248/.test(JSC));

  has(JS, /const EXT_NAME\s*=\s*"Degg_Images_Save_Compare"/, "js: EXT_NAME");
  has(JS, /const NODE_NAME\s*=\s*"Degg_Images_Save_Compare"/, "js: NODE_NAME");
  has(JS, /app\.registerExtension/, "js: app.registerExtension");
  has(JS, /beforeRegisterNodeDef/, "js: beforeRegisterNodeDef");
  has(JS, /nodeData\.name !== NODE_NAME/, "js: фильтр по имени ноды");

  // Превью — DOM-виджет: растяжение (пол высоты, без pinning) + настоящие события.
  has(JS, /node\.addDOMWidget\(PREVIEW_WIDGET/, "js: превью через addDOMWidget (DOM-виджет, оба режима)");
  has(JS, /getMinHeight:\s*\(\)\s*=>\s*PREVIEW_MIN_H \+ PREVIEW_MARGIN \* 2/,
    "js: DOM-виджет отдаёт ПОЛ высоты (getMinHeight с полями margin)");
  has(JS, /margin:\s*PREVIEW_MARGIN/, "js: margin DOM-виджета задан явно (оверлей вычитает margin*2)");
  check("js: options.getHeight/getMaxHeight НЕ заданы (prefHeight = maxHeight пинит высоту)",
    !/getHeight\s*:/.test(JSC) && !/getMaxHeight\s*:/.test(JSC));
  check("js: у превью нет legacy computeSize (иначе высота точная и не растёт)",
    !/computeSize\s*:/.test(JSC) && !/computeSize\s*\(width\)\s*\{/.test(JSC));
  check("js: canvas-draw/mouse у превью не объявляются (высота строки им не передаётся)",
    !/function makePreviewWidget/.test(JSC) && !/\bmouse\(e,\s*pos/.test(JSC));
  has(JS, /const PREVIEW_MIN_H\s*=\s*320/, "js: PREVIEW_MIN_H = 320");
  has(JS, /minHeight:\s*PREVIEW_MIN_H\s*\+\s*"px"/, "js: root получает CSS-пол высоты");
  has(JS, /height:\s*"100%",\s*\n\s*minHeight/, "js: root заполняет высоту DOM-виджета (height:100%)");
  has(JS, /isolation:\s*"isolate"/, "js: stage изолирует смешивание (mix-blend-mode не уходит в фон)");
  check("js: режимы НЕ используют z-index (иначе mix-blend-mode не увидит Image 1)",
    !/zIndex/.test(JSC));
  has(JS, /function setPaintOrder/, "js: порядок слоёв — DOM-порядок (appendChild), без z-index");
  check("js: canvasOnly:true НЕ выставляется в коде",
    !/canvasOnly\s*:\s*true/.test(JSC));
  has(JS, /hideInPanel:\s*true/, "js: hideInPanel:true (панель свойств не перепишет widget.width)");
  has(JS, /serialize:\s*false/, "js: serialize:false");
  has(JS, /expandToFitContent/, "js: размер ноды догоняет сумму виджетов");

  // Запрещённые приёмы (§5 AGENTS.md)
  check("js: proto.computeSize НЕ перезаписывается", !/proto\.computeSize\s*=/.test(JSC));
  check("js: proto.computeLayoutSize НЕ перезаписывается", !/proto\.computeLayoutSize\s*=/.test(JSC));
  check("js: this.computeSize на ноде НЕ перезаписывается", !/this\.computeSize\s*=/.test(JSC));
  check("js: node.onMouseMove НЕ перезаписывается (мост координат нода↔виджет убран)",
    !/node\.onMouseMove\s*=/.test(JSC));
  check("js: нет setInterval (вечные таймеры)", !/setInterval/.test(JSC));
  check("js: нет MutationObserver для layout", !/MutationObserver/.test(JSC));
  check("js: нет scrollHeight/offsetHeight в sizing", !/scrollHeight|offsetHeight/.test(JSC));
  check("js: нода не вешает глобальных слушателей (они и оставляли подсказки на экране)",
    !/window\.addEventListener|document\.addEventListener/.test(JSC));
  has(JS, /function bindPreviewEvents/, "js: все события — на DOM-элементе превью");
  has(JS, /addWidget\("button"/, "js: кнопки через нативный addWidget('button')");

  // Шторка — как в стандартной ноде ComfyUI (ImageCompare → useMouseInElement).
  has(JS, /function setSliderFromClientX/, "js: шторка по X курсора");
  check("js: шторка идёт за курсором на pointermove без drag-состояния",
    /addEventListener\("pointermove"[\s\S]{0,900}?setSliderFromClientX\(node, e\.clientX\)/.test(JSC));
  has(JS, /clipPath:\s*`inset\(0 \$\{pct\(1 - pos\)\} 0 0\)`/, "js: клип шторки через clip-path");
  has(JS, /function applyMode/, "js: applyMode переключает режимный CSS");
  has(JS, /mixBlendMode:\s*"difference"/, "js: Difference через mix-blend-mode");
  has(JS, /css\(st\.dom\.b\.box,\s*\{\s*mixBlendMode:\s*"difference"\s*\}/,
    "js: Difference — blend на КОРОБКЕ слоя (img внутри scene с transform/will-change изолирован в своём stack context)");
  check("js: mixBlendMode НЕ применяется к <img> (иначе blend виден только внутри scene и режим не работает)",
    !/css\([\w.]*\.img,\s*\{[^}]*mixBlendMode/.test(JSC));
  has(JS, /OPEN_LABEL_READY = "Open in Viewer"/,
    "js: кнопка открытия — «Open in Viewer» (как в Image Save/Preview)");
  has(JS, /OPEN_LABEL_EMPTY = "No image"/,
    "js: пустая подпись — «No image» (как в Image Save/Preview)");
  check("js: в подписях кнопок нет эмодзи-иконок (📷/💾)",
    !/OPEN_LABEL_(READY|EMPTY) = "[^"]*[📷💾🖼]/.test(JS));
  has(JS, /DOM_FOOTER\s*=\s*"dsc-footer"/, "js: футер подписей размеров dsc-footer");
  has(JS, /color:\s*"#ffffff"/, "js: подпись Image 1 — белая");
  has(JS, /color:\s*"#999999"/, "js: подпись Image 2 — серая");
  check("js: подписи вне изображения — stage обрезан по футеру",
    /bottom:\s*DIM_BAR_H \+ "px"/.test(JSC));
  has(JS, /function sbsOrientation/, "js: автовыбор ориентации Side-by-Side");
  has(JS, /iw > ih \? "v" : "h"/, "js: ландшафт → сверху/снизу, портрет → слева/справа");
  has(JS, /\(tx \+ st\.panX\)/, "js: SBS-трансформ учитывает панораму (panX/panY)");

  // Режим Off — просмотрщик Image 1 без сравнения; по умолчанию (первый в MODES).
  has(JS, /"Off",\s*"Slider",\s*"Side-by-Side",\s*"Overlap",\s*"Difference",\s*"Blink"\]/,
    "js: режим Off первым в MODES (по умолчанию просмотрщик)");
  has(JS, /mode === "Off"/, "js: applyMode обрабатывает Off");
  check("js: жёлтый #FFEE00 удалён — слайдер как в стандартной ноде",
    !/FFEE00/.test(JSC));
  check("js: круг-ручка dsc-knob УДАЛЕНА (по задаче — тонкая линия)", !/dsc-knob/.test(JSC));
  has(JS, /const line = el\(doc, "div", \{[\s\S]{0,200}?width:\s*"1px"/,
    "js: линия шторки тонкая (1px, вдвое тоньше)");
  has(JS, /const line = el\(doc, "div", \{[\s\S]{0,300}?background:\s*"#808080"/,
    "js: линия шторки серая (#808080)");
  has(JS, /dim1[\s\S]{0,80}textAlign:\s*"center"/,
    "js: Off — подпись Image 1 отцентрована (один размер)");
  has(JS, /dim2, \{ display:\s*"none" \}/,
    "js: Off — подпись Image 2 скрыта");

  // Селектор вида: 3 кнопки в футере (Пара с иконкой / Image 1 / Image 2).
  // П.3: Шторка и Сетка давали одинаковую пару половин — «Сетка» удалена.
  has(JS, /DOM_VIEW\s*=\s*"dsc-view"/, "js: селектор вида dsc-view");
  has(JS, /dsc-view-split[\s\S]{0,400}?dsc-view-img1[\s\S]{0,400}?dsc-view-img2/,
    "js: 3 пункта селектора (Пара/Image 1/Image 2)");
  check("js: dsc-view-grid удалён (Сетка дублировала Шторку)", !/dsc-view-grid/.test(JS));
  has(JS, /viewSel[\s\S]{0,80}display: mode === "Side-by-Side"/,
    "js: селектор вида показывается только в режиме Side-by-Side");
  has(JS, /st\["sliderView"\]|st\.sliderView\s*=/, "js: выбор вида хранится в st.sliderView");
  check("js: кнопка пары — квадрат 16px (item.pair), остальные — круги",
    /borderRadius:\s*item\.pair \? "3px" : "50%"/.test(JSC)
    && /width:\s*"16px",\s*height:\s*"16px"/.test(JSC));
  check("js: иконка пары — два child-узла рядом (фолбэк: пустой квадрат)",
    /item\.pair[\s\S]{0,600}?dot\.appendChild\(bar\)/.test(JSC));
  check("js: старое значение вида grid уходит в fallback «пара»",
    /VIEW_VALUES\.indexOf\(view\) >= 0 \? view : "split"/.test(JSC));

  // Nodes 2.0: capture-предок над TransformPane (Alt+wheel и средняя кнопка).
  has(JS, /function canvasGuardEl/, "js: canvasGuardEl ищет предка по [data-node-id]");
  has(JS, /addEventListener\("wheel",\s*\w+,\s*true\)/,
    "js: wheel-перехват на capture-предке (TransformPane иначе съедает событие)");
  has(JS, /stage\.contains\(e\.target\)/,
    "js: capture-перехват работает только для событий из нашего превью");
  has(JS, /animation:\s*`\$\{BLINK_KEYFRAMES\}/, "js: Blink через CSS-анимацию (без перерисовки канвы)");
  has(JS, /function zoomAt/, "js: zoomAt (Alt + колесо)");
  has(JS, /altKey/, "js: зум только при Alt (иначе колесо принадлежит графу)");
  has(JS, /function navEnabled\(node\)/,
    "js: навигация только при сравнении двух кадров (navEnabled)");
  has(JS, /function navEnabled\(node\)[\s\S]{0,300}currentMode\(node\) !== "Side-by-Side"/,
    "js: navEnabled требует режим Side-by-Side (навигация только в SBS)");
  check("js: зум/панорама закрыты при одном изображении (гейты navEnabled)",
    (JSC.match(/if \(!navEnabled\(node\)\) return;/g) || []).length >= 3
    && /if \(e\.altKey && navEnabled\(node\)\)/.test(JSC),
    `bare=${(JSC.match(/if \(!navEnabled\(node\)\) return;/g) || []).length}`);

  // П.1: колесо без Alt (и alt+wheel при выключенной навигации) — на канву графа.
  has(JS, /function forwardWheelToCanvas/, "js: форвард wheel на канву графа (forwardWheelToCanvas)");
  check("js: форвард уходит на app.canvas.canvas синтетическим WheelEvent",
    /forwardWheelToCanvas\(e\)/.test(JSC)
    && /app\.canvas\.canvas/.test(JSC)
    && /WheelEvent/.test(JSC));
  check("js: синтетический wheel не несёт altKey (иначе граф зумится повторно)",
    !/altKey:\s*e\.altKey/.test(JSC));

  // П.5: тёмное поле вокруг кадров заменено прозрачным (серый фон ноды).
  // fillStyle канваса (#18181c в захвате) вне области задачи — считаем только background-поля.
  check("js: тёмное поле #18181c удалено (корень и футер превью)",
    !/background:\s*"#18181c"/.test(JSC));
  check("js: фон превью/футера прозрачный — виден серый фон ноды",
    /background:\s*"transparent"/.test(JSC));

  // П.6: слайдеры без цветной заливки — нейтральный slider_color.
  check("js: hookModeWidgets ставит slider_color серым (#666) для слайдеров",
    /function hookModeWidgets[\s\S]{0,800}?slider_color/.test(JSC) && /"#666"/.test(JSC));
  has(JS, /function sbsHalfLayout/, "js: sbsHalfLayout (Side-by-Side)");

  // Подсказка — DOM-узел под кнопкой «?».
  has(JS, /DOM_HELP\s*=\s*"dsc-help"/, "js: DOM_HELP = dsc-help");
  has(JS, /addEventListener\("mouseleave"/, "js: подсказка гасится по mouseleave (не залипает)");
  check("js: canvas-тултипы и hover по строкам виджетов удалены",
    !/drawTooltip|onPreviewHover|setTooltip|tooltipKey/.test(JSC));

  // Битая картинка (404 = complete:true, naturalWidth:0) не роняет отрисовку.
  has(JS, /function isDrawable/, "js: isDrawable() — guard перед drawImage");
  has(JS, /num\(img\.naturalWidth, 0\) > 0/, "js: isDrawable проверяет naturalWidth > 0");
  check("js: drawImage никогда не получает сырой st.img1/st.img2",
    !/drawImage\(\s*st\.img/.test(JSC));

  // Жизненный цикл
  has(JS, /proto\.onNodeCreated\s*=/, "js: перехват onNodeCreated");
  has(JS, /proto\.onConfigure\s*=/, "js: перехват onConfigure (restore картинок)");
  has(JS, /proto\.onExecuted\s*=/, "js: перехват onExecuted");
  has(JS, /proto\.onRemoved\s*=/, "js: перехват onRemoved (чистка)");

  // Персистентность (исправление бага OreX: картинки пропадали при смене воркфлоу)
  has(JS, /function persistImages/, "js: persistImages()");
  has(JS, /function restoreImages/, "js: restoreImages()");
  has(JS, /properties\.dsc_meta/, "js: метаданные в node.properties.dsc_meta");
  has(JS, /properties\.dsc_open_path/, "js: путь Image 1 в node.properties.dsc_open_path");
  check("js: restore вызывается из onConfigure",
    /function onConfigure\(node\)[\s\S]{0,400}?restoreImages\(node\)/.test(JS));

  // Порядок виджетов
  has(JS, /insertWidgetAfter\(node,\s*openBtn,\s*W_PREFIX\)/,
    "js: кнопка открытия сразу после ячейки префикса");
  check("js: превью добавляется последним",
    /addButtons\(node\);\s*\n\s*addPreviewWidget\(node\);/.test(JS));

  // Режимы и сохранение
  for (const m of ["Slider", "Side-by-Side", "Overlap", "Difference", "Blink", "Off"]) {
    has(JS, new RegExp(`"${m.replace("-", "\\-")}"`), `js: режим ${m}`);
  }
}

// ── 4. Кросс-проверка Python ↔ JS ─────────────────────────────────────────
if (PY && JS) {
  const pyRoutes = [...PY.matchAll(/"(\/degg_images_save_compare\/[a-z_]+)"/g)].map((m) => m[1]);
  const jsRoutes = [...JS.matchAll(/"(\/degg_images_save_compare\/[a-z_]+)"/g)].map((m) => m[1]);
  const uniqPy = [...new Set(pyRoutes)].sort();
  const uniqJs = [...new Set(jsRoutes)].sort();
  check("роуты JS === роуты Python (open_file)",
    JSON.stringify(uniqPy) === JSON.stringify(uniqJs) && uniqPy.length === 1,
    `py=${JSON.stringify(uniqPy)} js=${JSON.stringify(uniqJs)}`);

  check("js: читает ui.degg_compare_images (как отдаёт python)",
    /message\.degg_compare_images/.test(JS) && /degg_compare_images/.test(PY));
  check("js: читает ui.degg_open_path (как отдаёт python)",
    /degg_open_path/.test(JS) && /degg_open_path/.test(PY));

  // Виджеты JS ищет по имени — имена обязаны совпадать с INPUT_TYPES.
  for (const n of ["save_mode", "filename_prefix", "mode", "opacity", "blink_speed"]) {
    check(`js и python знают виджет "${n}"`, pyInputs.includes(n) && JS.includes(`"${n}"`));
  }
  check("python: IMAGE-сокеты image_1/image_2",
    pyInputs.includes("image_1") && pyOptional.includes("image_2"));
  check("js: подписи слотов Image 1 / Image 2 в UI",
    /Image 1/.test(JS) && /Image 2/.test(JS));
  check("js ↔ python: слоты 1 и 2 совпадают",
    /slot === 1 \?/.test(JSC) && PY.includes('["slot"] = 1') && PY.includes('["slot"] = 2'));
}

// ── 5. tests/ ─────────────────────────────────────────────────────────────
const testsDir = path.join(ROOT, "tests");
check("tests/ существует", fs.existsSync(testsDir));
if (fs.existsSync(testsDir)) {
  const want = [
    "_test_degg_images_save_compare.py",
    "_smoke_degg_images_save_compare.mjs",
    "_audit_degg_images_save_compare.mjs",
  ];
  for (const t of want) check(`tests/${t} существует`, fs.existsSync(path.join(testsDir, t)));
  const files = fs.readdirSync(testsDir).filter((f) => !fs.statSync(path.join(testsDir, f)).isDirectory());
  check("в tests/ только файлы с _-префиксом (не собираются pytest)",
    files.every((f) => f.startsWith("_")), JSON.stringify(files));
}

// ── 6. check.json ─────────────────────────────────────────────────────────
const CJK = read("check.json");
check("check.json существует", !!CJK);
if (CJK) {
  let cj = null;
  try { cj = JSON.parse(CJK); } catch (e) { check("check.json: валидный JSON", false, String(e)); }
  if (cj) {
    const list = cj.checks || [];
    check("check.json: 3 проверки", list.length === 3, String(list.length));
    list.forEach((c, i) => {
      check(`check.json[${i}]: label заполнен`, !!(c.label && c.label.trim()));
      check(`check.json[${i}]: cmd заполнен`, !!(c.cmd && c.cmd.trim()));
      check(`check.json[${i}]: expect — непустой массив`, Array.isArray(c.expect) && c.expect.length > 0);
      const script = (c.cmd || "").trim().split(/\s+/)[1] || "";
      check(`check.json[${i}]: файл из cmd существует`, !script || fs.existsSync(path.join(ROOT, script)), script);
    });
  }
}

// ── 7. Карта корня ────────────────────────────────────────────────────────
const README = read("../README.md");
check("README.md корня содержит Degg_Images_Save_Compare",
  !!README && /Degg_Images_Save_Compare/.test(README));
check("bundle: проект лежит прямо в корне (без вложенных папок)",
  fs.existsSync(path.join(BUNDLE, "Degg_Images_Save_Compare", "__init__.py")));


// ── 8. Локализация (официальный механизм: locales/<lang>/nodeDefs.json) ───
// Требование: русский интерфейс ComfyUI -> RU, любой другой -> EN.
// Официальный механизм ComfyUI (app/custom_node_manager.py + i18n фронтенда,
// resolveNodeDefText/resolveNodeDefSlotText) умеет:
//   display_name / description / inputs.<name>.name|tooltip / outputs.<i>.name.// Значения combo (MODES) — протокольные: Python сверяет их с MODES, поэтому
// подмена options.values ломает ноду и запрещена.
// Подписи combo переводить МОЖНО и нужно — не через values, а через
// widget.options.getOptionLabel: фронтенд читает его отдельно от values
// (legacy ComboWidget.draw/click, Nodes 2.0 useWidgetSelectItems ->
// WidgetSelectDropdown -> getDisplayLabel), а в колбэк/сериализацию уходит
// исходное value.
const NODE_DEF_KEY = "Degg_Images_Save_Compare";
const localeDefs = {};
for (const lang of ["en", "ru"]) {
  const rel = `locales/${lang}/nodeDefs.json`;
  const abs = path.join(ROOT, rel);
  const raw = fs.existsSync(abs) ? fs.readFileSync(abs) : null;
  check(`${rel} существует`, !!raw);
  if (!raw) continue;
  check(`${rel}: UTF-8 без BOM`,
    !(raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf));
  let j = null;
  try { j = JSON.parse(raw.toString("utf8")); } catch (e) { /* ниже */ }
  check(`${rel}: валидный JSON`, !!j);
  if (!j) continue;
  const def = j[NODE_DEF_KEY];
  check(`${rel}: ключ ноды ${NODE_DEF_KEY}`, !!def);
  if (!def) continue;
  localeDefs[lang] = def;
  check(`${rel}: display_name заполнен`,
    typeof def.display_name === "string" && def.display_name.trim().length > 0);
  check(`${rel}: description заполнен`,
    typeof def.description === "string" && def.description.trim().length > 0);
  for (const slot of [...pyInputs, ...pyOptional]) {
    const s = def.inputs && def.inputs[slot];
    check(`${rel}: inputs.${slot}.name`, !!(s && s.name));
    check(`${rel}: inputs.${slot}.tooltip`, !!(s && s.tooltip));
  }
  check(`${rel}: outputs.0.name`,
    !!(def.outputs && def.outputs["0"] && def.outputs["0"].name));
}
if (localeDefs.en && localeDefs.ru) {
  check("локализация: RU реально переведён (display_name != EN)",
    localeDefs.ru.display_name !== localeDefs.en.display_name,
    `${localeDefs.en.display_name} / ${localeDefs.ru.display_name}`);
  check("локализация: RU-подписи входов содержат кириллицу",
    [...pyInputs, ...pyOptional].every((s) =>
      !!localeDefs.ru.inputs[s] && /[\u0400-\u04FF]/.test(localeDefs.ru.inputs[s].name)));
}

// Python обязан быть английским источником: для локалей, которых нет в
// locales/ (de, ja, ...), фронтенд отдаёт backend-значение (tooltip/description),
// поэтому русские тултипы в Python показали бы немцу русский текст.
if (PY) {
  const tooltips = [...PY.matchAll(/tooltip":\s*"([^"]*)"/g)].map((m) => m[1]);
  check("python: тултипы без кириллицы (EN — источник, RU живёт в locales/ru)",
    tooltips.length > 0 && tooltips.every((t) => !/[\u0400-\u04FF]/.test(t)),
    JSON.stringify(tooltips));
  const descBlock = (PY.match(/DESCRIPTION\s*=\s*\(([\s\S]*?)\n\s*\)/) || [])[1] || "";
  check("python: DESCRIPTION без кириллицы (EN — источник)",
    descBlock.length > 0 && !/[\u0400-\u04FF]/.test(descBlock), descBlock.slice(0, 60));
}

if (JS) {
  // ⛔ Ищем ТОЛЬКО в коде (JSC): строка-КОММЕНТАРИЙ не должна закрывать
  // проверку — мутация M2 показала слепой детектор при поиске по JS целиком.
  has(JSC, /extensionManager[\s\S]{0,160}?setting[\s\S]{0,80}?\.get\(/,
    "js: язык читается через app.extensionManager.setting.get('Comfy.Locale') (по коду)");
  has(JSC, /getSettingValue\([\s\S]{0,40}?Comfy\.Locale/,
    "js: фолбэк — app.ui.settings.getSettingValue('Comfy.Locale')");
  has(JSC, /function isRu\(\)\s*\{\s*return\s+\/\^ru\/i\.test\(readComfyLocale\(\)\)/,
    "js: isRu() реально читает readComfyLocale (RU только для ru-локали)");
  has(JSC, /function setLocaleOverride\(/, "js: setLocaleOverride() для тестов");  check("js: значения combo (MODES) НЕ переводятся — протокольные значения",
    !/options\.values\s*=/.test(JSC));
  // Подписи режимов — через getOptionLabel, values остаются нетронутыми.
  has(JSC, /MODE_LABELS_RU\s*=\s*\{/, "js: таблица RU-подписей режимов");
  has(JSC, /function modeLabel\(/, "js: modeLabel(value) — RU-подпись либо значение как есть");
  check("js: подписи combo отдаются через options.getOptionLabel (values не трогаем)",
    /options\.getOptionLabel\s*=/.test(JSC) && !/options\.values\s*=/.test(JSC));
  check("js: getOptionLabel привязан к modeLabel (не к подмене значений)",
    /options\.getOptionLabel\s*=\s*\([^)]*\)\s*=>\s*modeLabel\(/.test(JSC));
  has(JS, /function viewItems\(/, "js: заголовки селектора вида локале-зависимы");
  has(JS, /VIEW_TITLES_RU/, "js: RU-заголовки видов (Пара/Изображение 1/2)");
  has(JS, /OPEN_LABEL_EMPTY_RU/, "js: RU-подписи кнопки открытия");
  has(JS, /HELP_RU/, "js: RU-версия справки");
  has(JS, /function hintText\(/, "js: подсказка локале-зависима");
  check("js: в EN-константах подписей нет кириллицы (RU — в *_RU)",
    !/OPEN_LABEL_(READY|EMPTY)\s*=\s*"[^"]*[\u0400-\u04FF]/.test(JS));
}

console.log("");
console.log(`ok: ${oks.length}   FAIL: ${errors.length}`);
if (errors.length) {
  errors.forEach((e) => console.log("  - " + e));
  console.log("АУДИТ ПРОВАЛЕН");
  process.exit(1);
}
console.log("аудит чист");
