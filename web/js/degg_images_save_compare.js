// Degg_Images_Save_Compare — Save/Preview Image 1 + интерактивное сравнение
// с Image 2 (перенос функционала ↔️ OreX Image Compare).
//
// Порядок сверху вниз: [save_mode] [filename_prefix] [Открыть Image 1]
//                      [mode] [opacity] [blink_speed]
//                      [превью сравнения]
//
// ── Почему превью — DOM-виджет, а не canvas-виджет ────────────────────────
// (проверено по исходникам фронтенда 1.53.10; скилы comfyui-frontend-sources,
//  comfyui-custom-widget-contract, comfyui-dom-widget-sizing)
//
//   • canvas-виджет (`custom`) высоты строки НЕ знает: LegacyWidget.drawWidget
//     передаёт `H = LiteGraph.NODE_WIDGET_HEIGHT` (константа), а
//     WidgetLegacy.vue в Nodes 2.0 берёт высоту из computedHeight/computeSize.
//     Поэтому превью фиксированной высоты — «не растягивается вместе с нодой».
//   • DOM-виджет (addDOMWidget) в ОБОИХ режимах раскладывает один оверлей
//     (DomWidgets.vue: `posNode.pos + widget.y`, размер `widget.width ×
//     widget.computedHeight`), а высоту распределяет LGraphNode._arrangeWidgets
//     через distributeSpace: виджет БЕЗ computeSize и С computeLayoutSize —
//     «growable» и забирает всё свободное место ноды. В Nodes 2.0 то же даёт
//     flex (WidgetDOM.vue `flex flex-col *:flex-1` + NodeWidgets.vue `flex:1`
//     при hasLayoutSize). Отсюда правило: НЕ задавать ни computeSize, ни
//     options.getHeight (они пинят высоту) — только getMinHeight (пол).
//   • WidgetLegacy.vue вдобавок не пробрасывает hover, а координаты мешает:
//     pointerdown приходит из processWidgetClick с координатами НОДЫ, а
//     pointermove — с координатами ВИДЖЕТА (offsetX/offsetY). DOM-элемент
//     убирает мост координат целиком: все события приходят на сам элемент.
//   • Шторка сделана как в СТАНДАРТНОЙ ноде ComfyUI: ImageCompare
//     (frontend: WidgetImageCompare.vue → useMouseInElement) — позиция идёт за
//     курсором по X, drag-состояние не нужно; клип делается `clip-path`
//     верхнего <img>.
//   • Подсказка — DOM-узел под кнопкой «?», гасится по mouseleave. Canvas-тултип
//     жил в node.onMouseMove: увёл курсор с ноды — событий больше нет и
//     подсказка «висела» на экране. Глобальных слушателей (window/document)
//     у ноды нет вовсе.
//   • drawImage вызывается только для ГОТОВЫХ картинок. У <img> с 404
//     complete === true и naturalWidth === 0 — состояние 'broken'; drawImage на
//     нём бросает InvalidStateError и роняет кадр отрисовки (это и был баг
//     «глюки изображения при переключении воркфлоу», когда temp почистился).
//   • Difference: mix-blend-mode ставится на КОРОБКУ слоя (box), а не на
//     <img>: внутри scene всегда есть transform/will-change, а любой stacking
//     context изолирует blend — на <img> «difference» смешивался только с
//     пустотой внутри scene и режим не работал (регрессия DOM-переписывания).
//   • Подписи размеров — футер (dsc-footer) ПОД областью изображения на сером
//     поле (как в стандартной ноде): Image 1 — белым, Image 2 — серым.
//   • Side-by-Side выбирает ориентацию сам (sbsOrientation): ландшафт → кадры
//     друг над другом, портрет → слева и справа.
//
// Запуск тестов: cd Degg_Images_Save_Compare && node tests/_smoke_*.mjs

const DSC_JS_VERSION = "2.14.0-wheel-fwd-viewpair";
console.log(`[Degg_Images_Save_Compare] JS ${DSC_JS_VERSION} loaded`);

// ── bootstrap (Nodes 2.0: только window.comfyAPI) ──────────────────────────
function pickApp() {
  try {
    if (window.comfyAPI && window.comfyAPI.app && window.comfyAPI.app.app) {
      return window.comfyAPI.app.app;
    }
    if (window.app) return window.app;
  } catch (e) {
    /* ignore */
  }
  return null;
}

function pickApi() {
  try {
    // window.comfyAPI.api — это ПРОСТРАНСТВО ИМЁН модуля; сам клиент лежит
    // в window.comfyAPI.api.api (у него есть apiURL/fetchApi).
    if (window.comfyAPI && window.comfyAPI.api && window.comfyAPI.api.api) {
      return window.comfyAPI.api.api;
    }
    if (window.comfyAPI && window.comfyAPI.api && window.comfyAPI.api.apiURL) {
      return window.comfyAPI.api;
    }
    if (window.api) return window.api;
  } catch (e) {
    /* ignore */
  }
  return null;
}

const app = pickApp();
const api = pickApi();

// ── константы ─────────────────────────────────────────────────────────────

const EXT_NAME = "Degg_Images_Save_Compare";
const NODE_NAME = "Degg_Images_Save_Compare";

const PREVIEW_MIN_H = 320;  // пол высоты превью (px) → min-height root
const MIN_W = 440;          // минимальная ширина ноды
const SBS_GAP = 2;          // зазор между половинами в Side-by-Side
// BaseDOMWidgetImpl.DEFAULT_MARGIN: оверлей даёт элементу computedHeight - margin*2
// и width - margin*2, поэтому пол виджета = PREVIEW_MIN_H + margin*2 (§4.2 спеки).
const PREVIEW_MARGIN = 10;
// Футер подписей размеров: занимает высоту снизу вне области изображения —
// подписи лежат на сером поле, а не поверх кадра (как в стандартной ноде).
// Задача 4: 26px, чтобы кнопки вида (16px) в центре футера отступали от
// изображения на (26-16)/2 = 5px, а не на 1px (при 18px налезали вплотную).
const DIM_BAR_H = 26;

const PREVIEW_WIDGET = "degg_compare_preview";
const OPEN_BTN = "open_image_1";
const W_SAVE = "save_mode";
const W_PREFIX = "filename_prefix";

// Идентификаторы DOM-узлов превью (по ним же ищут тесты).
const DOM_STAGE = "dsc-stage";
const DOM_LINE = "dsc-line";
const DOM_HELP = "dsc-help";
const DOM_FOOTER = "dsc-footer";
const DOM_VIEW = "dsc-view";
const BLINK_KEYFRAMES = "dscBlink";

// Кнопки выбора вида внутри режима Side-by-Side (лежат в футере подписей).
// П.3: Шторка и Сетка давали одинаковую пару половин — «Сетка» удалена,
// у элемента пары иконка «два прямоугольника рядом» (фолбэк — квадрат).
const VIEW_ITEMS = [
  { id: "dsc-view-split", view: "split", title: "Пара", pair: true },
  { id: "dsc-view-img1", view: "img1", title: "Image 1" },
  { id: "dsc-view-img2", view: "img2", title: "Image 2" },
];
const VIEW_VALUES = ["split", "img1", "img2"];

const OPEN_URI = "/degg_images_save_compare/open_file";

const OPEN_LABEL_READY = "Open in Viewer";
const OPEN_LABEL_EMPTY = "No image";

const MODES = ["Off", "Slider", "Side-by-Side", "Overlap", "Difference", "Blink"];

const HELP = [
  {
    name: "mode",
    label: "Mode / Режим сравнения",
    icon: "↔️",
    lines: [
      "Off: чистый просмотрщик Image 1 — один размер по центру (по умолчанию)",
      "Slider: интерактивная шторка (идёт за курсором)",
      "Side-by-Side: два кадра рядом (виды: Пара/1/2 — кнопки в футере)",
      "Overlap: наложение с прозрачностью",
      "Difference: подсветка различий",
      "Blink: поочерёдная смена кадров",
    ],
  },
  {
    name: "opacity",
    label: "Opacity / Прозрачность",
    icon: "🎨",
    lines: ["Непрозрачность Image 1 в режиме Overlap (0 — прозрачно, 1 — плотно)"],
  },
  {
    name: "blink_speed",
    label: "Blink Speed / Скорость мигания",
    icon: "⏱️",
    lines: ["Длительность фазы переключения кадров (1.0 — 3.0 сек)"],
  },
  {
    name: "zoom_help",
    label: "Zoom & Pan / Навигация",
    icon: "🔍",
    lines: [
      "Alt + Wheel: зум 1.0x — 10.0x",
      "Middle Click + Drag: перемещение кадра",
      "Double Click: сброс зума и позиции",
      "Навигация (Alt+Wheel, средняя кнопка) — только в Side-by-Side, когда видны оба кадра",
    ],
  },
];

