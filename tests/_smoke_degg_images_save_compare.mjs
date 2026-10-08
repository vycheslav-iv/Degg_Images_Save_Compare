// JS-смоук Degg_Images_Save_Compare: исполняет web/js/degg_images_save_compare.js
// в vm-контексте с заглушками window/comfyAPI/document и проверяет контракт
// фронтенда по DOM-виджету (скил comfyui-dom-widget-sizing):
//   • расширение зарегистрировано, beforeRegisterNodeDef фильтрует по имени;
//   • порядок виджетов: save_mode → filename_prefix → кнопка открытия → mode →
//     opacity → blink_speed → холст сравнения;
//   • превью — DOM-виджет (addDOMWidget): НЕТ canvas-draw/mouse/computeSize,
//     ЕСТЬ getMinHeight (пол высоты) и НЕТ getHeight (иначе высота пинится и
//     превью не растягивается вместе с нодой);
//   • DOM-структура: root → stage → (img2, img1, линия шторки) + подписи/«?»;
//   • 5 режимов на DOM/CSS (clip-path / половины / opacity / mix-blend-mode /
//     анимация), БЕЗ z-index (иначе mix-blend-mode не смешивается с img1),
//     Difference — blend на КОРОБКЕ слоя (на <img> внутри scene blend
//     изолирован transform-ом и режим не работал);
//   • подписи размеров — футер dsc-footer ПОД изображением (вне кадра):
//     Image 1 белый, Image 2 серый;
//   • Side-by-Side выбирает ориентацию сам: ландшафт → сверху/снизу,
//     портрет → слева/справа (sbsOrientation);
//   • шторка идёт за курсором без drag-состояния (как в стандартной ноде
//     ImageCompare — useMouseInElement), зум Alt+колесо, панорама средней
//     кнопкой, двойной клик — сброс: всё на событиях РЕАЛЬНОГО элемента;
//   • ⭐ битая картинка (404 после очистки temp) не роняет отрисовку:
//     drawImage не вызывается для HTMLImageElement в состоянии 'broken';
//   • подсказка — DOM-узел под кнопкой «?»: гасится по mouseleave, глобальных
//     слушателей (window/document) у ноды нет вовсе;
//   • ⭐ персистентность: картинки восстанавливаются из node.properties
//     (переключение воркфлоу туда-обратно) — без повторного onExecuted.
// Запуск:  cd Degg_Images_Save_Compare && node tests/_smoke_degg_images_save_compare.mjs
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FILE = path.join(ROOT, "web", "js", "degg_images_save_compare.js");

const errors = [];
const oks = [];
const check = (label, cond, extra = "") => {
  (cond ? oks : errors).push(label);
  if (!cond) console.log(`  ASSERT FAIL  ${label}${extra ? "  [" + extra + "]" : ""}`);
  else console.log(`  ok  ${label}`);
};

let capturedExt = null;
let rafQueue = [];
let windowAdds = 0;
let documentAdds = 0;

// ── заглушка DOM ──────────────────────────────────────────────────────────
class FakeEl {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.className = "";
    this.id = "";
    this.textContent = "";
    this.clientWidth = 0;
    this.clientHeight = 0;
    this.draggable = false;
    this.alt = "";
    this._listeners = Object.create(null);
    this._closest = Object.create(null);
    this.dispatchCount = 0;
  }
  appendChild(child) {
    if (child.parentNode) {
      const at = child.parentNode.children.indexOf(child);
      if (at >= 0) child.parentNode.children.splice(at, 1);
    }
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  removeChild(child) {
    const at = this.children.indexOf(child);
    if (at >= 0) this.children.splice(at, 1);
    child.parentNode = null;
    return child;
  }
  replaceChildren(...nodes) {
    this.children = [];
    nodes.forEach((n) => this.appendChild(n));
  }
  contains(el) {
    if (el === this) return true;
    return this.children.some((c) => c.contains && c.contains(el));
  }
  closest(sel) {
    return this._closest[sel] || null;
  }
  setAttribute(k, v) {
    this[k] = v;
  }
  addEventListener(type, fn) {
    (this._listeners[type] = this._listeners[type] || []).push(fn);
  }
  removeEventListener(type, fn) {
    const list = this._listeners[type] || [];
    const at = list.indexOf(fn);
    if (at >= 0) list.splice(at, 1);
  }
  listeners(type) {
    return this._listeners[type] || [];
  }
  hasListener(type) {
    return this.listeners(type).length > 0;
  }
  dispatch(type, ev = {}) {
    this.dispatchCount += 1;
    const e = Object.assign(
      { type, button: 0, buttons: 1, pointerId: 1, clientX: 0, clientY: 0, altKey: false, deltaY: 0, preventDefault() {}, stopPropagation() {} },
      ev
    );
    for (const fn of this.listeners(type)) fn(e);
    return e;
  }
  // Синтетическое событие из forwardWheelToCanvas уходит на канву графа
  // через dispatchEvent — заглушка обязана его принять и записать.
  dispatchEvent(ev) {
    this.dispatchCount += 1;
    this.lastDispatched = ev;
    const type = ev && ev.type;
    if (type) {
      for (const fn of this.listeners(type)) fn(ev);
    }
    return !(ev && ev.defaultPrevented);
  }
  getBoundingClientRect() {
    return { left: this._rectLeft || 0, top: this._rectTop || 0, width: this.clientWidth, height: this.clientHeight };
  }
  setPointerCapture() {}
  releasePointerCapture() {}
  hasPointerCapture() {
    return false;
  }
  focus() {}
  blur() {}
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
}

// <img> ведёт себя как браузерный элемент: 404-путь уходит в 'broken'
// (complete=true, naturalWidth=0) — именно это состояние роняло drawImage.
class FakeImg extends FakeEl {
  constructor() {
    super("img");
    this.complete = false;
    this.naturalWidth = 0;
    this.naturalHeight = 0;
    this.onload = null;
    this.onerror = null;
    this._src = "";
  }
  set src(v) {
    this._src = String(v || "");
    if (!this._src) {
      this.complete = false;
      this.naturalWidth = 0;
      this.naturalHeight = 0;
      return;
    }
    if (/missing/.test(this._src)) {
      this.complete = true;
      this.naturalWidth = 0;
      this.naturalHeight = 0;
      if (typeof this.onerror === "function") this.onerror();
      return;
    }
    this.complete = true;
    this.naturalWidth = 640;
    this.naturalHeight = 480;
    if (typeof this.onload === "function") this.onload();
  }
  get src() {
    return this._src;
  }
}

const mainCanvasEl = new FakeEl("canvas");
mainCanvasEl.width = 1200;
mainCanvasEl.height = 800;
const appInstance = {
  registerExtension: (e) => { capturedExt = e; },
  canvas: {
    canvas: mainCanvasEl,
    node_over: null,
    convertCanvasToOffset: (p) => [p[0], p[1]],
  },
};

const documentStub = {
  createElement: (tag) => {
    const t = String(tag).toLowerCase();
    if (t === "img") return new FakeImg();
    return new FakeEl(tag);
  },
  head: new FakeEl("head"),
  body: new FakeEl("body"),
  getElementById: () => null,
  addEventListener: () => { documentAdds += 1; },
  removeEventListener: () => {},
};

// Захват отложенных колбэков: flashLabel() планирует таймер через 2с, а
// заглушка setTimeout не исполняла его — порча label оставалась незамеченной.
const timerQueue = [];
/** Прогнать все отложенные колбэки (эмуляция таймера). */
const flushTimers = () => {
  const q = timerQueue.splice(0);
  for (const t of q) t.fn();
};

const sandbox = {
  console,
  // Старый код грузил превью через new Image(); новый ставит src прямо на
  // <img> DOM-слоя — заглушка нужна, чтобы старый вариант не падал раньше
  // места, где красные проверки успевают посчитать FAIL.
  Image: FakeImg,
  document: documentStub,
  comfyAPI: {
    app: { app: appInstance, registerExtension: appInstance.registerExtension },
    api: { api: { apiURL: (p) => `http://127.0.0.1:8188${p}`, fetchApi: () => Promise.resolve({ json: () => Promise.resolve({ success: true }) }) } },
  },
  app: appInstance,
  setTimeout: (fn, ms) => { timerQueue.push({ fn: fn, ms: ms }); return timerQueue.length; },
  clearTimeout: () => {},
  requestAnimationFrame: (fn) => { rafQueue.push(fn); return rafQueue.length; },
  fetch: () => Promise.resolve({ json: () => Promise.resolve({ success: true }) }),
  addEventListener: () => { windowAdds += 1; },
  removeEventListener: () => {},
};
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(FILE, "utf8"), sandbox, { filename: "degg_images_save_compare.js" });

const DSC = sandbox.window.DeggImagesSaveCompare;
check("расширение захвачено", !!capturedExt);
check("EXT_NAME верный", capturedExt && capturedExt.name === "Degg_Images_Save_Compare");
check("window.DeggImagesSaveCompare экспортирован", !!DSC);
if (!DSC) {
  console.log("\nSMOKE FAILED (нет экспорта)");
  process.exit(1);
}

// ── заглушка ноды (как её создаёт фронтенд по INPUT_TYPES) ────────────────
function makeNode() {
  const node = {
    size: [140, 80],
    widgets: [],
    properties: {},
    setDirtyCount: 0,
    addWidget(type, name, value, cb, opts) {
      const w = { type, name, value, callback: cb, options: opts || {}, serialize: true, label: name, last_y: 0 };
      this.widgets.push(w);
      return w;
    },
    // DOMWidgetImpl: элемент + options (getMinHeight/hideInPanel/...).
    addDOMWidget(name, type, element, options) {
      const w = {
        type: type || "dom",
        name,
        element,
        options: options || {},
        serialize: false,
        y: 0,
        computedHeight: undefined,
        margin: 10,
      };
      this.widgets.push(w);
      return w;
    },
    addCustomWidget(w) { this.widgets.push(w); return w; },
    setSize(s) { this.size = s; },
    setDirtyCanvas() { this.setDirtyCount += 1; },
    expandToFitContent() {},
    computeSize() { return [this.size[0], this.size[1] + 320]; },
  };
  // виджеты, которые создаёт фронтенд из INPUT_TYPES
  node.widgets.push(
    { name: "save_mode", type: "toggle", value: true, options: {}, last_y: 26, computeSize: () => [0, 24] },
    { name: "filename_prefix", type: "text", value: "ComfyUI", options: {}, last_y: 50, computeSize: () => [0, 24] },
    // combo: фронтенд сам кладёт сюда значения из INPUT_TYPES (options.values),
    // а подписи отдаёт отдельно через options.getOptionLabel.
    { name: "mode", type: "combo", value: "Off", options: { values: DSC.MODES.slice() }, last_y: 74, computeSize: () => [0, 24] },
    { name: "opacity", type: "number", value: 0.5, options: {}, last_y: 98, computeSize: () => [0, 24] },
    { name: "blink_speed", type: "number", value: 1.0, options: {}, last_y: 122, computeSize: () => [0, 24] },
  );
  return node;
}

/** Найти элемент по предикату (обход DOM-заглушки). */
function findEl(root, pred) {
  if (!root || !root.children) return null;
  for (const c of root.children) {
    if (pred(c)) return c;
    const deep = findEl(c, pred);
    if (deep) return deep;
  }
  return null;
}

// ── beforeRegisterNodeDef: чужую ноду не трогаем ──────────────────────────
const protoHolder = {};
function NodeType() {}
NodeType.prototype = protoHolder;
capturedExt.beforeRegisterNodeDef(NodeType, { name: "NotDegg" });
check("чужая нода не получила перехват onNodeCreated", typeof protoHolder.onNodeCreated !== "function");

capturedExt.beforeRegisterNodeDef(NodeType, { name: "Degg_Images_Save_Compare" });
check("наша нода получила onNodeCreated", typeof protoHolder.onNodeCreated === "function");
check("наша нода получила onConfigure", typeof protoHolder.onConfigure === "function");
check("наша нода получила onExecuted", typeof protoHolder.onExecuted === "function");
check("наша нода получила onRemoved", typeof protoHolder.onRemoved === "function");
check("proto.computeSize НЕ перезаписан", protoHolder.computeSize === undefined);
check("proto.computeLayoutSize НЕ перезаписан", protoHolder.computeLayoutSize === undefined);

// ── создание ноды ─────────────────────────────────────────────────────────
const node = makeNode();
protoHolder.onNodeCreated.call(node);
rafQueue.forEach((f) => f());
rafQueue = [];

const names = node.widgets.map((w) => w.name);
check("порядок виджетов как в задаче",
  JSON.stringify(names) === JSON.stringify([
    "save_mode", "filename_prefix", "open_image_1", "mode", "opacity",
    "blink_speed", "degg_compare_preview",
  ]), JSON.stringify(names));
check("id готовности выставлен", node._dscReady === true);
check("node.onMouseMove НЕ перезаписан (нет моста координат)", node.onMouseMove === undefined);
check("нода не вешает слушателей на window/document",
  windowAdds === 0 && documentAdds === 0, `window=${windowAdds} document=${documentAdds}`);

// ── превью: DOM-виджет ────────────────────────────────────────────────────
const preview = DSC.getWidget(node, DSC.PREVIEW_WIDGET);
check("превью добавлено последним", node.widgets[node.widgets.length - 1] === preview);
check("превью: это DOM-виджет (есть element, нет canvas-draw)",
  preview && !!preview.element && preview.draw === undefined && preview.mouse === undefined,
  JSON.stringify({ element: !!preview.element, draw: typeof preview.draw }));
check("превью: legacy computeSize НЕ задан (иначе высота пинится)", preview && preview.computeSize === undefined);
check("превью: options.serialize = false", preview && preview.options.serialize === false);
check("превью: options.hideInPanel (панель свойств не перепишет widget.width)",
  preview && preview.options.hideInPanel === true);
check("превью: canvasOnly НЕ выставлен", preview && preview.options.canvasOnly === undefined);
check("превью: getMinHeight есть и учитывает margin виджета",
  preview && typeof preview.options.getMinHeight === "function" &&
  preview.options.getMinHeight() === DSC.PREVIEW_MIN_H + 2 * DSC.PREVIEW_MARGIN,
  preview && typeof preview.options.getMinHeight);
check("превью: пол виджета минус поля = пол корневого элемента (нет вылезания ниже ноды)",
  preview && preview.options.getMinHeight() - 2 * (preview.options.margin || 0) === DSC.PREVIEW_MIN_H,
  preview && String(preview.options.margin));
check("превью: getHeight НЕ задан (height пиннит распределение места → нет растяжения)",
  preview && preview.options.getHeight === undefined && preview.options.getMaxHeight === undefined);

check("превью: applyMode существует (режимы переключает DOM-слой)", typeof DSC.applyMode === "function");
const st = DSC.ensureState(node);

// Заглушки-фолбэки: на старом коде (canvas-виджет) DOM-узлов нет — проверки
// ниже обязаны ПАДАТЬ, а не ронять смоук, чтобы был виден полный счёт FAIL.
const root = preview.element || new FakeEl("div");
const stage = findEl(root, (e) => e.id === "dsc-stage") || new FakeEl("div");
const layer1 = (st.dom && st.dom.a) || { box: new FakeEl("div"), scene: new FakeEl("div"), img: new FakeImg() };
const layer2 = (st.dom && st.dom.b) || { box: new FakeEl("div"), scene: new FakeEl("div"), img: new FakeImg() };
check("DOM: root заполняет виджет (height:100%)", root.style.height === "100%");
check("DOM: root имеет пол высоты = PREVIEW_MIN_H", root.style.minHeight === DSC.PREVIEW_MIN_H + "px");
check("DOM: root обрезает содержимое (overflow hidden)", root.style.overflow === "hidden");
check("п.5: фон root прозрачный — виден серый фон ноды (как в стандартных)",
  !root.style.background || root.style.background === "transparent" || root.style.background === "rgba(0, 0, 0, 0)",
  root.style.background);
check("DOM: stage найден", !!stage);
check("DOM: stage обрезает и изолирует смешивание",
  !!stage && stage.style.overflow === "hidden" && stage.style.isolation === "isolate");
const imgs = [];
findEl(root, (e) => {
  if (e.tagName === "IMG") imgs.push(e);
  return false;
});
check("DOM: два <img> (Image 1 и Image 2)", imgs.length === 2, String(imgs.length));
check("DOM: картинки вписаны object-fit: contain",
  imgs.length === 2 && imgs.every((i) => i.style.objectFit === "contain"));
const helpBtn = findEl(root, (e) => e.tagName === "BUTTON") || new FakeEl("button");
const helpBox = findEl(root, (e) => e.id === "dsc-help") || new FakeEl("div");
check("DOM: кнопка «?» есть", !!helpBtn);
check("DOM: блок подсказки есть и спрятан", !!helpBox && helpBox.style.display === "none");
const lineEl = findEl(root, (e) => e.id === "dsc-line") || new FakeEl("div");
check("DOM: линия шторки есть", !!lineEl);

// ── подписи размеров: футер ВНЕ области изображения (как в стандартной ноде) ─
const footerEl = (st.dom && st.dom.footer) || new FakeEl("div");
const dim1El = (st.dom && st.dom.dim1) || new FakeEl("div");
const dim2El = (st.dom && st.dom.dim2) || new FakeEl("div");
const badgeEl = (st.dom && st.dom.badge) || new FakeEl("div");
check("dim: футер существует и прижат к низу превью",
  !!(st.dom && st.dom.footer) && footerEl.style.bottom === "0", footerEl.style.bottom);
check("dim: подписи внутри футера, а не поверх изображения",
  dim1El.parentNode === footerEl && dim2El.parentNode === footerEl,
  dim1El.parentNode && dim1El.parentNode.id);
check("dim: изображение обрезано по футер (stage выше подписей)",
  stage.style.bottom === (DSC.DIM_BAR_H || 0) + "px" && !stage.contains(dim1El),
  `stage.bottom=${stage.style.bottom} DIM_BAR_H=${DSC.DIM_BAR_H}`);
check("dim: подпись Image 1 белая", dim1El.style.color === "#ffffff", dim1El.style.color);
check("dim: подпись Image 2 серая", dim2El.style.color === "#999999", dim2El.style.color);
check("п.5: фон футера подписей прозрачный (нет тёмного поля вокруг кадра)",
  !footerEl.style.background || footerEl.style.background === "transparent" || footerEl.style.background === "rgba(0, 0, 0, 0)",
  footerEl.style.background);
check("dim: без цветной подсветки (текст на сером поле, без textShadow)",
  !dim1El.style.textShadow && !dim2El.style.textShadow,
  `${dim1El.style.textShadow} / ${dim2El.style.textShadow}`);
check("dim (Off): один размер Image 1, по центру футера снизу",
  dim1El.style.left === "0px" && dim1El.style.right === "0px" && dim1El.style.textAlign === "center",
  `${dim1El.style.left} / ${dim1El.style.right} / ${dim1El.style.textAlign}`);
check("dim (Off): подпись Image 2 скрыта (режим просмотра — один размер)",
  dim2El.style.display === "none", dim2El.style.display);