// ── мелкие хелперы ────────────────────────────────────────────────────────

function num(v, fallback) {
  const n = typeof v === "number" ? v : parseFloat(v);
  return isNaN(n) ? fallback : n;
}

function getWidget(node, name) {
  return (node.widgets || []).find((w) => w && w.name === name) || null;
}

function getValue(node, name, fallback) {
  const w = getWidget(node, name);
  return w ? w.value : fallback;
}

function postJson(url, body) {
  const opts = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
  if (api && typeof api.fetchApi === "function") return api.fetchApi(url, opts);
  return fetch(url, opts);
}

function flashLabel(widget, text, restore, ms) {
  if (!widget) return;
  widget.label = text;
  setTimeout(() => {
    widget.label = restore;
  }, ms || 2000);
}

/** Создать узел DOM: имена свойств = CSS-свойства (camelCase). */
function el(doc, tag, styles, text) {
  const node = doc.createElement(tag);
  if (styles) {
    for (const k in styles) {
      if (Object.prototype.hasOwnProperty.call(styles, k)) node.style[k] = styles[k];
    }
  }
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

/** Обновить только переданные CSS-свойства (без cssText — он затирает всё). */
function css(node, styles) {
  if (!node || !node.style) return node;
  for (const k in styles) {
    if (Object.prototype.hasOwnProperty.call(styles, k)) node.style[k] = styles[k];
  }
  return node;
}

function pct(v) {
  // «90%», а не «90.00000000000001%»: сравнения стилей в тестах и в живом DOM.
  return Math.round(v * 1000) / 10 + "%";
}

/** Картинка пригодна для drawImage? У 404-й complete === true, naturalWidth === 0. */
function isDrawable(img) {
  if (!img) return false;
  if (img.complete === false) return false;
  return num(img.naturalWidth, 0) > 0;
}

// ── состояние ─────────────────────────────────────────────────────────────

function ensureState(node) {
  if (!node._cmp) {
    node._cmp = {
      sliderPos: 0.5,
      zoom: 1.0,
      panX: 0,
      panY: 0,
      sbsFocusU: 0.5,
      sbsFocusV: 0.5,
      img1: null,
      img2: null,
      meta1: null,
      meta2: null,
      dim1: "",
      dim2: "",
      panDrag: false,
      lastPan: [0, 0],
      mode: "",
      sliderView: "split",
      dom: null,
      guard: null,
    };
  }
  return node._cmp;
}

function currentMode(node) {
  const m = getValue(node, "mode", "Off");
  return MODES.indexOf(m) >= 0 ? m : "Off";
}

/**
 * Навигация (зум/панорама) разрешена ТОЛЬКО в Side-by-Side с видимой парой:
 * режимы Off/Slider и одиночные виды Image 1/Image 2 показывают одно
 * изображение, а пустая нода не имеет картинок — сдвигать и зумировать нечего
 * (по задаче).
 */
function navEnabled(node) {
  const st = ensureState(node);
  if (!isDrawable(st.img1) || !isDrawable(st.img2)) return false;
  if (currentMode(node) !== "Side-by-Side") return false;
  if (st.sliderView === "img1" || st.sliderView === "img2") return false;
  return true;
}

// ── картинки: загрузка / персистентность ──────────────────────────────────

function metaUrl(meta) {
  if (!meta || !meta.filename) return "";
  const q =
    `filename=${encodeURIComponent(meta.filename)}` +
    `&subfolder=${encodeURIComponent(meta.subfolder || "")}` +
    `&type=${encodeURIComponent(meta.type || "output")}`;
  if (api && typeof api.apiURL === "function") return api.apiURL(`/view?${q}`);
  return `/view?${q}`;
}

/**
 * Ставит картинку в слой DOM-превью (или гасит слой при meta=null).
 *
 * ⛔ Слой гасится по onerror: отсутствие файла (temp чистится при перезапуске
 * ComfyUI) не должно оставлять <img> в состоянии 'broken' — drawImage на таком
 * элементе бросает InvalidStateError и валит кадр отрисовки.
 */
function setSlotImage(node, slot, meta, dim) {
  const st = ensureState(node);
  const imgKey = slot === 1 ? "img1" : "img2";
  const metaKey = slot === 1 ? "meta1" : "meta2";
  const dimKey = slot === 1 ? "dim1" : "dim2";

  st[metaKey] = meta || null;
  st[dimKey] = dim || "";
  st[imgKey] = null;

  const layer = st.dom ? (slot === 1 ? st.dom.a : st.dom.b) : null;
  const url = metaUrl(meta);

  if (!layer) {
    refreshLabels(node);
    return;
  }

  const img = layer.img;
  if (!url) {
    img.onload = null;
    img.onerror = null;
    css(img, { display: "none" });
    refreshLabels(node);
    return;
  }

  img.onerror = () => {
    if (st[imgKey] === img) {
      st[imgKey] = null;
      st[metaKey] = null;
      st[dimKey] = "";
    }
    css(img, { display: "none" });
    refreshLabels(node);
    relayoutSbs(node);
  };
  img.onload = () => {
    if (st[imgKey] !== img) return;
    css(img, { display: "" });
    if (!st[dimKey]) {
      const w = num(img.naturalWidth, 0);
      const h = num(img.naturalHeight, 0);
      if (w && h) st[dimKey] = `${w}×${h}`;
    }
    refreshLabels(node);
    relayoutSbs(node);
  };

  st[imgKey] = img;
  css(img, { display: "" });
  // Присваивание src ПОСЛЕ onerror/onload: кэш может ответить синхронно.
  img.src = url;
  refreshLabels(node);
}

/** Картинка догрузилась/отвалилась — в Side-by-Side могла смениться ориентация. */
function relayoutSbs(node) {
  if (currentMode(node) !== "Side-by-Side") return;
  applyMode(node);
}

/** Подписи размеров, заглушка «нет картинок» и бейдж зума. */
function refreshLabels(node) {
  const st = ensureState(node);
  if (!st.dom) return;
  st.dom.dim1.textContent = st.dim1 || "";
  st.dom.dim2.textContent = st.dim2 || "";
  // Заглушка «нет картинок»: в Off показывается только Image 1 (Image 2 в Off
  // скрыта и не участвует), в остальных режимах — когда нечего сравнивать.
  const shownImg = currentMode(node) === "Off" ? st.img1 : (st.img1 || st.img2);
  css(st.dom.hint, { display: shownImg ? "none" : "block" });
  const label = st.zoom > 1.005 ? `${st.zoom.toFixed(1)}×` : "";
  st.dom.badge.textContent = label;
  css(st.dom.badge, { display: label ? "block" : "none" });
}

/**
 * Сохраняет метаданные картинок в node.properties.
 * ⛔ Только properties сериализуются в workflow JSON (LGraphNode.serialize →
 * `o.properties`), поэтому переключение воркфлоу туда-обратно картинки больше
 * не теряет: onExecuted после возврата не вызывается, а onConfigure — да.
 */
function persistImages(node) {
  const st = ensureState(node);
  node.properties = node.properties || {};
  node.properties.dsc_open_path = node._dscOpenPath || "";
  node.properties.dsc_meta = {
    1: st.meta1 ? { filename: st.meta1.filename, subfolder: st.meta1.subfolder || "", type: st.meta1.type || "output", dim: st.dim1 || "" } : null,
    2: st.meta2 ? { filename: st.meta2.filename, subfolder: st.meta2.subfolder || "", type: st.meta2.type || "output", dim: st.dim2 || "" } : null,
  };
}

function restoreImages(node) {
  const props = node.properties || {};
  node._dscOpenPath = props.dsc_open_path || "";
  const m = props.dsc_meta;
  if (!m) return;
  ensureState(node);
  const one = m["1"] || m[1];
  const two = m["2"] || m[2];
  if (one && one.filename) {
    setSlotImage(node, 1, { filename: one.filename, subfolder: one.subfolder || "", type: one.type || "output" }, one.dim || "");
  }
  if (two && two.filename) {
    setSlotImage(node, 2, { filename: two.filename, subfolder: two.subfolder || "", type: two.type || "output" }, two.dim || "");
  }
}

function updateOpenButton(node) {
  const btn = getWidget(node, OPEN_BTN);
  if (btn) btn.label = node._dscOpenPath ? OPEN_LABEL_READY : OPEN_LABEL_EMPTY;
}

function openImage1(node) {
  const btn = getWidget(node, OPEN_BTN);
  const path = node._dscOpenPath || "";
  // Пусто — подписывать нечего: кнопка уже показывает OPEN_LABEL_EMPTY
  // (updateOpenButton ставит её по пути). Старый flashLabel(EMPTY) без
  // restore затирал label через 2с (label = undefined).
  if (!path) return;
  postJson(OPEN_URI, { path })
    .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
    .then(({ ok, j }) => flashLabel(btn, ok && j.success ? "✅ Открыто" : `⚠️ ${j.error || "ошибка"}`, OPEN_LABEL_READY, 2200))
    .catch((e) => flashLabel(btn, `⚠️ ${e && e.message ? e.message : e}`, OPEN_LABEL_READY, 2200));
}

// ── Save/Preview ──────────────────────────────────────────────────────────

/**
 * Гашение префикса в режиме Preview. `w.disabled` + `options.disabled` —
 * поля, которые читает движок (проверено по BaseWidget/LGraphNode).
 */
function applySaveMode(node) {
  const fp = getWidget(node, W_PREFIX);
  if (!fp) return;
  const isSave = !!getValue(node, W_SAVE, true);
  fp.disabled = !isSave;
  if (fp.options) fp.options.disabled = !isSave;
  if (node.setDirtyCanvas) node.setDirtyCanvas(true, true);
}

// ── геометрия превью ──────────────────────────────────────────────────────

/** Размер области превью в CSS-пикселях (clientWidth/Height не зависят от зума графа). */
function previewSize(node) {
  const st = ensureState(node);
  const stage = st.dom && st.dom.stage;
  let w = 0;
  let h = 0;
  try {
    w = num(stage && stage.clientWidth, 0);
    h = num(stage && stage.clientHeight, 0);
  } catch (e) {
    /* ignore */
  }
  if (!w) w = MIN_W;
  if (!h) h = PREVIEW_MIN_H;
  return { w: w, h: h };
}

/** Положение области превью на экране (для перевода clientX/Y в долю). */
function stageRect(node) {
  const st = ensureState(node);
  const stage = st.dom && st.dom.stage;
  const size = previewSize(node);
  let left = 0;
  let top = 0;
  let width = size.w;
  let height = size.h;
  try {
    if (stage && typeof stage.getBoundingClientRect === "function") {
      const r = stage.getBoundingClientRect();
      if (r && r.width > 0 && r.height > 0) {
        left = num(r.left, 0);
        top = num(r.top, 0);
        width = r.width;
        height = r.height;
      }
    }
  } catch (e) {
    /* ignore */
  }
  return { left: left, top: top, width: width, height: height };
}

function clampPan(st, rect) {
  if (st.zoom <= 1.0) {
    st.panX = 0;
    st.panY = 0;
    return;
  }
  const maxPanX = (rect.w * (st.zoom - 1.0)) / 2;
  const maxPanY = (rect.h * (st.zoom - 1.0)) / 2;
  st.panX = Math.max(-maxPanX, Math.min(maxPanX, st.panX));
  st.panY = Math.max(-maxPanY, Math.min(maxPanY, st.panY));
}

function resetView(node) {
  const st = ensureState(node);
  st.zoom = 1.0;
  st.panX = 0;
  st.panY = 0;
  st.sbsFocusU = 0.5;
  st.sbsFocusV = 0.5;
  applyTransforms(node);
  refreshLabels(node);
}

// ── раскладка Side-by-Side ────────────────────────────────────────────────

/**
 * Автовыбор ориентации Side-by-Side (по задаче): ландшафт (шире, чем выше) →
 * кадры друг над другом — экономит место; портрет → слева и справа.
 * Ориентация берётся у Image 1 (fallback Image 2); без готовых картинок —
 * слева/справа, как раньше.
 */
function sbsOrientation(st) {
  const img = (st && st.img1) || (st && st.img2);
  const iw = num(img && (img.naturalWidth || img.width), 0);
  const ih = num(img && (img.naturalHeight || img.height), 0);
  if (!(iw > 0) || !(ih > 0)) return "h";
  return iw > ih ? "v" : "h";
}

/**
 * Геометрия половины Side-by-Side: размеры половины, её центр и масштаб
 * вписывания. `boxOrigin` — левый край (orient "h") или верхний край (orient
 * "v") половины; orient по умолчанию "h" (старое поведение слева/справа).
 */
function sbsHalfLayout(rect, img, boxOrigin, orient) {
  const vert = orient === "v";
  const halfW = vert ? rect.w : rect.w / 2 - SBS_GAP / 2;
  const halfH = vert ? rect.h / 2 - SBS_GAP / 2 : rect.h;
  const iw = (img && (img.naturalWidth || img.width)) || 1;
  const ih = (img && (img.naturalHeight || img.height)) || 1;
  const fitScale = Math.min(halfW / iw, halfH / ih);
  const origin = num(boxOrigin, 0);
  return {
    halfW: halfW,
    halfH: halfH,
    iw: iw,
    ih: ih,
    fitScale: fitScale,
    halfCenterX: vert ? rect.x + rect.w / 2 : origin + halfW / 2,
    halfCenterY: vert ? origin + halfH / 2 : rect.y + rect.h / 2,
  };
}

/**
 * Над какой половиной (и над каким изображением) сейчас курсор — для расчёта
 * точки фокуса зума. Вертикальная раскладка делит по Y, горизонтальная — по X.
 */
function sbsHalfAt(st, rect, localX, localY, orient) {
  if (orient === "v") {
    const seamY = rect.y + rect.h / 2;
    if (num(localY, 0) < seamY) return st.img1 ? { img: st.img1, boxOrigin: rect.y } : null;
    return st.img2 ? { img: st.img2, boxOrigin: seamY + SBS_GAP / 2 } : null;
  }
  const seamX = rect.x + rect.w / 2;
  if (num(localX, 0) < seamX) return st.img1 ? { img: st.img1, boxOrigin: rect.x } : null;
  return st.img2 ? { img: st.img2, boxOrigin: seamX + SBS_GAP / 2 } : null;
}

// ── трансформы DOM-слоёв ──────────────────────────────────────────────────

/**
 * Общий зум/панорама для обычных режимов.
 * CSS `translate(pan) scale(z)` при transform-origin 50% 50% даёт ровно ту же
 * картинку, что canvas `translate(center+pan) scale(z) translate(-center)`:
 * точка на v от центра уезжает в center + v*z + pan.
 */
function sharedTransform(st) {
  return `translate(${st.panX.toFixed(2)}px, ${st.panY.toFixed(2)}px) scale(${st.zoom.toFixed(4)})`;
}

/**
 * Фокус половины в Side-by-Side: точка (focusU, focusV) картинки встаёт в
 * центр половины (layout из sbsHalfLayout — работает и для вертикальной
 * раскладки). Эквивалент canvas-математики dX = halfCenterX - focusU*iw*fit*z.
 */
function sbsHalfTransform(st, L) {
  const W = L.iw * L.fitScale;
  const H = L.ih * L.fitScale;
  const tx = -st.zoom * (st.sbsFocusU - 0.5) * W;
  const ty = -st.zoom * (st.sbsFocusV - 0.5) * H;
  return `translate(${(tx + st.panX).toFixed(2)}px, ${(ty + st.panY).toFixed(2)}px) scale(${st.zoom.toFixed(4)})`;
}

function applyTransforms(node) {
  const st = ensureState(node);
  if (!st.dom) return;
  const size = previewSize(node);
  if (currentMode(node) === "Side-by-Side") {
    const rect = { x: 0, y: 0, w: size.w, h: size.h };
    const orient = sbsOrientation(st);
    const seam = orient === "v" ? rect.y + rect.h / 2 : rect.x + rect.w / 2;
    const o1 = orient === "v" ? rect.y : rect.x;
    const o2 = seam + SBS_GAP / 2;
    css(st.dom.a.scene, { transform: sbsHalfTransform(st, sbsHalfLayout(rect, st.img1, o1, orient)) });
    css(st.dom.b.scene, { transform: sbsHalfTransform(st, sbsHalfLayout(rect, st.img2, o2, orient)) });
  } else {
    const t = sharedTransform(st);
    css(st.dom.a.scene, { transform: t });
    css(st.dom.b.scene, { transform: t });
  }
  refreshLabels(node);
}

// ── режимы на DOM/CSS ─────────────────────────────────────────────────────

/**
 * Порядок слоёв задаётся ТОЛЬКО порядком детей stage (appendChild переносит
 * узел), без z-index: z-index создаёт stacking context, а mix-blend-mode в
 * Difference смешивается лишь внутри своего stacking context — с z-index
 * «difference» не увидел бы Image 1.
 */
function setPaintOrder(node, first, second) {
  const st = ensureState(node);
  const stage = st.dom.stage;
  stage.appendChild(first.box);
  stage.appendChild(second.box);
  stage.appendChild(st.dom.line);   // линия шторки всегда сверху
}

function applySliderClip(node) {
  const st = ensureState(node);
  if (!st.dom) return;
  // Вид (st.sliderView) применяется только в Side-by-Side — в режиме Slider
  // шторка всегда активна (по задаче), поэтому условия по виду нет.
  const pos = Math.max(0, Math.min(1, st.sliderPos));
  // Image 1 сверху, обрезан слева до позиции шторки (clip-path в локальных
  // координатах слоя, т.е. линия остаётся на месте при зуме/панораме).
  css(st.dom.a.box, { clipPath: `inset(0 ${pct(1 - pos)} 0 0)` });
  css(st.dom.line, { left: pct(pos) });
}

function applyMode(node) {
  const st = ensureState(node);
  if (!st.dom) return;
  const mode = currentMode(node);
  const prev = st.mode;
  st.mode = mode;

  // Выход из Side-by-Side сбрасывает навигацию: вне SBS гейт navEnabled
  // закрыт (Alt+wheel/панорама), а sharedTransform применяет zoom/pan во всех
  // режимах — без сброса зум «залипает» в Slider/Off и не сбрасывается (вариант A).
  if (prev === "Side-by-Side" && mode !== "Side-by-Side") {
    st.zoom = 1;
    st.panX = 0;
    st.panY = 0;
    st.sbsFocusU = 0.5;
    st.sbsFocusV = 0.5;
  }

  // Задача 3: Off не сравнивает — гасим режимные слайдеры. Пишем и в
  // w.disabled, и в w.options.disabled (паттерн applySaveMode): legacy-отрисовка
  // читает widget.disabled, а Vue-компоненты Nodes 2.0 — options.disabled.
  for (const nm of ["opacity", "blink_speed"]) {
    const w = getWidget(node, nm);
    if (!w) continue;
    w.disabled = mode === "Off";
    if (w.options) w.options.disabled = mode === "Off";
  }

  // Сброс всего режимного. top/height сбрасываются тоже: иначе коробка,
  // расклеенная в вертикальной раскладке SBS, осталась бы половины высоты.
  for (const layer of [st.dom.a, st.dom.b]) {
    css(layer.box, { clipPath: "", left: "0", top: "0", width: "100%", height: "100%", mixBlendMode: "", display: "" });
    css(layer.img, { opacity: "", animation: "" });
  }
  css(st.dom.line, { display: "none" });
  // Селектор вида (3 кнопки) живёт только внутри режима Side-by-Side.
  css(st.dom.viewSel, { display: mode === "Side-by-Side" ? "flex" : "none" });
  // Подписи размеров: в Off показываем один размер (Image 1) по центру футера,
  // в остальных режимах — обе подписи по краям.
  if (mode === "Off") {
    css(st.dom.dim1, { left: "0px", right: "0px", textAlign: "center" });
    css(st.dom.dim2, { display: "none" });
  } else {
    css(st.dom.dim1, { left: "8px", right: "auto", textAlign: "left" });
    css(st.dom.dim2, { display: "" });
  }

  if (mode === "Side-by-Side") {
    const view = st.sliderView || "split";
    if (view === "img1" || view === "img2") {
      // Одиночный вид: один кадр на весь кадр (reset-цикл выше уже дал 100%).
      if (view === "img2") setPaintOrder(node, st.dom.a, st.dom.b);   // Image 2 сверху
      else setPaintOrder(node, st.dom.b, st.dom.a);                   // Image 1 сверху
    } else if (sbsOrientation(st) === "v") {
      // Ландшафт: кадры друг над другом (экономит ширину ноды).
      css(st.dom.a.box, { width: "100%", height: `calc(50% - ${SBS_GAP / 2}px)` });
      css(st.dom.b.box, { top: `calc(50% + ${SBS_GAP / 2}px)`, width: "100%", height: `calc(50% - ${SBS_GAP / 2}px)` });
      setPaintOrder(node, st.dom.a, st.dom.b);
    } else {
      // Портрет: слева и справа.
      css(st.dom.a.box, { left: "0", width: `calc(50% - ${SBS_GAP / 2}px)` });
      css(st.dom.b.box, { left: `calc(50% + ${SBS_GAP / 2}px)`, width: `calc(50% - ${SBS_GAP / 2}px)` });
      setPaintOrder(node, st.dom.a, st.dom.b);
    }
  } else if (mode === "Overlap") {
    const op = Math.max(0, Math.min(1, num(getValue(node, "opacity", 0.5), 0.5)));
    setPaintOrder(node, st.dom.b, st.dom.a);
    css(st.dom.a.img, { opacity: String(op) });
  } else if (mode === "Difference") {
    setPaintOrder(node, st.dom.a, st.dom.b);
    // ⛔ blend ставится на КОРОБКЕ, а не на <img>: <img> лежит внутри scene,
    // у которого transform/will-change — а любой stacking context изолирует
    // mix-blend-mode, и «difference» смешивался бы только с пустотой внутри
    // scene (режим выглядел нерабочим — регрессия DOM-переписывания).
    css(st.dom.b.box, { mixBlendMode: "difference" });
  } else if (mode === "Blink") {
    const phase = Math.max(1.0, num(getValue(node, "blink_speed", 1.0), 1.0));
    const dur = Math.round(phase * 2 * 100) / 100;
    setPaintOrder(node, st.dom.b, st.dom.a);
    css(st.dom.a.img, { animation: `${BLINK_KEYFRAMES} ${dur}s linear infinite` });
  } else if (mode === "Off") {
    // Просмотрщик: Image 1 на весь кадр без клипа/линии/blend.
    // Режим отключает сравнение — второе изображение не показывается вовсе
    // (раньше слой Image 2 лежал под Image 1 и проглядывал в letterbox-полях).
    // Скрытие по КОРОБКЕ, а не по <img>: setSlotImage/onload переставляет
    // display у <img> и вернул бы картинку при догрузке в Off.
    setPaintOrder(node, st.dom.b, st.dom.a);
    css(st.dom.b.box, { display: "none" });
  } else {
    // Режим Slider: всегда шторка — вид выбирается кружками только в SBS
    // (st.sliderView здесь игнорируется, по задаче).
    setPaintOrder(node, st.dom.b, st.dom.a);
    css(st.dom.line, { display: "block" });
    applySliderClip(node);
  }

  updateViewSel(node);
  applyTransforms(node);
}

/** Режим мог смениться в Vue-виджете, минуя callback — сверяем перед событием. */
function syncMode(node) {
  const st = ensureState(node);
  const mode = currentMode(node);
  if (st.mode !== mode) applyMode(node);
  else if (mode === "Slider") applySliderClip(node);
}

/** Выбор вида кружком в футере (режим Side-by-Side). */
function setSliderView(node, view) {
  const st = ensureState(node);
  st.sliderView = VIEW_VALUES.indexOf(view) >= 0 ? view : "split";
  applyMode(node);
}

/** Подсветка активного кружка селектора вида. */
function updateViewSel(node) {
  const st = ensureState(node);
  const sel = st.dom && st.dom.viewSel;
  if (!sel || !sel.children) return;
  const active = st.sliderView || "split";
  const kids = sel.children;
  for (let i = 0; i < kids.length; i++) {
    const dot = kids[i];
    if (!dot || !dot.id) continue;
    for (const item of VIEW_ITEMS) {
      if (dot.id !== item.id) continue;
      css(dot, { background: item.view === active ? "rgba(255, 255, 255, 0.95)" : "rgba(255, 255, 255, 0.35)" });
      break;
    }
  }
}

// ── взаимодействие: шторка / зум / панорама ───────────────────────────────

/** Шторка идёт за курсором по X внутри области (как useMouseInElement в ImageCompare). */
function setSliderFromClientX(node, clientX) {
  const st = ensureState(node);
  if (currentMode(node) !== "Slider") return;
  const rect = stageRect(node);
  const width = num(rect.width, 0);
  const frac = width > 0 ? (num(clientX, 0) - rect.left) / width : 0.5;
  st.sliderPos = Math.max(0, Math.min(1, frac));
  applySliderClip(node);
}

function zoomAt(node, clientX, clientY, deltaY) {
  const st = ensureState(node);
  const rect = { x: 0, y: 0, w: previewSize(node).w, h: previewSize(node).h };
  const sr = stageRect(node);
  // clientX/Y — экранные (getBoundingClientRect), rect — локальные
  // (clientWidth): при зуме графа scale ≠ 1 приводим к локальным (баг T-COORD-B).
  const rx = sr.width > 0 ? rect.w / sr.width : 1;
  const ry = sr.height > 0 ? rect.h / sr.height : 1;
  const localX = (num(clientX, 0) - sr.left) * rx;
  const localY = (num(clientY, 0) - sr.top) * ry;

  const prevZoom = st.zoom;
  const factor = deltaY < 0 ? 1.15 : 1 / 1.15;
  let newZoom = Math.max(1.0, Math.min(10.0, prevZoom * factor));

  if (currentMode(node) === "Side-by-Side") {
    if (Math.abs(newZoom - 1.0) < 0.001) {
      newZoom = 1.0;
      st.sbsFocusU = 0.5;
      st.sbsFocusV = 0.5;
      st.panX = 0;
      st.panY = 0;
    } else {
      const half = sbsHalfAt(st, rect, localX, localY, sbsOrientation(st));
      if (half) {
        const L = sbsHalfLayout(rect, half.img, half.boxOrigin, sbsOrientation(st));
        const effOld = L.fitScale * prevZoom;
        const uCursor = st.sbsFocusU + (localX - L.halfCenterX) / (L.iw * effOld);
        const vCursor = st.sbsFocusV + (localY - L.halfCenterY) / (L.ih * effOld);
        const effNew = L.fitScale * newZoom;
        st.sbsFocusU = Math.max(0, Math.min(1, uCursor - (localX - L.halfCenterX) / (L.iw * effNew)));
        st.sbsFocusV = Math.max(0, Math.min(1, vCursor - (localY - L.halfCenterY) / (L.ih * effNew)));
      }
    }
  } else {
    if (Math.abs(newZoom - 1.0) < 0.001) {
      newZoom = 1.0;
      st.panX = 0;
      st.panY = 0;
    } else {
      const centerX = rect.x + rect.w / 2;
      const centerY = rect.y + rect.h / 2;
      const mouseRelX = localX - centerX;
      const mouseRelY = localY - centerY;
      const scaleRatio = newZoom / prevZoom;
      st.panX = (st.panX - mouseRelX) * scaleRatio + mouseRelX;
      st.panY = (st.panY - mouseRelY) * scaleRatio + mouseRelY;
    }
  }

  st.zoom = newZoom;
  // Кламп ПОСЛЕ присвоения zoom: иначе при зуме из 1.0 кламп видит старый
  // zoom <= 1 и обнуляет только что вычисленную панораму (баг T-COORD-A).
  if (currentMode(node) !== "Side-by-Side") clampPan(st, rect);
  applyTransforms(node);
  return true;
}

// ── подсказка (DOM, не залипает) ──────────────────────────────────────────

function showHelp(node) {
  const st = ensureState(node);
  if (!st.dom) return;
  css(st.dom.helpBox, { display: "block" });
}

function hideHelp(node) {
  const st = ensureState(node);
  if (!st.dom) return;
  css(st.dom.helpBox, { display: "none" });
}

function buildHelpContent(doc, box) {
  for (const item of HELP) {
    const title = el(doc, "div", { fontWeight: "bold", color: "#fff", marginTop: "6px" },
      `${item.icon || "💡"} ${item.label}`);
    box.appendChild(title);
    for (const lineText of item.lines) {
      box.appendChild(el(doc, "div", { color: "#cccccc" }, `• ${lineText}`));
    }
  }
  return box;
}

// ── DOM-превью ────────────────────────────────────────────────────────────

/** Слой = обрезаемая коробка → трансформируемая сцена → <img> (object-fit: contain). */
function makeLayer(doc) {
  const box = el(doc, "div", {
    position: "absolute",
    left: "0",
    top: "0",
    width: "100%",
    height: "100%",
    overflow: "hidden",
  });
  const scene = el(doc, "div", {
    position: "absolute",
    left: "0",
    top: "0",
    width: "100%",
    height: "100%",
    transformOrigin: "50% 50%",
    willChange: "transform",
  });
  const img = el(doc, "img", {
    position: "absolute",
    left: "0",
    top: "0",
    width: "100%",
    height: "100%",
    objectFit: "contain",
    pointerEvents: "none",
    userSelect: "none",
    display: "none",
  });
  img.draggable = false;
  img.alt = "";
  scene.appendChild(img);
  box.appendChild(scene);
  return { box: box, scene: scene, img: img };
}

/** Ключевые кадры мигания: 1 → 0 → 1 за две фазы (чистая CSS-анимация — серверный GIF удалён, задача T1). */
function ensureBlinkKeyframes(doc) {
  try {
    if (typeof doc.getElementById !== "function" || !doc.head) return;
    if (doc.getElementById(BLINK_KEYFRAMES)) return;
    const style = doc.createElement("style");
    style.id = BLINK_KEYFRAMES;
    style.textContent =
      `@keyframes ${BLINK_KEYFRAMES}{0%,16.66%{opacity:1}33.33%,50%{opacity:0}66.66%,100%{opacity:1}}`;
    doc.head.appendChild(style);
  } catch (e) {
    /* ignore */
  }
}

function buildPreviewDom(node) {
  const st = ensureState(node);
  const doc = document;
  ensureBlinkKeyframes(doc);

  const root = el(doc, "div", {
    position: "relative",
    width: "100%",
    height: "100%",
    minHeight: PREVIEW_MIN_H + "px",
    overflow: "hidden",
    borderRadius: "4px",
    background: "transparent",
    boxSizing: "border-box",
    userSelect: "none",
  });

  const stage = el(doc, "div", {
    position: "absolute",
    left: "0",
    top: "0",
    width: "100%",
    bottom: DIM_BAR_H + "px",   // ниже — футер подписей (изображение его не перекрывает)
    overflow: "hidden",
    isolation: "isolate",
    cursor: "crosshair",
  });
  stage.id = DOM_STAGE;

  const a = makeLayer(doc);   // Image 1
  const b = makeLayer(doc);   // Image 2
  stage.appendChild(b.box);
  stage.appendChild(a.box);

  // Контейнер шторки: тонкая СЕРАЯ сплошная линия по центру (по задаче —
  // 1px вдвое тоньше, без круга-ручки и сегментов сверху/снизу).
  // pointerEvents:none — сама шторка живёт на stage (клип по clientX).
  const line = el(doc, "div", {
    position: "absolute",
    width: "1px",
    left: "50%",
    top: "0",
    bottom: "0",
    transform: "translateX(-50%)",
    background: "#808080",
    pointerEvents: "none",
    display: "none",
  });
  line.id = DOM_LINE;
  stage.appendChild(line);

  // Подписи размеров — футер на ДНЕ превью, ВНЕ области изображения:
  // как в стандартной ноде ComfyUI картинка лежит на сером поле, а размеры
  // подписаны под ней. Цвета без подсветки: Image 1 — белый, Image 2 — серый.
  const dim1 = el(doc, "div", {
    position: "absolute", left: "8px", top: "0", height: "100%",
    lineHeight: DIM_BAR_H + "px", fontSize: "11px",
    color: "#ffffff", pointerEvents: "none",
  });
  const dim2 = el(doc, "div", {
    position: "absolute", right: "8px", top: "0", height: "100%",
    lineHeight: DIM_BAR_H + "px", fontSize: "11px",
    color: "#999999", pointerEvents: "none",
  });
  const footer = el(doc, "div", {
    position: "absolute", left: "0", right: "0", bottom: "0",
    height: DIM_BAR_H + "px", boxSizing: "border-box",
    background: "transparent", pointerEvents: "none",
  });
  footer.id = DOM_FOOTER;
  footer.appendChild(dim1);
  footer.appendChild(dim2);

  // Селектор вида в режиме Side-by-Side: 3 кнопки (Пара с иконкой / 1 / 2) по
  // центру футера подписей. Показ/скрытие — в applyMode; клик меняет st.sliderView.
  const viewSel = el(doc, "div", {
    position: "absolute",
    left: "50%",
    top: "0",
    height: "100%",
    transform: "translateX(-50%)",
    display: "flex",
    alignItems: "center",
    gap: "4px",
    pointerEvents: "auto",
  });
  viewSel.id = DOM_VIEW;
  for (const item of VIEW_ITEMS) {
    const dot = el(doc, "div", {
      width: "16px",
      height: "16px",
      borderRadius: item.pair ? "3px" : "50%",
      margin: "0 2px",
      background: item.view === (st.sliderView || "split")
        ? "rgba(255, 255, 255, 0.95)"
        : "rgba(255, 255, 255, 0.35)",
      cursor: "pointer",
      pointerEvents: "auto",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      gap: "2px",
    });
    dot.id = item.id;
    dot.title = item.title;
    if (item.pair) {
      // Иконка «два прямоугольника рядом»; при ошибке остаётся пустой квадрат.
      try {
        for (let r = 0; r < 2; r++) {
          const bar = el(doc, "div", {
            width: "5px", height: "10px", borderRadius: "1px",
            background: "#222222",
          });
          dot.appendChild(bar);
        }
      } catch (err) { /* фолбэк: пустой квадрат */ }
    }
    dot.addEventListener("click", () => setSliderView(node, item.view));
    viewSel.appendChild(dot);
  }
  footer.appendChild(viewSel);
  const hint = el(doc, "div", {
    position: "absolute", left: "0", right: "0", top: "50%",
    textAlign: "center", fontSize: "12px", color: "#666666",
    pointerEvents: "none",
  }, "Подключите изображения и запустите схему...");
  const badge = el(doc, "div", {
    position: "absolute", right: "8px", bottom: (DIM_BAR_H + 6) + "px", display: "none",
    fontSize: "10px", fontWeight: "bold", color: "#ffffff",
    background: "rgba(0,0,0,0.65)", padding: "1px 5px", borderRadius: "4px",
    pointerEvents: "none",
  });
  const help = el(doc, "button", {
    position: "absolute", top: "6px", right: "8px", width: "18px", height: "18px",
    lineHeight: "1", padding: "0", borderRadius: "9px", cursor: "help",
    border: "1px solid rgba(255,255,255,0.4)",
    background: "rgba(24,24,28,0.75)", color: "#ffffff",
    fontSize: "11px", fontWeight: "bold",
  }, "?");
  help.type = "button";
  const helpBox = el(doc, "div", {
    position: "absolute", top: "28px", right: "8px", display: "none",
    maxWidth: "min(340px, 80%)", maxHeight: "calc(100% - 40px)", overflow: "auto",
    padding: "8px 10px", borderRadius: "6px", fontSize: "11px", lineHeight: "15px",
    border: "1px solid rgba(255,255,255,0.4)", background: "rgba(18,18,18,0.97)",
    color: "#cccccc", pointerEvents: "none",
  });
  helpBox.id = DOM_HELP;
  buildHelpContent(doc, helpBox);

  root.appendChild(stage);
  root.appendChild(footer);
  root.appendChild(hint);
  root.appendChild(badge);
  root.appendChild(help);
  root.appendChild(helpBox);

  st.dom = {
    root: root,
    stage: stage,
    line: line,
    a: a,
    b: b,
    footer: footer,
    viewSel: viewSel,
    dim1: dim1,
    dim2: dim2,
    hint: hint,
    badge: badge,
    help: help,
    helpBox: helpBox,
  };
  return root;
}

/**
 * Все взаимодействия — на самом DOM-элементе (в обоих режимах он лежит в
 * оверлее DomWidgets.vue над холстом), поэтому глобальных слушателей нет.
 */
/**
 * П.1: колесо без Alt (и Alt+wheel при выключенной навигации) принадлежит
 * графу. В legacy-режиме наши DomWidgets — сосед канвы, и событие до неё не
 * доходит, поэтому форвардим синтетическое wheel на app.canvas.canvas
 * (как forwardEventToCanvas во Vue-режиме, но без altKey, чтобы граф
 * не зумился второй раз). Возвращает true, если событие ушло в канву.
 */
function forwardWheelToCanvas(e) {
  try {
    const app = pickApp();
    const canvasEl = app && app.canvas && app.canvas.canvas;
    if (!canvasEl || typeof canvasEl.dispatchEvent !== "function") return false;
    e.preventDefault();
    e.stopPropagation();
    const opts = {
      type: "wheel",
      clientX: e.clientX,
      clientY: e.clientY,
      deltaX: e.deltaX || 0,
      deltaY: e.deltaY || 0,
      ctrlKey: !!e.ctrlKey,
      metaKey: !!e.metaKey,
      shiftKey: !!e.shiftKey,
      bubbles: true,
      cancelable: true,
    };
    let ev;
    if (typeof WheelEvent === "function") {
      ev = new WheelEvent("wheel", opts);
    } else {
      ev = opts;
    }
    canvasEl.dispatchEvent(ev);
    return true;
  } catch (err) {
    return false;
  }
}

function bindPreviewEvents(node) {
  const st = ensureState(node);
  if (!st.dom) return;
  const stage = st.dom.stage;

  // Живое переключение legacy ↔ Nodes 2.0: при включении Vue-режима stage
  // переезжает под LGraphNode (появляется предок [data-node-id]) и
  // TransformPane перехватывает wheel в capture-фазе, а guard, не привязанный
  // в legacy (canvasGuardEl → null), никто не вызывает повторно — без
  // перепривязки Alt+wheel мёртв до перезагрузки. ensureGuard гоняем на
  // событиях, которые доходят до stage в обоих режимах (enter/move/down).
  const ensureGuard = function () {
    const s = ensureState(node);
    if (s.guard && s.guard.el && s.guard.el.isConnected === false) {
      if (typeof s.guard.dispose === "function") s.guard.dispose();
    }
    bindGuardEvents(node);
  };
  stage.addEventListener("pointerenter", ensureGuard);

  stage.addEventListener("wheel", (e) => {
    if (e.altKey && navEnabled(node)) {
      // Наш зум: Alt+колесо только при сравнении двух кадров.
      e.preventDefault();
      e.stopPropagation();
      syncMode(node);
      zoomAt(node, e.clientX, e.clientY, e.deltaY);
      return;
    }
    // Остальное колесо принадлежит графу: форвард на канву (legacy: DomWidgets
    // — сосед канвы, событие без форварда до неё не доходит).
    forwardWheelToCanvas(e);
  }, { passive: false });

  stage.addEventListener("pointerdown", (e) => {
    ensureGuard();
    hideHelp(node);
    syncMode(node);
    if (e.button === 1) {
      // средняя кнопка: панорама (нужен зум; только при сравнении двух кадров)
      if (!navEnabled(node)) return;
      if (st.zoom > 1.0) {
        st.panDrag = true;
        st.lastPan = [num(e.clientX, 0), num(e.clientY, 0)];
        if (typeof stage.setPointerCapture === "function") stage.setPointerCapture(e.pointerId);
        e.preventDefault();
      }
      return;
    }
    if (e.button !== 0) return;
    if (currentMode(node) !== "Slider") return;
    if (typeof stage.setPointerCapture === "function") stage.setPointerCapture(e.pointerId);
    setSliderFromClientX(node, e.clientX);
    e.preventDefault();
  });

  stage.addEventListener("pointermove", (e) => {
    ensureGuard();
    syncMode(node);
    if (st.panDrag) {
      const rect = { x: 0, y: 0, w: previewSize(node).w, h: previewSize(node).h };
      const sr = stageRect(node);
      const sx = sr.width > 0 ? sr.width / rect.w : 1;
      const sy = sr.height > 0 ? sr.height / rect.h : 1;
      const cx = num(e.clientX, 0);
      const cy = num(e.clientY, 0);
      // Экранные дельты делим на масштаб графа screen → local (баг T-COORD pan).
      st.panX += (cx - st.lastPan[0]) / sx;
      st.panY += (cy - st.lastPan[1]) / sy;
      st.lastPan = [cx, cy];
      clampPan(st, rect);
      applyTransforms(node);
      return;
    }
    if (currentMode(node) === "Slider") setSliderFromClientX(node, e.clientX);
  });

  const endDrag = () => {
    st.panDrag = false;
  };
  stage.addEventListener("pointerup", endDrag);
  stage.addEventListener("pointercancel", endDrag);

  stage.addEventListener("dblclick", (e) => {
    e.preventDefault();
    resetView(node);
  });

  const toggleHelp = (e) => {
    if (e && e.preventDefault) e.preventDefault();
    if (st.dom.helpBox.style.display === "block") hideHelp(node);
    else showHelp(node);
  };
  st.dom.help.addEventListener("mouseenter", () => showHelp(node));
  st.dom.help.addEventListener("mouseleave", () => hideHelp(node));
  st.dom.help.addEventListener("click", toggleHelp);
  st.dom.help.addEventListener("blur", () => hideHelp(node));

  bindGuardEvents(node);
}

// ── capture-guard поверх TransformPane (Nodes 2.0) ────────────────────────
//
// В Nodes 2.0 TransformPane висит НАД холстом и в capture-фазе перехватывает
// wheel/pointermove — слушатели на stage (фаза target) графу предшествовать
// уже не могут. Поэтому зум/панораму держим capture-слушателями на предке
// ВЫШЕ TransformPane: корень ищем от элемента ноды [data-node-id] вверх до
// корня документа. Событие принимаем только если оно идёт из нашего превью
// (stage.contains), чтобы не хватать чужие колёса.

function canvasGuardEl(node) {
  const st = ensureState(node);
  const stage = st.dom && st.dom.stage;
  if (!stage || typeof stage.closest !== "function") return null;
  const nodeEl = stage.closest("[data-node-id]");
  if (!nodeEl) return null;
  const doc = typeof document !== "undefined" ? document : null;
  let el = nodeEl;
  while (el.parentNode && el.parentNode !== doc) el = el.parentNode;
  return el;
}

function bindGuardEvents(node) {
  const st = ensureState(node);
  const el = canvasGuardEl(node);
  if (!el) return null;
  if (st.guard && st.guard.el === el) return st.guard;
  if (st.guard && typeof st.guard.dispose === "function") st.guard.dispose();

  const stage = st.dom && st.dom.stage;
  const inside = (e) => !!(stage && e && stage.contains(e.target));

  const onWheel = (e) => {
    if (!inside(e)) return;
    if (!e.altKey) return;            // без Alt колесо принадлежит графу
    if (!navEnabled(node)) return;    // навигация — только при сравнении двух кадров
    if (e.preventDefault) e.preventDefault();
    if (e.stopPropagation) e.stopPropagation();
    syncMode(node);
    zoomAt(node, e.clientX, e.clientY, e.deltaY);
  };

  const onPointerDown = (e) => {
    if (!inside(e)) return;
    if (e.button !== 1) return;
    if (!navEnabled(node)) return;    // навигация — только при сравнении двух кадров
    const st2 = ensureState(node);
    if (!(st2.zoom > 1.0)) return;    // средняя кнопка при обычном виде — графу
    hideHelp(node);
    syncMode(node);
    st2.panDrag = true;
    st2.lastPan = [num(e.clientX, 0), num(e.clientY, 0)];
    if (stage && typeof stage.setPointerCapture === "function" && e.pointerId != null) {
      try { stage.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    }
    if (e.preventDefault) e.preventDefault();
    if (e.stopPropagation) e.stopPropagation();
  };

  const onPointerMove = (e) => {
    const st2 = ensureState(node);
    if (!st2.panDrag) return;
    if (!inside(e)) return;
    const rect = { x: 0, y: 0, w: previewSize(node).w, h: previewSize(node).h };
    const sr = stageRect(node);
    const sx = sr.width > 0 ? sr.width / rect.w : 1;
    const sy = sr.height > 0 ? sr.height / rect.h : 1;
    const cx = num(e.clientX, 0);
    const cy = num(e.clientY, 0);
    // Экранные дельты делим на масштаб графа screen → local (баг T-COORD pan).
    st2.panX += (cx - st2.lastPan[0]) / sx;
    st2.panY += (cy - st2.lastPan[1]) / sy;
    st2.lastPan = [cx, cy];
    clampPan(st2, rect);
    applyTransforms(node);
    if (e.stopPropagation) e.stopPropagation();
  };

  const onPointerUp = (e) => {
    const st2 = ensureState(node);
    if (!st2.panDrag) return;
    st2.panDrag = false;
    if (e && e.stopPropagation) e.stopPropagation();
  };

  el.addEventListener("wheel", onWheel, true);
  el.addEventListener("pointerdown", onPointerDown, true);
  el.addEventListener("pointermove", onPointerMove, true);
  el.addEventListener("pointerup", onPointerUp, true);

  const guard = {
    el: el,
    onWheel: onWheel,
    onPointerDown: onPointerDown,
    onPointerMove: onPointerMove,
    onPointerUp: onPointerUp,
    dispose: function () {
      el.removeEventListener("wheel", onWheel, true);
      el.removeEventListener("pointerdown", onPointerDown, true);
      el.removeEventListener("pointermove", onPointerMove, true);
      el.removeEventListener("pointerup", onPointerUp, true);
      if (st.guard === guard) st.guard = null;
    },
  };
  st.guard = guard;
  return guard;
}

/**
 * Регистрация DOM-виджета.
 * options: getMinHeight — ПОЛ высоты (превью растёт вместе с нодой),
 * hideInPanel — панель свойств иначе пишет widget.width и сжимает превью,
 * serialize:false — не мусорить в widgets_values.
 * ⛔ getHeight/getMaxHeight НЕ задаём: prefHeight = maxHeight распределения,
 * он бы зафиксировал высоту и убил растяжение.
 * ⚠️ margin: computedHeight — это высота ВИДЖЕТА с полями, а элемент получает
 * computedHeight - margin*2. Пол задаём вместе с полями, иначе root с
 * min-height: PREVIEW_MIN_H вылез бы на 2*margin ниже ноды.
 */
function addPreviewWidget(node) {
  const list = node.widgets || [];
  const at = list.findIndex((w) => w && w.name === PREVIEW_WIDGET);
  if (at >= 0) list.splice(at, 1);

  const root = buildPreviewDom(node);
  if (typeof node.addDOMWidget === "function") {
    node.addDOMWidget(PREVIEW_WIDGET, "degg_compare_view", root, {
      serialize: false,
      hideInPanel: true,
      margin: PREVIEW_MARGIN,
      getMinHeight: () => PREVIEW_MIN_H + PREVIEW_MARGIN * 2,
    });
  } else if (typeof node.addCustomWidget === "function") {
    node.addCustomWidget({ type: "dom", name: PREVIEW_WIDGET, element: root, options: { serialize: false, hideInPanel: true } });
  } else {
    list.push({ type: "dom", name: PREVIEW_WIDGET, element: root, options: { serialize: false, hideInPanel: true } });
  }

  bindPreviewEvents(node);
  applyMode(node);
}

/**
 * Ширина ноды: в Nodes 2.0 ширину задаёт CSS-оболочка (`min-width`), а не
 * setSize. `[data-node-id]` существует только в Vue-режиме, поэтому в canvas
 * вызов сам становится no-op.
 */
function applyNodeMinWidth(node) {
  const st = ensureState(node);
  const root = st.dom && st.dom.root;
  const nodeEl = root && typeof root.closest === "function" ? root.closest("[data-node-id]") : null;
  if (nodeEl && nodeEl.style) nodeEl.style.minWidth = MIN_W + "px";
}

function fitNodeToContent(node) {
  if (typeof node.expandToFitContent === "function") node.expandToFitContent();
}

// ── сборка ноды ───────────────────────────────────────────────────────────

/** Ставит виджет сразу после виджета с именем afterName (порядок = порядок рендера). */
function insertWidgetAfter(node, widget, afterName) {
  const list = node.widgets || [];
  const at = list.indexOf(widget);
  if (at >= 0) list.splice(at, 1);
  const ref = list.findIndex((w) => w && w.name === afterName);
  if (ref >= 0) list.splice(ref + 1, 0, widget);
  else list.push(widget);
}

function addButtons(node) {
  if (!getWidget(node, OPEN_BTN)) {
    const openBtn = node.addWidget("button", OPEN_BTN, null, () => openImage1(node), { serialize: false });
    openBtn.serialize = false;
    openBtn.label = node._dscOpenPath ? OPEN_LABEL_READY : OPEN_LABEL_EMPTY;
    // Сразу под ячейкой префикса, выше блока OreX-функционала.
    insertWidgetAfter(node, openBtn, W_PREFIX);
  }
}

/** Виджеты режима меняют картинку на месте — пересобираем режимный CSS. */
function hookModeWidgets(node) {
  for (const name of ["mode", "opacity", "blink_speed"]) {
    const w = getWidget(node, name);
    if (!w || w._dscHooked) continue;
    w._dscHooked = true;
    // П.6: слайдеры без цветной заливки — нейтральный серый (как стандартные).
    if (name !== "mode" && w.options) {
      w.options.slider_color = "#666";
    }
    const orig = w.callback;
    w.callback = function () {
      if (orig) orig.apply(this, arguments);
      try {
        applyMode(node);
      } catch (e) {
        /* ignore */
      }
    };
  }
}

function onNodeCreated(node) {
  if (!node || node._dscReady) return;
  node._dscReady = true;

  ensureState(node);
  node._dscOpenPath = "";

  node.properties = node.properties || {};
  if (node.size && node.size[0] < MIN_W) node.setSize([MIN_W, node.size[1]]);

  const saveMode = getWidget(node, W_SAVE);
  if (saveMode) {
    const origCb = saveMode.callback;
    saveMode.callback = function (val) {
      if (origCb) origCb.apply(this, arguments);
      requestAnimationFrame(() => applySaveMode(node));
    };
  }
  applySaveMode(node);

  addButtons(node);
  addPreviewWidget(node);       // DOM-превью: создать до restore
  hookModeWidgets(node);

  restoreImages(node);          // картинки из properties (смена воркфлоу)
  updateOpenButton(node);
  fitNodeToContent(node);

  // Nodes 2.0 монтирует ноду асинхронно — применяем ширину ещё раз через кадр.
  requestAnimationFrame(() => {
    applyNodeMinWidth(node);
    applyMode(node);
    bindGuardEvents(node);   // предок [data-node-id] появляется после монтирования
  });
}

function onConfigure(node) {
  node.properties = node.properties || {};
  restoreImages(node);
  applySaveMode(node);
  applyMode(node);
  updateOpenButton(node);
  if (node.setDirtyCanvas) node.setDirtyCanvas(true, true);
}

function onExecuted(node, message) {
  if (!node) return;
  ensureState(node);

  const list = (message && message.degg_compare_images) || null;
  const openPath = message && message.degg_open_path && message.degg_open_path[0];
  // Ключ присутствует и с пустым путём: «» обязан чистить кэш пути, иначе
  // кнопка «Открыть» ведёт на файл прошлого прогона (баг T-fix openPath).
  if (openPath !== undefined) node._dscOpenPath = openPath;

  const had1 = !!ensureState(node).meta1;
  const had2 = !!ensureState(node).meta2;
  const seen = { 1: false, 2: false };
  if (Array.isArray(list)) {
    for (const item of list) {
      const slot = Number(item && item.slot);
      if (slot === 1) seen[1] = true;
      if (slot === 2) seen[2] = true;
    }
  }

  // Слоты без свежих данных (например, image_2 отключён) сохраняем как были.
  if (seen[1] || !had1) setSlotImage(node, 1, null, "");
  if (seen[2] || !had2) setSlotImage(node, 2, null, "");

  if (Array.isArray(list)) {
    for (const item of list) {
      if (!item || !item.filename) continue;
      const slot = Number(item.slot);
      if (slot !== 1 && slot !== 2) continue;
      const meta = {
        filename: item.filename,
        subfolder: item.subfolder || "",
        type: item.type || "temp",
      };
      const dim = item.width && item.height ? `${item.width}×${item.height}` : "";
      setSlotImage(node, slot, meta, dim);
    }
  }

  applyMode(node);
  persistImages(node);
  updateOpenButton(node);
  if (node.setDirtyCanvas) node.setDirtyCanvas(true, true);
}

function onRemoved(node) {
  hideHelp(node);
  const st = node && node._cmp;
  if (st && st.guard && typeof st.guard.dispose === "function") st.guard.dispose();
  delete node._cmp;
}

// ── регистрация расширения ────────────────────────────────────────────────

if (app && app.registerExtension) {
  app.registerExtension({
    name: EXT_NAME,
    beforeRegisterNodeDef(nodeType, nodeData) {
      if (!nodeData || nodeData.name !== NODE_NAME) return;
      const proto = nodeType.prototype;

      const origCreated = proto.onNodeCreated;
      proto.onNodeCreated = function () {
        const r = origCreated ? origCreated.apply(this, arguments) : undefined;
        onNodeCreated(this);
        return r;
      };

      const origConfigure = proto.onConfigure;
      proto.onConfigure = function () {
        const r = origConfigure ? origConfigure.apply(this, arguments) : undefined;
        onConfigure(this);
        return r;
      };

      const origExecuted = proto.onExecuted;
      proto.onExecuted = function (message) {
        const r = origExecuted ? origExecuted.apply(this, arguments) : undefined;
        onExecuted(this, message);
        return r;
      };

      const origRemoved = proto.onRemoved;
      proto.onRemoved = function () {
        onRemoved(this);
        return origRemoved ? origRemoved.apply(this, arguments) : undefined;
      };

      // ⛔ proto.computeSize / proto.computeLayoutSize НЕ перезаписываем:
      // LGraphCanvas клампит ресайз по node.computeSize() на каждом pointermove,
      // а у ноды фронтенд computeLayoutSize не вызывает вообще.
    },
  });
}

// ── экспорт для тестов ────────────────────────────────────────────────────

if (typeof window !== "undefined") {
  window.DeggImagesSaveCompare = {
    EXT_NAME: EXT_NAME,
    NODE_NAME: NODE_NAME,
    PREVIEW_MIN_H: PREVIEW_MIN_H,
    PREVIEW_MARGIN: PREVIEW_MARGIN,
    MIN_W: MIN_W,
    MODES: MODES,
    PREVIEW_WIDGET: PREVIEW_WIDGET,
    OPEN_BTN: OPEN_BTN,
    W_SAVE: W_SAVE,
    W_PREFIX: W_PREFIX,
    DOM_STAGE: DOM_STAGE,
    DOM_LINE: DOM_LINE,
    DOM_HELP: DOM_HELP,
    DOM_FOOTER: DOM_FOOTER,
    DIM_BAR_H: DIM_BAR_H,
    OPEN_LABEL_READY: OPEN_LABEL_READY,
    OPEN_LABEL_EMPTY: OPEN_LABEL_EMPTY,
    OPEN_URI: OPEN_URI,
    HELP: HELP,
    num: num,
    getWidget: getWidget,
    getValue: getValue,
    isDrawable: isDrawable,
    ensureState: ensureState,
    currentMode: currentMode,
    navEnabled: navEnabled,
    metaUrl: metaUrl,
    persistImages: persistImages,
    restoreImages: restoreImages,
    setSlotImage: setSlotImage,
    refreshLabels: refreshLabels,
    applySaveMode: applySaveMode,
    previewSize: previewSize,
    stageRect: stageRect,
    buildPreviewDom: buildPreviewDom,
    bindPreviewEvents: bindPreviewEvents,
    applyMode: applyMode,
    applySliderClip: applySliderClip,
    setSliderView: setSliderView,
    updateViewSel: updateViewSel,
    DOM_VIEW: DOM_VIEW,
    VIEW_ITEMS: VIEW_ITEMS,
    VIEW_VALUES: VIEW_VALUES,
    applyTransforms: applyTransforms,
    showHelp: showHelp,
    hideHelp: hideHelp,
    addButtons: addButtons,
    addPreviewWidget: addPreviewWidget,
    insertWidgetAfter: insertWidgetAfter,
    applyNodeMinWidth: applyNodeMinWidth,
    onNodeCreated: onNodeCreated,
    onConfigure: onConfigure,
    onExecuted: onExecuted,
    onRemoved: onRemoved,
    zoomAt: zoomAt,
    setSliderFromClientX: setSliderFromClientX,
    resetView: resetView,
    sbsHalfLayout: sbsHalfLayout,
    sbsHalfAt: sbsHalfAt,
    sbsOrientation: sbsOrientation,
    clampPan: clampPan,
    canvasGuardEl: canvasGuardEl,
    bindGuardEvents: bindGuardEvents,
  };
}