check("бейдж зума поднят над футер подписей",
  badgeEl.style.bottom === ((DSC.DIM_BAR_H || 0) + 6) + "px", badgeEl.style.bottom);
check("T5: бейдж кратности зума — цифры БЕЛЫЕ (стандартный стиль, не синие)",
  badgeEl.style.color === "#ffffff", `color=${badgeEl.style.color}`);

// ── слайдер: тонкая СЕРАЯ линия (по задаче — вдвое тоньше, без ручки) ────
const knobEl = findEl(lineEl, (e) => e.id === "dsc-knob");
check("слайдер: линия тонкая (1px, вдвое тоньше)", lineEl.style.width === "1px", lineEl.style.width);
check("слайдер: круг-ручка dsc-knob УДАЛЕНА (по задаче)", !knobEl,
  knobEl && knobEl.id);
check("слайдер: серая линия #808080, белого/жёлтого нет",
  lineEl.style.background === "#808080"
  && !/FFEE00|yellow/i.test(String(lineEl.style.background || "")),
  lineEl.style.background);
check("слайдер: сегменты сверху/снизу удалены (сплошная линия)",
  !findEl(lineEl, (e) => e.id === "dsc-seg-top")
  && !findEl(lineEl, (e) => e.id === "dsc-seg-bottom"));

// ── селектор вида: 3 кнопки в футере (Пара с иконкой / 1 / 2) ─────────────
// П.3: Шторка и Сетка давали одинаковую пару половин — «Сетка» удалена,
// у элемента пары иконка «два прямоугольника рядом» (фолбэк — квадрат).
const viewSel = (st.dom && st.dom.viewSel) || new FakeEl("div");
check("селектор вида лежит в футере подписей",
  !!(st.dom && st.dom.viewSel) && viewSel.parentNode === footerEl,
  viewSel.parentNode && viewSel.parentNode.id);
check("п.3: VIEW_ITEMS — ровно 3 пункта, значение grid удалено",
  DSC.VIEW_ITEMS.length === 3 && DSC.VIEW_VALUES.indexOf("grid") === -1,
  JSON.stringify(DSC.VIEW_ITEMS.map((i) => i.view)));
check("п.3: нет DOM-элемента dsc-view-grid",
  !findEl(viewSel, (e) => e.id === "dsc-view-grid"));
const pairEl = findEl(viewSel, (e) => e.id === "dsc-view-split");
check("п.3: элемент пары dsc-view-split существует", !!pairEl,
  pairEl ? "" : JSON.stringify(viewSel.children.map((c) => c.id)));
check("п.3: иконка пары — два прямоугольника рядом (2 child-узла)",
  !!pairEl && pairEl.children.length === 2,
  pairEl ? String(pairEl.children.length) : "нет элемента");
check("п.3: элемент пары — квадратная кнопка, не круг",
  !!pairEl && pairEl.style.borderRadius === "3px",
  pairEl && pairEl.style.borderRadius);
check("по умолчанию Off: селектор вида скрыт (режим по умолчанию — просмотрщик)",
  (st.dom && st.dom.viewSel ? st.dom.viewSel.style.display : "") === "none",
  viewSel.style.display);

// ── п.6: слайдеры без цвета — нейтральный серый slider_color ──────────────
const opW = DSC.getWidget(node, "opacity");
const blW = DSC.getWidget(node, "blink_speed");
check("п.6: opacity — slider_color серый #666 (как стандартные виджеты)",
  !!(opW && opW.options) && opW.options.slider_color === "#666",
  opW && opW.options ? String(opW.options.slider_color) : "нет виджета");
check("п.6: blink_speed — slider_color серый #666",
  !!(blW && blW.options) && blW.options.slider_color === "#666",
  blW && blW.options ? String(blW.options.slider_color) : "нет виджета");

// ── Save/Preview: гашение префикса ────────────────────────────────────────
const fp = DSC.getWidget(node, DSC.W_PREFIX);
DSC.getWidget(node, DSC.W_SAVE).value = false;
DSC.applySaveMode(node);
check("Preview: filename_prefix погашен (w.disabled)", fp.disabled === true);
check("Preview: filename_prefix options.disabled (поле, которое читает фронтенд)",
  !!(fp.options && fp.options.disabled === true));
DSC.getWidget(node, DSC.W_SAVE).value = true;
DSC.applySaveMode(node);
check("Save: filename_prefix активен", fp.disabled === false && !!(fp.options && fp.options.disabled === false));

const openBtn = DSC.getWidget(node, DSC.OPEN_BTN);
check("кнопка открытия создана без serialize", openBtn && openBtn.serialize === false);
check("кнопка открытия: пустая надпись — «No image» (как в Image Save/Preview)",
  openBtn.label === "No image", openBtn.label);
const openReadyLabel = DSC.OPEN_LABEL_READY || "";
const openEmptyLabel = DSC.OPEN_LABEL_EMPTY || "";
check("подписи кнопок ровно как в Image Save/Preview (без эмодзи-иконок)",
  openReadyLabel === "Open in Viewer" && openEmptyLabel === "No image",
  `${openReadyLabel} / ${openEmptyLabel}`);

// ── T-fix: клик по «No image» без пути не должен планировать порчу label ───
// Старый код: flashLabel(EMPTY) без restore → через 2с label = undefined.
openBtn.callback();
flushTimers();
check("T-fix: клик по «No image» не затирает подпись кнопки (flash без restore)",
  openBtn.label === openEmptyLabel, String(openBtn.label));

// ── 5 режимов на DOM/CSS ──────────────────────────────────────────────────
stage.clientWidth = 600;
stage.clientHeight = 320;
const setMode = (m) => {
  DSC.getWidget(node, "mode").value = m;
  if (typeof DSC.applyMode === "function") DSC.applyMode(node);
};
let modeErr = null;
try {
  for (const m of ["Slider", "Side-by-Side", "Overlap", "Difference", "Blink", "Off"]) setMode(m);
} catch (e) { modeErr = e; }
check("applyMode проходит все 6 режимов без ошибок", !modeErr, modeErr && modeErr.message);
check("MODES: Off первым (по умолчанию просмотрщик)",
  DSC.MODES.length === 6 && DSC.MODES[0] === "Off" && DSC.MODES[1] === "Slider",
  JSON.stringify(DSC.MODES));

setMode("Slider");
DSC.setSliderView(node, "img2");
check("Slider: вид не влияет — всегда шторка (st.sliderView=img2 проигнорирован)",
  lineEl.style.display === "block" && /^inset\(0 .*% 0 0\)$/.test(layer1.box.style.clipPath || ""),
  `${lineEl.style.display} / ${layer1.box.style.clipPath}`);
DSC.setSliderView(node, "split");
check("dim (не Off): подпись Image 1 слева, Image 2 снова видима",
  dim1El.style.left === "8px" && dim1El.style.textAlign === "left" && dim2El.style.display !== "none",
  `${dim1El.style.left} / ${dim1El.style.textAlign} / ${dim2El.style.display}`);
check("Slider: шторка режет Image 1 через clip-path",
  /^inset\(0 .*% 0 0\)$/.test(layer1.box.style.clipPath || ""), layer1.box.style.clipPath);
check("Slider: Image 2 не режется", !layer2.box.style.clipPath);
check("Slider: линия шторки показана", lineEl.style.display === "block");
check("Slider: линия прижата к левому краю по позиции",
  lineEl.style.left === "50%", lineEl.style.left);

// ── кнопки вида живут в Side-by-Side; в Slider они скрыты (по задаче) ─────
const clickView = (id) => {
  const it = findEl((st.dom && st.dom.viewSel) || new FakeEl("div"), (e) => e.id === id);
  if (it) it.dispatch("click", {});
  return !!it;
};
check("селектор вида скрыт в режиме Slider (виды перенесены в SBS)",
  !!(st.dom && st.dom.viewSel) && st.dom.viewSel.style.display === "none",
  viewSel.style.display);
setMode("Off");
check("селектор вида скрыт в режиме Off",
  !!(st.dom && st.dom.viewSel) && st.dom.viewSel.style.display === "none",
  viewSel.style.display);
setMode("Slider");

setMode("Side-by-Side");
check("Side-by-Side: половины по 50%",
  layer1.box.style.width === "calc(50% - 1px)" && layer2.box.style.width === "calc(50% - 1px)",
  `${layer1.box.style.width} / ${layer2.box.style.width}`);
check("Side-by-Side: вторая половина сдвинута вправо",
  layer2.box.style.left === "calc(50% + 1px)", layer2.box.style.left);
check("Side-by-Side: шторка не режет и линия скрыта",
  !layer1.box.style.clipPath && lineEl.style.display === "none");

// ── кнопки вида в режиме Side-by-Side (перенесены из Slider по задаче) ─────
check("селектор вида показан в режиме Side-by-Side",
  !!(st.dom && st.dom.viewSel) && st.dom.viewSel.style.display === "flex",
  viewSel.style.display);
check("вид по умолчанию — пара (split)",
  (st.sliderView || "split") === "split", String(st.sliderView));
check("кружок Image 2 кликается", clickView("dsc-view-img2"));
check("SBS вид Image 2: одиночный кадр (полный размер), клипа/линии нет",
  layer2.box.style.width === "100%" && lineEl.style.display === "none" && !layer1.box.style.clipPath,
  `${layer2.box.style.width} / ${lineEl.style.display} / ${layer1.box.style.clipPath}`);
check("SBS вид Image 2: Image 2 сверху (полное превью второго кадра)",
  stage.children.indexOf(layer2.box) > stage.children.indexOf(layer1.box));
check("SBS вид Image 2: состояние st.sliderView", st.sliderView === "img2", String(st.sliderView));
check("кнопка Пара кликается (сброс одиночного вида)", clickView("dsc-view-split"));
check("SBS вид Пара: снова пара половин",
  layer1.box.style.width === "calc(50% - 1px)" && layer2.box.style.left === "calc(50% + 1px)"
  && !layer1.box.style.clipPath,
  `${layer1.box.style.width} / ${layer2.box.style.left}`);
check("п.3: клик по dsc-view-grid невозможен (элемент удалён)", !clickView("dsc-view-grid"));
check("кнопка Image 1 кликается", clickView("dsc-view-img1"));
check("SBS вид Image 1: одиночный кадр, Image 1 сверху",
  layer1.box.style.width === "100%"
  && stage.children.indexOf(layer1.box) > stage.children.indexOf(layer2.box),
  `${layer1.box.style.width} / idx1=${stage.children.indexOf(layer1.box)} idx2=${stage.children.indexOf(layer2.box)}`);
check("п.3: из любого одиночного вида Пара возвращает пару", clickView("dsc-view-split")
  && layer1.box.style.width === "calc(50% - 1px)" && layer2.box.style.width === "calc(50% - 1px)");

setMode("Overlap");
DSC.getWidget(node, "opacity").value = 0.25;
setMode("Overlap");
check("Overlap: прозрачность Image 1 = opacity",
  (imgs[0] || { style: {} }).style.opacity === "0.25" || layer1.img.style.opacity === "0.25",
  layer1.img.style.opacity);
check("Overlap: Image 2 без смешивания", !layer2.img.style.mixBlendMode);

setMode("Difference");
check("Difference: mix-blend-mode на КОРОБКЕ слоя (смешивается с Image 1 внутри stage)",
  layer2.box.style.mixBlendMode === "difference", layer2.box.style.mixBlendMode);check("Difference: у <img> НЕТ mix-blend-mode (внутри scene с transform blend изолирован и режим не виден)",
  !layer2.img.style.mixBlendMode, layer2.img.style.mixBlendMode);
check("Difference: прозрачность сброшена", !layer1.img.style.opacity);
setMode("Slider");
check("Difference сбрасывается при смене режима", !layer2.box.style.mixBlendMode,
  layer2.box.style.mixBlendMode);

setMode("Off");
check("Off: без шторки — чистый просмотрщик", lineEl.style.display === "none",
  lineEl.style.display);
check("Off: без клипа (Image 1 на весь кадр)", !layer1.box.style.clipPath,
  layer1.box.style.clipPath);
check("Off: Image 1 поверх Image 2",
  stage.children.indexOf(layer1.box) > stage.children.indexOf(layer2.box));
check("Off: без режимного blend/анимации",
  !layer1.img.style.mixBlendMode && !layer1.img.style.animation
  && !layer2.img.style.mixBlendMode && !layer2.img.style.opacity);
// В Off (режим, отключающий сравнение) второе изображение не показывается
// вовсе: раньше слой Image 2 лежал под Image 1 и проглядывал в letterbox-полях.
check("Off: слой Image 2 скрыт (режим отключает сравнение)",
  layer2.box.style.display === "none", String(layer2.box.style.display));
check("Off: слой Image 1 остаётся видимым",
  layer1.box.style.display !== "none", String(layer1.box.style.display));
setMode("Slider");
check("выход из Off в Slider: слой Image 2 появляется без повторного прогона",
  layer2.box.style.display === "", String(layer2.box.style.display));
setMode("Slider");

DSC.getWidget(node, "blink_speed").value = 1.0;
setMode("Blink");
check("Blink: на Image 1 повешена CSS-анимация", /dscBlink/.test(layer1.img.style.animation || ""),
  layer1.img.style.animation);
check("Blink: длительность = 2 фазы × blink_speed", /dscBlink 2s/.test(layer1.img.style.animation || ""),
  layer1.img.style.animation);
check("режимы НЕ используют z-index (иначе mix-blend-mode не смешается с Image 1)",
  [layer1.box, layer2.box].every((l) => !l.style.zIndex));

// ── Side-by-Side: автовыбор ориентации ───────────────────────────────────
// Ландшафт (широкий кадр) → кадры друг над другом (экономит высоту ноды),
// портрет → слева и справа. Выбор по Image 1 (fallback Image 2).
const sbsNode = makeNode();
protoHolder.onNodeCreated.call(sbsNode);
rafQueue.forEach((f) => f());
rafQueue = [];
const sbsSt = DSC.ensureState(sbsNode);
const sbsDom = sbsSt.dom;
DSC.getWidget(sbsNode, "mode").value = "Side-by-Side";
DSC.applyMode(sbsNode);
check("SBS без картинок: слева/справа (дефолт)",
  sbsDom.a.box.style.width === "calc(50% - 1px)" && sbsDom.a.box.style.height === "100%",
  `${sbsDom.a.box.style.width} / ${sbsDom.a.box.style.height}`);
check("SBS: функция автовыбора ориентации есть",
  typeof DSC.sbsOrientation === "function");

DSC.setSlotImage(sbsNode, 1, { filename: "wide.png", subfolder: "", type: "output" }, "640×480");
DSC.setSlotImage(sbsNode, 2, { filename: "wide2.png", subfolder: "", type: "temp" }, "640×480");
check("SBS: ландшафт 640×480 → ориентация «v»",
  typeof DSC.sbsOrientation === "function" && DSC.sbsOrientation(sbsSt) === "v",
  typeof DSC.sbsOrientation === "function" ? String(DSC.sbsOrientation(sbsSt)) : "нет функции");
check("SBS ландшафт: кадры друг над другом",
  sbsDom.a.box.style.height === "calc(50% - 1px)" && sbsDom.b.box.style.top === "calc(50% + 1px)"
  && sbsDom.a.box.style.width === "100%" && sbsDom.b.box.style.width === "100%",
  `${sbsDom.a.box.style.width} / ${sbsDom.a.box.style.height} / top=${sbsDom.b.box.style.top}`);
check("SBS ландшафт: зазор между кадрами снизу у Image 1",
  sbsDom.a.box.style.height.indexOf("50%") > 0, sbsDom.a.box.style.height);

const halfV = typeof DSC.sbsHalfAt === "function"
  ? DSC.sbsHalfAt(sbsSt, { x: 0, y: 0, w: 600, h: 320 }, 300, 10, "v") : null;
check("sbsHalfAt(v): верхняя половина — Image 1",
  !!halfV && halfV.img === sbsSt.img1 && halfV.boxOrigin === 0,
  JSON.stringify({ img1: !!halfV && halfV.img === sbsSt.img1, boxOrigin: halfV && halfV.boxOrigin }));
const vLay = typeof DSC.sbsHalfLayout === "function"
  ? DSC.sbsHalfLayout({ x: 0, y: 0, w: 600, h: 320 }, { naturalWidth: 640, naturalHeight: 480 }, 0, "v") : null;
check("sbsHalfLayout(v): половина на всю ширину, по высоте с зазором",
  !!vLay && vLay.halfW === 600 && vLay.halfH === 159 && vLay.halfCenterX === 300,
  JSON.stringify(vLay));

sbsSt.img1.naturalWidth = 480;
sbsSt.img1.naturalHeight = 640;
DSC.applyMode(sbsNode);
check("SBS портрет 480×640: слева и справа",
  typeof DSC.sbsOrientation === "function" && DSC.sbsOrientation(sbsSt) === "h"
  && sbsDom.a.box.style.width === "calc(50% - 1px)" && sbsDom.a.box.style.height === "100%"
  && sbsDom.b.box.style.left === "calc(50% + 1px)",
  `${sbsDom.a.box.style.width} / ${sbsDom.a.box.style.height} / left=${sbsDom.b.box.style.left}`);
const hLay = DSC.sbsHalfLayout({ x: 0, y: 0, w: 600, h: 320 }, { naturalWidth: 480, naturalHeight: 640 }, 0, "h");
check("sbsHalfLayout(h): половина слева/справа как раньше",
  hLay.halfW === 299 && hLay.halfH === 320 && hLay.halfCenterY === 160, JSON.stringify(hLay));

// ── панорама в Side-by-Side (по задаче): halves двигаются от panX/panY ─────
sbsDom.stage.clientWidth = 600;
sbsDom.stage.clientHeight = 320;
sbsSt.zoom = 2;
sbsSt.panX = 0;
sbsSt.panY = 0;
DSC.applyTransforms(sbsNode);
const sbsT0 = sbsDom.a.scene.style.transform || "";
sbsSt.panX = 40;
sbsSt.panY = 25;
DSC.applyTransforms(sbsNode);
const sbsT1 = sbsDom.a.scene.style.transform || "";
check("SBS: панорама двигает половины (translate зависит от panX/panY)",
  sbsT1 !== sbsT0 && /translate\([^)]*40/.test(sbsT1), `0=${sbsT0} 1=${sbsT1}`);
check("SBS: обе половины сдвигаются вместе",
  /translate\([^)]*40/.test(sbsDom.b.scene.style.transform || ""),
  sbsDom.b.scene.style.transform);

// Средняя кнопка в SBS: два кадра — навигация разрешена, панорама работает.
sbsDom.stage.dispatch("pointerdown", { button: 1, clientX: 300, clientY: 150 });
check("SBS: средняя кнопка начинает панораму", sbsSt.panDrag === true, String(sbsSt.panDrag));
sbsDom.stage.dispatch("pointermove", { button: 1, clientX: 260, clientY: 135, buttons: 4 });
check("SBS: panX изменился при перетаскивании", sbsSt.panX !== 40, String(sbsSt.panX));
sbsDom.stage.dispatch("pointerup", { button: 1, clientX: 260, clientY: 135 });
check("SBS: панорама завершена", sbsSt.panDrag === false);

sbsSt.zoom = 1;
sbsSt.panX = 0;
sbsSt.panY = 0;
DSC.applyTransforms(sbsNode);

// Два кадра для главной ноды: зум/панорама разрешены только в Side-by-Side.
DSC.setSlotImage(node, 1, { filename: "guard_a.png", subfolder: "", type: "output" }, "640×480");
DSC.setSlotImage(node, 2, { filename: "guard_b.png", subfolder: "", type: "temp" }, "640×480");
setMode("Side-by-Side");

// ── Nodes 2.0: capture-предок перехватывает Alt+wheel и среднюю кнопку ──
// В Nodes 2.0 TransformPane вешает @wheel.capture/@pointer*.capture И НАД
// нодой — событие перехватывается раньше, чем доходит до превью. Лечение:
// свои capture-слушатели на ПРЕДКЕ над TransformPane, с проверкой, что
// событие идёт из нашего превью (stage.contains(target)).
check("guard: экспорт canvasGuardEl/bindGuardEvents есть",
  typeof DSC.canvasGuardEl === "function" && typeof DSC.bindGuardEvents === "function",
  `${typeof DSC.canvasGuardEl}/${typeof DSC.bindGuardEvents}`);
const gEl = new FakeEl("div");        // предок над TransformPane (GraphCanvas root)
const tpRoot = new FakeEl("div");     // сам TransformPane (его capture-слушатели обходят)
const nodeEl2 = new FakeEl("div");    // корень LGraphNode с [data-node-id]
tpRoot.appendChild(nodeEl2);
gEl.appendChild(tpRoot);
stage._closest["[data-node-id]"] = nodeEl2;
check("guard: элемент-предок находится по [data-node-id]",
  typeof DSC.canvasGuardEl === "function" && DSC.canvasGuardEl(node) === gEl,
  String(typeof DSC.canvasGuardEl === "function" && DSC.canvasGuardEl(node)));
const guard = typeof DSC.bindGuardEvents === "function" ? DSC.bindGuardEvents(node) : null;
check("guard: слушатели повешены на предка", !!guard && guard.el === gEl,
  guard && guard.el && guard.el.tagName);
st.zoom = 1; st.panX = 0; st.panY = 0;
let gStopped = false;
const gEv = (extra) => Object.assign({
  target: layer1.img, clientX: 300, clientY: 150, pointerId: 5, button: 0, buttons: 0,
  altKey: false, deltaY: 0,
  preventDefault() {},
  stopPropagation() { gStopped = true; },
}, extra);
gEl.dispatch("wheel", gEv({ altKey: true, deltaY: -100 }));
check("2.0: Alt+wheel через предка зумит превью", st.zoom > 1, String(st.zoom));
check("2.0: событие остановлено до TransformPane (граф не зумится вместо превью)",
  gStopped === true);
gStopped = false;
const zBefore = st.zoom;
gEl.dispatch("wheel", gEv({ altKey: false, deltaY: -100 }));
check("2.0: обычный wheel НЕ перехватывается (он для графа)",
  gStopped === false && st.zoom === zBefore, `${gStopped}/${st.zoom}`);
gStopped = false;
gEl.dispatch("wheel", gEv({ altKey: true, deltaY: -100, target: gEl }));
check("2.0: wheel мимо превью не трогает наш зум",
  gStopped === false && st.zoom === zBefore, `${gStopped}/${st.zoom}`);
gEl.dispatch("pointerdown", gEv({ button: 1 }));
check("2.0: средняя кнопка при зуме начинает панораму", st.panDrag === true);
gEl.dispatch("pointermove", gEv({ buttons: 4, clientX: 280, clientY: 140 }));
check("2.0: панорама двигает кадр", st.panX !== 0 || st.panY !== 0,
  `${st.panX}/${st.panY}`);
gEl.dispatch("pointerup", gEv({ button: 1 }));
check("2.0: панорама завершена", st.panDrag === false);

// В Slider (даже с двумя кадрами) навигация закрыта — только Side-by-Side.
setMode("Slider");
gStopped = false;
const zSliderGuard = st.zoom;
gEl.dispatch("wheel", gEv({ altKey: true, deltaY: -100 }));
check("2.0: в режиме Slider wheel не перехватывается (навигация только в SBS)",
  gStopped === false && st.zoom === zSliderGuard, `${gStopped}/${st.zoom}`);
gEl.dispatch("pointerdown", gEv({ button: 1 }));
check("2.0: в режиме Slider средняя кнопка не начинает панораму",
  st.panDrag === false, String(st.panDrag));
st.panDrag = false;

// Без сравнения двух кадров (режим Off) навигация закрыта: событие уходит графу.
setMode("Off");
gStopped = false;
const zOff = st.zoom;
gEl.dispatch("wheel", gEv({ altKey: true, deltaY: -100 }));
check("2.0: в режиме Off wheel не перехватывается (нет сравнения двух кадров)",
  gStopped === false && st.zoom === zOff, `${gStopped}/${st.zoom}`);
gEl.dispatch("pointerdown", gEv({ button: 1 }));
check("2.0: в режиме Off средняя кнопка не начинает панораму",
  st.panDrag === false, String(st.panDrag));
st.panDrag = false;   // старый код мог оставить panDrag=true (не тиражировать)
setMode("Slider");
stage._closest["[data-node-id]"] = null;
st.zoom = 1; st.panX = 0; st.panY = 0;

// ── живое переключение legacy → Nodes 2.0 (без перезагрузки браузера) ─────
// Нода создана в legacy: у stage нет предка [data-node-id] → canvasGuardEl
// возвращает null и guard не привязан. При живом включении Nodes 2.0 stage
// переезжает под LGraphNode, TransformPane начинает перехватывать wheel в
// capture-фазе, а bindGuardEvents никто не вызывает повторно — до фикса
// Alt+wheel мёртв до перезагрузки браузера/смены воркфлоу. Перепривязка —
// ensureGuard на событиях, которые доходят до stage в обоих режимах.
setMode("Side-by-Side");
if (guard && typeof guard.dispose === "function") guard.dispose();
check("живое переключение: до переключения (legacy) guard не привязан",
  st.guard == null, String(st.guard && st.guard.el && st.guard.el.tagName));
stage._closest["[data-node-id]"] = null;

// переключение включено: элемент переехал под LGraphNode [data-node-id]
stage._closest["[data-node-id]"] = nodeEl2;

// A) pointerenter доходит до stage → guard перепривязывается
stage.dispatch("pointerenter");
check("после переключения: pointerenter перепривязывает guard",
  !!st.guard && st.guard.el === gEl,
  st.guard ? String(st.guard.el && st.guard.el.tagName) : "null");
gStopped = false;
st.zoom = 1; st.panX = 0; st.panY = 0;
gEl.dispatch("wheel", gEv({ altKey: true, deltaY: -100 }));
check("после переключения: Alt+wheel через предок зумит превью",
  st.zoom > 1, String(st.zoom));
check("после переключения: событие остановлено до графа", gStopped === true);
const liveGuard = st.guard;
stage.dispatch("pointerenter");
check("повторный pointerenter не плодит привязку", st.guard === liveGuard);

// B) только pointermove (без enter) тоже перепривязывает
if (liveGuard && typeof liveGuard.dispose === "function") liveGuard.dispose();
check("guard снят перед сценарием B", st.guard == null, String(st.guard));
stage.dispatch("pointermove", { clientX: 10, clientY: 10 });
check("после переключения: pointermove перепривязывает guard",
  !!st.guard && st.guard.el === gEl,
  st.guard ? String(st.guard.el && st.guard.el.tagName) : "null");

// C) только pointerdown (без enter/move) тоже перепривязывает
if (st.guard && typeof st.guard.dispose === "function") st.guard.dispose();
check("guard снят перед сценарием C", st.guard == null, String(st.guard));
stage.dispatch("pointerdown", { button: 0 });
check("после переключения: pointerdown перепривязывает guard",
  !!st.guard && st.guard.el === gEl,
  st.guard ? String(st.guard.el && st.guard.el.tagName) : "null");

// возврат состояния: legacy (предок снова недоступен)
stage._closest["[data-node-id]"] = null;
st.zoom = 1; st.panX = 0; st.panY = 0;

// ── шторка: следует за курсором без drag-состояния (как стандартная нода) ──
setMode("Slider");
stage._rectLeft = 100;
stage._rectTop = 50;
stage.dispatch("pointermove", { clientX: 100 + 600 * 0.25, clientY: 200 });
check("шторка: hover четверть ширины → 0.25", Math.abs(st.sliderPos - 0.25) < 0.01, String(st.sliderPos));
check("шторка: clip-path пересчитан", layer1.box.style.clipPath === "inset(0 75% 0 0)", layer1.box.style.clipPath);
stage.dispatch("pointermove", { clientX: 100 + 600 * 0.9, clientY: 200 });
check("шторка: hover 90% ширины → 0.9", Math.abs(st.sliderPos - 0.9) < 0.01, String(st.sliderPos));
check("шторка: линия переехала", lineEl.style.left === "90%", lineEl.style.left);
stage.dispatch("pointermove", { clientX: 9999, clientY: 200 });
check("шторка: позиция зажата в 0..1", st.sliderPos === 1, String(st.sliderPos));
stage.dispatch("pointerdown", { button: 0, clientX: 100 + 600 * 0.5, clientY: 200 });
// T-fix: поле sliderDrag было write-only (запись/сброс, ноль чтений в js) —
// контракт задачи: удалить поле И эти проверки жизненного цикла.
check("T-fix: флаг sliderDrag удалён из стейта (был write-only, чтений нет)",
  !("sliderDrag" in st), "sliderDrag" in st ? "остался" : "нет");
stage.dispatch("pointerup", { button: 0, clientX: 400, clientY: 200 });
check("шторка: середину можно выставить", Math.abs(st.sliderPos - 0.5) < 0.01, String(st.sliderPos));

// ── зум / панорама / сброс (в Side-by-Side — навигация разрешена) ─────────
setMode("Side-by-Side");
st.zoom = 1;
mainCanvasEl.lastDispatched = null;
stage.dispatch("wheel", { altKey: true, deltaY: -100, clientX: 400, clientY: 200 });
check("zoomAt: Alt+колесо увеличивает зум", st.zoom > 1.0, String(st.zoom));
check("п.1: alt+wheel при разрешённой навигации НЕ форвардится (зум ноды)",
  mainCanvasEl.lastDispatched === null,
  String(mainCanvasEl.lastDispatched && mainCanvasEl.lastDispatched.type));
check("zoomAt: transform применён к сцене", /scale\(/.test(layer1.scene.style.transform || ""), layer1.scene.style.transform);
check("п.4: в SBS зум двигает ОБЕ сцены одним трансформом (одинаковый scale)", (() => {
  const s1 = ((layer1.scene.style.transform || "").match(/scale\(([\d.]+)\)/) || [])[1];
  const s2 = ((layer2.scene.style.transform || "").match(/scale\(([\d.]+)\)/) || [])[1];
  return !!s1 && s1 === s2 && parseFloat(s1) > 1;
})(), `a=${layer1.scene.style.transform} b=${layer2.scene.style.transform}`);
for (let i = 0; i < 60; i++) stage.dispatch("wheel", { altKey: true, deltaY: -100, clientX: 400, clientY: 200 });
check("zoomAt: потолок 10x", st.zoom === 10, String(st.zoom));
for (let i = 0; i < 80; i++) stage.dispatch("wheel", { altKey: true, deltaY: 100, clientX: 400, clientY: 200 });
check("zoomAt: пол 1x", st.zoom === 1, String(st.zoom));
check("zoomAt: без Alt колесо не перехватывается (зум графа) и форвардится в граф", (() => {
  mainCanvasEl.lastDispatched = null;
  const before = mainCanvasEl.dispatchCount;
  let origPrevented = false;
  let origStopped = false;
  stage.dispatch("wheel", {
    altKey: false, deltaY: -100, clientX: 400, clientY: 200,
    preventDefault() { origPrevented = true; },
    stopPropagation() { origStopped = true; },
  });
  const ev = mainCanvasEl.lastDispatched;
  return st.zoom === 1
    && mainCanvasEl.dispatchCount > before
    && !!ev && ev.type === "wheel" && ev.deltaY === -100
    && origPrevented && origStopped;
})(), `zoom=${st.zoom} fwd=${mainCanvasEl.dispatchCount} last=${mainCanvasEl.lastDispatched && mainCanvasEl.lastDispatched.type}`);

st.zoom = 2;
st.panX = 0;
st.panY = 0;
stage.dispatch("pointerdown", { button: 1, clientX: 400, clientY: 200 });
check("панорама: средняя кнопка начинает drag", st.panDrag === true);
stage.dispatch("pointermove", { button: 1, clientX: 380, clientY: 190, buttons: 4 });
check("панорама: panX изменился", st.panX !== 0, String(st.panX));
stage.dispatch("pointerup", { button: 1, clientX: 380, clientY: 190 });
check("панорама: drag завершён", st.panDrag === false);
st.zoom = 1;
stage.dispatch("pointerdown", { button: 1, clientX: 400, clientY: 200 });
check("панорама: при зуме 1 не начинается", st.panDrag === false);
stage.dispatch("dblclick", { clientX: 400, clientY: 200 });
check("двойной клик: сброс зума и панорамы", st.zoom === 1 && st.panX === 0 && st.panY === 0);
check("clampPan: при зуме 1 панорама обнуляется",
  (() => { st.panX = 40; st.panY = 40; DSC.clampPan(st, { x: 0, y: 0, w: 600, h: 320 }); return st.panX === 0 && st.panY === 0; })());

// ── T-COORD: два бага zoomAt, невидимых при scale=1 и при зуме из >1 ──────
// A) порядок: clampPan вызывается ДО st.zoom = newZoom → при зуме из 1.0
//    кламп видит zoom<=1 и обнуляет только что вычисленную панораму
//    (первый Alt+wheel курсором не в центре обязан сдвигать кадр к курсору).
setMode("Slider");
st.zoom = 1; st.panX = 0; st.panY = 0;
// курсор слева от центра: left=100 → clientX=250, localX=150, mouseRel=−150
// ожидаемая панорама: (0 − (−150)) × 1.15 + (−150) = 22.5 (кламп ±45 не режет)
DSC.zoomAt(node, 100 + 150, 50 + 160, -100);
check("T-COORD-A: зум из 1.0 курсором не в центре — панорама сдвигается к курсору (clampPan после присвоения zoom)",
  Math.abs(st.panX - 22.5) < 0.2, `panX=${st.panX}`);
// B) приведение экранных координат к локальным при зуме графа ×2:
//    в центре ЭКРАННОЙ области локальный центр — не середина локального rect
const rectOwnedBefore = Object.prototype.hasOwnProperty.call(stage, "getBoundingClientRect");
stage.getBoundingClientRect = function () {
  const r = FakeEl.prototype.getBoundingClientRect.call(stage);
  return { left: r.left, top: r.top, width: r.width * 2, height: r.height * 2 };
};
st.zoom = 2; st.panX = 0; st.panY = 0;
// курсор в центре ЭКРАННОЙ области: left=100, width=1200 → 700; top=50, height=640 → 370
DSC.zoomAt(node, 100 + 600, 50 + 320, -100);
check("T-COORD-B: zoomAt при зуме графа ×2 — курсор в центре не сдвигает панораму",
  Math.abs(st.panX) < 0.5 && Math.abs(st.panY) < 0.5, `pan=(${st.panX},${st.panY})`);
setMode("Side-by-Side");
st.zoom = 2; st.panX = 0; st.panY = 0;
stage.dispatch("pointerdown", { button: 1, clientX: 400, clientY: 300 });
stage.dispatch("pointermove", { button: 1, clientX: 360, clientY: 300, buttons: 4 });
check("T-COORD: панорама при зуме графа ×2 делит дельту на масштаб (Δ−40 → −20)",
  Math.abs(st.panX - (-20)) < 0.5, `panX=${st.panX}`);
stage.dispatch("pointerup", { button: 1, clientX: 360, clientY: 300 });
if (rectOwnedBefore) stage.getBoundingClientRect = FakeEl.prototype.getBoundingClientRect;
else delete stage.getBoundingClientRect;
st.zoom = 1; st.panX = 0; st.panY = 0;
setMode("Side-by-Side");

// ── навигация только в Side-by-Side при двух видимых кадрах (по задаче) ───
const nav = (n) => (typeof DSC.navEnabled === "function" ? DSC.navEnabled(n) : "missing");
check("navEnabled экспортирована", typeof DSC.navEnabled === "function", typeof DSC.navEnabled);
check("Side-by-Side + два кадра: навигация разрешена", nav(node) === true, String(nav(node)));
setMode("Off");
st.zoom = 1;
st.panX = 0;
st.panY = 0;
mainCanvasEl.lastDispatched = null;
const fwdOff0 = mainCanvasEl.dispatchCount;
stage.dispatch("wheel", { altKey: true, deltaY: -100, clientX: 400, clientY: 200 });
check("Off: Alt+wheel не зумит (отображается одно изображение)",
  st.zoom === 1, String(st.zoom));
check("п.1: Off — Alt+wheel уходит синтетическим событием на канву графа",
  mainCanvasEl.dispatchCount > fwdOff0
  && !!mainCanvasEl.lastDispatched && mainCanvasEl.lastDispatched.type === "wheel"
  && mainCanvasEl.lastDispatched.deltaY === -100,
  `count=${mainCanvasEl.dispatchCount - fwdOff0}`);
st.zoom = 2;
stage.dispatch("pointerdown", { button: 1, clientX: 400, clientY: 200 });
check("Off: средняя кнопка не начинает панораму",
  st.panDrag === false, String(st.panDrag));
st.panDrag = false;
st.zoom = 1;
check("Off: navEnabled false", nav(node) === false, String(nav(node)));
setMode("Side-by-Side");
DSC.setSliderView(node, "img1");
check("SBS вид Image 1 (одиночный): навигация отключена", nav(node) === false, String(nav(node)));
st.zoom = 1;
mainCanvasEl.lastDispatched = null;
const fwdSolo0 = mainCanvasEl.dispatchCount;
stage.dispatch("wheel", { altKey: true, deltaY: -100, clientX: 400, clientY: 200 });
check("SBS вид Image 1: Alt+wheel не зумит", st.zoom === 1, String(st.zoom));
check("п.1: SBS вид Image 1 — Alt+wheel форвардится графу",
  mainCanvasEl.dispatchCount > fwdSolo0
  && !!mainCanvasEl.lastDispatched && mainCanvasEl.lastDispatched.type === "wheel",
  `count=${mainCanvasEl.dispatchCount - fwdSolo0}`);
check("п.3: setSliderView('grid') — старое значение уходит в fallback «пара»", (() => {
  DSC.setSliderView(node, "grid");
  return st.sliderView === "split";
})(), String(st.sliderView));
check("SBS вид Пара: два кадра — навигация разрешена", nav(node) === true, String(nav(node)));
DSC.setSliderView(node, "split");
// В режиме Slider с двумя кадрами навигации больше нет — только Side-by-Side.
setMode("Slider");
check("Slider + два кадра: navEnabled false (навигация только в SBS)",
  nav(node) === false, String(nav(node)));
st.zoom = 1;
mainCanvasEl.lastDispatched = null;
const fwdSlider0 = mainCanvasEl.dispatchCount;
stage.dispatch("wheel", { altKey: true, deltaY: -100, clientX: 400, clientY: 200 });
check("Slider: Alt+wheel не зумит", st.zoom === 1, String(st.zoom));
check("п.1: Slider — Alt+wheel форвардится графу",
  mainCanvasEl.dispatchCount > fwdSlider0
  && !!mainCanvasEl.lastDispatched && mainCanvasEl.lastDispatched.type === "wheel",
  `count=${mainCanvasEl.dispatchCount - fwdSlider0}`);
setMode("Side-by-Side");

// Без подключённых картинок навигации нет — сравнивать нечего.
const navNode = makeNode();
protoHolder.onNodeCreated.call(navNode);
rafQueue.forEach((f) => f());
rafQueue = [];
const navSt = DSC.ensureState(navNode);
mainCanvasEl.lastDispatched = null;
const fwdNoImg0 = mainCanvasEl.dispatchCount;
navSt.dom.stage.dispatch("wheel", { altKey: true, deltaY: -100, clientX: 100, clientY: 100 });
check("без картинок: Alt+wheel не зумит", navSt.zoom === 1, String(navSt.zoom));
check("п.1: без картинок — Alt+wheel форвардится графу",
  mainCanvasEl.dispatchCount > fwdNoImg0
  && !!mainCanvasEl.lastDispatched && mainCanvasEl.lastDispatched.type === "wheel",
  `count=${mainCanvasEl.dispatchCount - fwdNoImg0}`);
check("без картинок: navEnabled false", nav(navNode) === false, String(nav(navNode)));

// ── подсказка: DOM-узел, гасится по mouseleave ────────────────────────────
helpBtn.dispatch("mouseenter", {});
check("подсказка: показана по наведению на «?»", helpBox.style.display === "block");
check("подсказка: содержит режимы и зум", /Slider/.test(helpBox.textContent || "") || helpBox.children.length > 0);
check("п.3: HELP в SBS — виды «Pair/1/2» (EN), без «Шторка/Сетка»", (() => {
  const modeItem = (DSC.HELP || []).find((h) => h.name === "mode") || { lines: [] };
  const sbsLine = (modeItem.lines || []).find((l) => l.indexOf("Side-by-Side") === 0) || "";
  return sbsLine !== "" && /Pair/.test(sbsLine) && !/Шторка|Сетка/.test(sbsLine);
})(), JSON.stringify(((DSC.HELP || []).find((h) => h.name === "mode") || { lines: [] }).lines));
helpBtn.dispatch("mouseleave", {});
check("подсказка: спрятана по уходу курсора (не залипает)", helpBox.style.display === "none");
helpBtn.dispatch("mouseenter", {});
stage.dispatch("pointerdown", { button: 0, clientX: 400, clientY: 200 });
check("подсказка: спрятана при клике по холсту", helpBox.style.display === "none");
check("подсказка: нет canvas-тултипов и hover по строкам виджетов",
  DSC.onPreviewHover === undefined && DSC.setTooltip === undefined && DSC.drawTooltip === undefined);

// ── ⭐ битая картинка: 404 не роняет отрисовку ────────────────────────────
const brokenNode = makeNode();
protoHolder.onNodeCreated.call(brokenNode);
rafQueue.forEach((f) => f());
rafQueue = [];
const bst = DSC.ensureState(brokenNode);
const bLayerA = (bst.dom && bst.dom.a && bst.dom.a.img) || new FakeImg();
let brokenErr = null;
try {
  DSC.setSlotImage(brokenNode, 1, { filename: "missing_a.png", subfolder: "", type: "temp" }, "");
} catch (e) { brokenErr = e; }
check("битая картинка: setSlotImage не падает", !brokenErr, brokenErr && brokenErr.message);
check("битая картинка: слот обнулён, метаданные сброшены",
  bst.img1 === null && bst.meta1 === null, JSON.stringify({ img: !!bst.img1, meta: bst.meta1 }));
check("битая картинка: слой скрыт (не рисуется «сломанный» элемент)",
  bLayerA.style.display === "none", bLayerA.style.display);
// ── слоты картинок в DOM-слои (goodNode) ─────────────────────────────────
const goodNode = makeNode();
protoHolder.onNodeCreated.call(goodNode);
rafQueue.forEach((f) => f());
rafQueue = [];
const gst = DSC.ensureState(goodNode);
const gdom = gst.dom || { a: { img: new FakeImg() }, b: { img: new FakeImg() }, dim1: new FakeEl("div"), hint: { style: {} } };
DSC.setSlotImage(goodNode, 1, { filename: "a.png", subfolder: "", type: "output" }, "640×480");
DSC.setSlotImage(goodNode, 2, { filename: "b.png", subfolder: "", type: "temp" }, "640×480");
check("слоты: img-элементы поставлены в DOM-слои",
  gst.img1 === gdom.a.img && gst.img2 === gdom.b.img);
check("слоты: src ведёт на /view", (gst.img1.src || "").indexOf("/view?filename=a.png") > 0, gst.img1.src);
check("слоты: подпись размеров в DOM", gdom.dim1.textContent === "640×480", gdom.dim1.textContent);
check("слоты: подсказка-заглушка скрыта при наличии картинки", gdom.hint.style.display === "none");
// ── ⭐ персистентность при переключении воркфлоу ──────────────────────────
const msg = {
  degg_compare_images: [
    { filename: "run_00001_.png", subfolder: "", type: "output", slot: 1, width: 512, height: 768 },
    { filename: "_deggcmp2_ab_00001_.png", subfolder: "", type: "temp", slot: 2, width: 512, height: 768 },
  ],
  degg_open_path: ["D:/ComfyUI/output/run_00001_.png"],
};
protoHolder.onExecuted.call(node, msg);
check("onExecuted: слот 1 загружен", !!st.img1 && st.meta1.filename === "run_00001_.png");
check("onExecuted: слот 2 загружен", !!st.img2 && st.meta2.filename === "_deggcmp2_ab_00001_.png");
check("onExecuted: размеры подписаны", st.dim1 === "512×768" && st.dim2 === "512×768");
check("onExecuted: путь для кнопки открытия сохранён", node._dscOpenPath === msg.degg_open_path[0]);
check("onExecuted: кнопка открытия активна (Open in Viewer)",
  DSC.getWidget(node, DSC.OPEN_BTN).label === "Open in Viewer",
  DSC.getWidget(node, DSC.OPEN_BTN).label);
check("onExecuted: метаданные записаны в properties",
  node.properties.dsc_meta && node.properties.dsc_meta["1"].filename === "run_00001_.png"
  && node.properties.dsc_meta["2"].type === "temp");
check("onExecuted: путь записан в properties", node.properties.dsc_open_path === msg.degg_open_path[0]);
check("onExecuted: url картинки ведёт на /view", st.img1.src.indexOf("/view?filename=run_00001_.png") > 0, st.img1.src);

// ── T-fix: onExecuted принимает ТОЛЬКО свои ключи (images — мёртвый фолбэк) ─
protoHolder.onExecuted.call(node, {
  images: [{ slot: 1, filename: "foreign.png", subfolder: "", type: "output", width: 9, height: 9 }],
});
check("T-fix: чужой ключ images НЕ подхватывается (Python шлёт degg_compare_images)",
  st.meta1 && st.meta1.filename === "run_00001_.png", st.meta1 && st.meta1.filename);

// ── T-fix: пустая строка пути ОЧИЩАЕТ _dscOpenPath, а не держит старый ──────
protoHolder.onExecuted.call(node, {
  degg_compare_images: [
    { slot: 1, filename: "run_00001_.png", subfolder: "", type: "output", width: 512, height: 768 },
    { slot: 2, filename: "_deggcmp2_ab_00001_.png", subfolder: "", type: "temp", width: 512, height: 768 },
  ],
  degg_open_path: [""],
});
check("T-fix: пустой путь в degg_open_path очищает _dscOpenPath",
  node._dscOpenPath === "", JSON.stringify(node._dscOpenPath));
// вернуть состояние для следующих проверок (node2 копирует properties)
node._dscOpenPath = msg.degg_open_path[0];
DSC.persistImages(node);
DSC.refreshLabels(node);

// ── T-fix: в Off показывается только Image 1 — без неё заглушка видна ──────
const prevModeFix = DSC.currentMode(node);
setMode("Off");
const keepImg1 = st.img1;
st.img1 = null;
DSC.refreshLabels(node);
check("T-fix: Off + нет Image 1 + есть Image 2 → подсказка-заглушка видна",
  st.dom.hint.style.display === "block", st.dom.hint.style.display);
st.img1 = keepImg1;
DSC.refreshLabels(node);
setMode(prevModeFix);

// ── T-fix: выход из Side-by-Side сбрасывает зум/панораму/фокус (вариант А) ──
// В SBS зум/пан доступны через Alt+wheel/среднюю кнопку (navEnabled).
// В других режимах navEnabled=false, но sharedTransform применяет zoom/pan
// — без сброса зум «залипает» и не сбросить (гейт закрыт).
setMode("Side-by-Side");
st.zoom = 2; st.panX = 50; st.panY = -30; st.sbsFocusU = 0.2; st.sbsFocusV = 0.8;
setMode("Slider");
check("T-fix: выход из SBS сбрасывает зум/панораму/фокус",
  st.zoom === 1 && st.panX === 0 && st.panY === 0 &&
  st.sbsFocusU === 0.5 && st.sbsFocusV === 0.5,
  `z=${st.zoom} pan=(${st.panX},${st.panY}) f=(${st.sbsFocusU},${st.sbsFocusV})`);

// Страховка: при вызове applyMode в SBS (смены вида/виджетов) зум НЕ сбрасывается.
st.zoom = 1.5; st.panX = 10;
setMode("Side-by-Side");
check("T-fix: повторный applyMode в SBS сохраняет зум/панораму",
  st.zoom === 1.5 && st.panX === 10,
  `z=${st.zoom} panX=${st.panX}`);

// Смена воркфлоу: нода пересоздаётся из JSON (properties сериализуются),
// onExecuted НЕ вызывается — картинки обязаны вернуться из properties.
const node2 = makeNode();
node2.properties = JSON.parse(JSON.stringify(node.properties));
protoHolder.onNodeCreated.call(node2);
rafQueue.forEach((f) => f());
rafQueue = [];
protoHolder.onConfigure.call(node2);
const st2 = DSC.ensureState(node2);
check("после переключения воркфлоу слот 1 восстановлен", !!st2.img1 && st2.meta1.filename === "run_00001_.png");
check("после переключения воркфлоу слот 2 восстановлен", !!st2.img2 && st2.meta2.type === "temp");
check("после переключения воркфлоу размеры восстановлены", st2.dim1 === "512×768");
const st2img = (st2.dom && st2.dom.a && st2.dom.a.img) || new FakeImg();
check("после переключения воркфлоу картинка в DOM-слое видима",
  st2img.style.display === "" && (st2img.src || "").indexOf("run_00001_.png") > 0,
  st2img.src);
check("после переключения воркфлоу кнопка открытия активна (Open in Viewer)",
  DSC.getWidget(node2, DSC.OPEN_BTN).label === "Open in Viewer",
  DSC.getWidget(node2, DSC.OPEN_BTN).label);

// Битый файл (temp очищен после перезапуска) → слот обнуляется, а не «висит»
const node3 = makeNode();
node3.properties = { dsc_meta: { 1: { filename: "missing.png", subfolder: "", type: "temp" }, 2: null } };
protoHolder.onNodeCreated.call(node3);
protoHolder.onConfigure.call(node3);
const st3 = DSC.ensureState(node3);
check("отсутствующий файл не оставляет битое изображение", st3.img1 === null && st3.meta1 === null);
check("отсутствующий файл: слой скрыт",
  ((st3.dom && st3.dom.a && st3.dom.a.img) || { style: {} }).style.display === "none");

// ── задачи 1/3/4: красные проверки (до правки) ────────────────────────────
check("T1: кнопка «Сохранить текущий вид» удалена",
  DSC.SAVE_BTN === undefined && !DSC.getWidget(node, "save_current_view"));
check("T1: saveCurrentView/captureComposite/drawComposite удалены",
  typeof DSC.saveCurrentView === "undefined"
  && typeof DSC.captureComposite === "undefined"
  && typeof DSC.drawComposite === "undefined");
check("T1: JS-роуты сохранения (SAVE_URI/BLINK_URI) удалены",
  DSC.SAVE_URI === undefined && DSC.BLINK_URI === undefined);
check("T1: HELP без записи save_btn «Сохранить текущий вид»",
  !(DSC.HELP || []).some((h) => h.name === "save_btn"));

setMode("Off");
check("T3: Off — opacity погашен (w.disabled)", DSC.getWidget(node, "opacity").disabled === true);
check("T3: Off — blink_speed погашен (w.disabled)", DSC.getWidget(node, "blink_speed").disabled === true);
setMode("Slider");
check("T3: выход из Off — слайдеры снова активны",
  DSC.getWidget(node, "opacity").disabled === false
  && DSC.getWidget(node, "blink_speed").disabled === false);

check("T4: отступ кнопок вида от изображения ≥ 4px", (DSC.DIM_BAR_H - 16) / 2 >= 4,
  `DIM_BAR_H=${DSC.DIM_BAR_H}`);

// ── удаление ноды ─────────────────────────────────────────────────────────
protoHolder.onRemoved.call(node);
check("onRemoved: состояние очищено", node._cmp === undefined);

// ── metaUrl / роуты ───────────────────────────────────────────────────────
const url = DSC.metaUrl({ filename: "a b.png", subfolder: "sub", type: "output" });
check("metaUrl: кодирует имя и subfolder",
  url === "http://127.0.0.1:8188/view?filename=a%20b.png&subfolder=sub&type=output", url);
check("metaUrl: без filename → пустая строка", DSC.metaUrl(null) === "");
check("роуты: OPEN_URI совпадает с Python",
  DSC.OPEN_URI === "/degg_images_save_compare/open_file", DSC.OPEN_URI);


// ── локализация: RU только при русском интерфейсе ComfyUI, иначе EN ───────
check("локализация: без настроек ComfyUI язык — английский (не RU)",
  typeof DSC.isRu === "function" && DSC.isRu() === false,
  String(DSC.isRu && DSC.isRu()));
check("локализация: заголовки видов по умолчанию EN",
  typeof DSC.viewItems === "function"
  && DSC.viewItems().map((i) => i.title).join("|") === "Pair|Image 1|Image 2",
  JSON.stringify(DSC.viewItems && DSC.viewItems()));
check("локализация: RU-строки при override ru (виды + подписи кнопки)", (() => {
  if (typeof DSC.setLocaleOverride !== "function") return false;
  DSC.setLocaleOverride("ru");
  return DSC.isRu() === true
    && DSC.openLabelEmpty() === "Нет изображения"
    && DSC.openLabelReady() === "Открыть в просмотрщике"
    && DSC.viewItems().map((i) => i.title).join("|") === "Пара|Изображение 1|Изображение 2";
})(), JSON.stringify(DSC.viewItems && DSC.viewItems()));
check("локализация: справка на русском при override ru", (() => {
  const items = DSC.helpItems ? DSC.helpItems() : [];
  const modeItem = items.find((h) => h.name === "mode") || { lines: [] };
  const sbs = (modeItem.lines || []).find((l) => l.indexOf("Side-by-Side") === 0) || "";
  return /Пара/.test(sbs);
})(), String((DSC.helpItems ? DSC.helpItems() : []).length));
check("локализация: подсказка на русском при override ru",
  typeof DSC.hintText === "function" && /Подключите/.test(DSC.hintText()),
  String(DSC.hintText && DSC.hintText()));
check("локализация: значения combo MODES НЕ переводятся",
  Array.isArray(DSC.MODES)
  && DSC.MODES.join(",") === "Off,Slider,Side-by-Side,Overlap,Difference,Blink"
  && DSC.MODES.every((m) => !/[\u0400-\u04FF]/.test(m)), JSON.stringify(DSC.MODES));
// ⭐ Подписи combo: RU-подписи отдаёт getOptionLabel, а options.values
// (протокол) остаются нетронутыми. Подмена values — ровно тот дефект, что
// убивал превью: currentMode() делал MODES.indexOf(...) < 0 -> "Off" и ни одна
// ветка applyMode не срабатывала.
const modeW = DSC.getWidget(node, "mode");
const optLabel = modeW && modeW.options ? modeW.options.getOptionLabel : null;
check("локализация: combo отдаёт RU-подписи режимов через getOptionLabel",
  typeof optLabel === "function"
  && optLabel("Off") === "Выкл." && optLabel("Slider") === "Шторка"
  && optLabel("Side-by-Side") === "Сбоку" && optLabel("Overlap") === "Наложение"
  && optLabel("Difference") === "Разница" && optLabel("Blink") === "Мигание",
  optLabel ? String(optLabel("Slider")) : "нет getOptionLabel");
check("локализация: getOptionLabel не тронул options.values (протокольные значения)",
  !!(modeW && modeW.options && Array.isArray(modeW.options.values)
    && modeW.options.values.join(",") === DSC.MODES.join(",")),
  JSON.stringify(modeW && modeW.options && modeW.options.values));
check("локализация: currentMode() под RU возвращает настоящий режим", (() => {
  if (typeof DSC.currentMode !== "function" || !modeW) return false;
  const ok = DSC.MODES.map((m) => {
    modeW.value = m;
    return DSC.currentMode(node) === m;
  });
  modeW.value = "Off";
  return ok.every(Boolean);
})(), String(DSC.currentMode && DSC.currentMode(node)));
check("локализация: подпись режима не затирает значение виджета", (() => {
  if (typeof optLabel !== "function" || !modeW) return false;
  modeW.value = "Slider";
  optLabel("Slider");
  const ok = modeW.value === "Slider";
  modeW.value = "Off";
  return ok;
})());
check("локализация: подписи режимов — EN при не-русском языке", (() => {
  if (typeof optLabel !== "function" || typeof DSC.setLocaleOverride !== "function") return false;
  DSC.setLocaleOverride("en");
  const en = optLabel("Slider") === "Slider" && optLabel("Off") === "Off";
  DSC.setLocaleOverride("ru"); // дальше по блоку ожидается RU
  return en;
})(), optLabel ? String(optLabel("Slider")) : "нет getOptionLabel");

check("локализация: возврат к EN после сброса override", (() => {
  if (typeof DSC.setLocaleOverride !== "function") return false;
  DSC.setLocaleOverride(null);
  return DSC.isRu() === false && DSC.openLabelEmpty() === "No image";
})());

console.log("");
console.log(`ok: ${oks.length}   FAIL: ${errors.length}`);
if (errors.length) {
  errors.forEach((e) => console.log("  - " + e));
  console.log("SMOKE FAILED");
  process.exit(1);
}
console.log("SMOKE OK");
