import * as pdfjsLib from "./lib/pdf.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("./lib/pdf.worker.mjs", import.meta.url).href;

// requestAnimationFrame never fires in hidden documents, which stalls PDF.js
// page rendering when the tab loads in the background. Fall back to timeouts.
{
  const nativeRAF = window.requestAnimationFrame.bind(window);
  const nativeCancel = window.cancelAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) =>
    document.hidden ? setTimeout(() => cb(performance.now()), 16) : nativeRAF(cb);
  window.cancelAnimationFrame = (id) => { nativeCancel(id); clearTimeout(id); };
}

window.addEventListener("unhandledrejection", (e) =>
  console.error("Unhandled rejection:", e.reason)
);

const $ = (id) => document.getElementById(id);
const els = {
  pages: $("pages"), container: $("viewerContainer"), notice: $("notice"),
  noticeText: $("noticeText"), docTitle: $("docTitle"), pageInfo: $("pageInfo"),
  pageInput: $("pageInput"), pageCount: $("pageCount"), indexingNote: $("indexingNote"),
  zoomLabel: $("zoomLabel"), filePicker: $("filePicker"),
  rsvp: $("rsvp"), rsvpHeader: $("rsvpHeader"), rsvpWord: $("rsvpWord"),
  wPre: $("wPre"), wPivot: $("wPivot"), wPost: $("wPost"),
  rsvpCounter: $("rsvpCounter"), rsvpEta: $("rsvpEta"), rsvpStage: $("rsvpStage"),
  progress: $("rsvpProgress"), progressFill: $("rsvpProgressFill"),
  btnPlay: $("btnPlay"), wpmInput: $("wpmInput"),
  btnRsvp: $("btnRsvp"),
};

// The horizontal anchor of the ORP (optimal recognition point) inside the stage,
// as a fraction of the stage width. Must match --orp-x in app.css.
const ORP_X = 0.35;

// ---------- State ----------

let pdfDoc = null;
let docGen = 0;           // bumped on every open; stale async work checks it
let pageObjs = [];        // resolved PDFPageProxy objects
let pageDims = [];        // [{w, h}] at scale 1
let pageTextCache = [];   // per page: TextContent from getTextContent
let pageWordRanges = [];  // per page: per text item: [{start, len, wi}]
let pageViews = [];       // [{div, pageNum, rendered, rendering}]
let observer = null;
let extractedPages = 0;   // background text indexing progress
let extractionDone = false;
let pendingTok = null;    // streaming word-merge state
let restoreWordTarget = null;

let scale = 1;
let fitWidth = true;

let words = [];           // [{text, page, segments: [{page, item, start, len}]}]
let paceCum = [0];        // cumulative pacing weights, for the ETA
let sentenceStart = [];   // word indices that begin a sentence
let wordEls = [];         // word index -> spans in the text layer (rendered pages only)
let current = -1;
let currentEls = [];
let playing = false;
let timer = null;
let wpm = 350;

// ---------- Recent files & reading positions (IndexedDB) ----------
// Local files are remembered as FileSystemFileHandles (Chrome), which can be
// stored and reopened later; URL-opened PDFs are remembered by URL. Each
// record also keeps the last reading position.

let currentDocRec = null;
let posSaveTimer = null;
let dbPromise = null;

function idbOpen() {
  dbPromise ||= new Promise((resolve, reject) => {
    const req = indexedDB.open("pdf-rsvp-reader", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("recent", { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function idbOp(mode, fn) {
  try {
    const database = await idbOpen();
    return await new Promise((resolve, reject) => {
      const tx = database.transaction("recent", mode);
      const req = fn(tx.objectStore("recent"));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn("Recent-files storage unavailable:", err);
    return undefined;
  }
}

const recentGet = (id) => idbOp("readonly", (s) => s.get(id));
const recentAll = () => idbOp("readonly", (s) => s.getAll());
const recentPut = (rec) => idbOp("readwrite", (s) => s.put(rec));
const recentDelete = (id) => idbOp("readwrite", (s) => s.delete(id));

function schedulePositionSave() {
  if (!currentDocRec) return;
  clearTimeout(posSaveTimer);
  posSaveTimer = setTimeout(savePositionNow, 800);
}

function savePositionNow() {
  if (!currentDocRec || !pdfDoc) return;
  const c = els.container;
  const denom = Math.max(1, c.scrollHeight - c.clientHeight);
  currentDocRec.pos = {
    frac: Math.min(1, c.scrollTop / denom),
    word: current,
    page: topPageIndex() + 1,
  };
  recentPut(currentDocRec);
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) savePositionNow();
});
window.addEventListener("pagehide", savePositionNow);

function timeAgo(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + " min ago";
  if (s < 86400) return Math.floor(s / 3600) + " h ago";
  return Math.floor(s / 86400) + " d ago";
}

async function renderRecent() {
  const items = ((await recentAll()) || []).sort((a, b) => b.ts - a.ts).slice(0, 8);
  $("recentBox").classList.toggle("hidden", items.length === 0);
  const list = $("recentList");
  list.replaceChildren();
  for (const rec of items) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "recent-row";
    const name = document.createElement("span");
    name.className = "recent-name";
    name.textContent = rec.name;
    name.title = rec.kind === "url" ? rec.url : rec.name;
    const meta = document.createElement("span");
    meta.className = "recent-meta";
    meta.textContent = [
      rec.pos && rec.pos.page ? "page " + rec.pos.page : null,
      timeAgo(rec.ts),
      rec.kind === "url" ? "URL" : null,
    ].filter(Boolean).join(" · ");
    const del = document.createElement("span");
    del.className = "recent-del";
    del.title = "Remove from list";
    del.textContent = "✕";
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      await recentDelete(rec.id);
      renderRecent();
    });
    row.append(name, meta, del);
    row.addEventListener("click", () => openRecent(rec));
    list.append(row);
  }
}

async function openRecent(rec) {
  if (rec.kind === "url") { openUrl(rec.url); return; }
  if (rec.handle) {
    try {
      let perm = await rec.handle.queryPermission({ mode: "read" });
      if (perm !== "granted") perm = await rec.handle.requestPermission({ mode: "read" });
      if (perm !== "granted") {
        setNotice("Read permission was denied. Pick the file again or drop it here.");
        return;
      }
      const file = await rec.handle.getFile();
      await openFile(file, rec.handle);
      return;
    } catch (err) {
      console.warn("Could not reopen recent file:", err);
      setNotice("Could not reopen this file &mdash; it may have been moved or deleted.<br>Pick it again or drop it here.");
      return;
    }
  }
  // No stored handle (older browser): fall back to the picker; the reading
  // position is still restored via the file's name+size fingerprint.
  pickFile();
}

// ---------- Persistence ----------

function loadPref(key, def) {
  try {
    const v = localStorage.getItem("rsvp." + key);
    return v === null ? def : JSON.parse(v);
  } catch { return def; }
}
function savePref(key, val) {
  try { localStorage.setItem("rsvp." + key, JSON.stringify(val)); } catch {}
}

// ---------- Document loading ----------

const DEFAULT_NOTICE = els.noticeText.innerHTML;

function setNotice(html) {
  els.notice.classList.remove("hidden");
  els.noticeText.innerHTML = html;
}

// Close the current document and return to the home screen.
function goHome() {
  if (!pdfDoc) return;
  savePositionNow();
  docGen++; // cancels any in-flight extraction or rendering for the old doc
  closeRsvp();
  setPicking(false);
  if (observer) observer.disconnect();
  pdfDoc = null;
  pageObjs = [];
  pageViews = [];
  currentDocRec = null;
  resetTextState();
  els.pages.replaceChildren();
  $("outline").replaceChildren();
  $("sidebar").classList.add("hidden");
  els.pageInfo.classList.add("hidden");
  els.docTitle.textContent = "No document";
  els.docTitle.title = "";
  document.title = "Seshat";
  els.noticeText.innerHTML = DEFAULT_NOTICE;
  els.notice.classList.remove("hidden");
  renderRecent();
  history.replaceState(null, "", location.pathname);
}

$("btnHome").addEventListener("click", goHome);

async function openData(data, name, meta = null) {
  const gen = ++docGen;
  closeRsvp();
  setPicking(false);
  stop();
  imageRectsCache.clear();
  currentDocRec = null;
  restoreWordTarget = null;
  els.pages.replaceChildren();
  setNotice("Loading&hellip;");
  try {
    const task = pdfjsLib.getDocument({
      data,
      cMapUrl: new URL("./lib/cmaps/", import.meta.url).href,
      cMapPacked: true,
      standardFontDataUrl: new URL("./lib/standard_fonts/", import.meta.url).href,
    });
    const doc = await task.promise;
    if (gen !== docGen) return;
    pdfDoc = doc;
    els.docTitle.textContent = name;
    els.docTitle.title = name;
    document.title = name + " — Seshat";

    // Fast path: page sizes only, so the document is visible immediately.
    const promises = [];
    for (let p = 1; p <= doc.numPages; p++) promises.push(doc.getPage(p));
    pageObjs = await Promise.all(promises);
    if (gen !== docGen) return;
    pageDims = pageObjs.map((pg) => {
      const vp = pg.getViewport({ scale: 1 });
      return { w: vp.width, h: vp.height };
    });
    resetTextState();
    fitWidth = true;
    computeFitScale();
    layoutPages();
    buildOutline(gen);
    els.notice.classList.add("hidden");

    if (meta) {
      const prev = await recentGet(meta.id);
      if (gen !== docGen) return;
      currentDocRec = { ...meta, ts: Date.now(), pos: prev && prev.pos ? prev.pos : null };
      await recentPut(currentDocRec);
      renderRecent();
      const pos = currentDocRec.pos;
      if (pos) {
        const c = els.container;
        c.scrollTop = pos.frac * Math.max(0, c.scrollHeight - c.clientHeight);
        if (typeof pos.word === "number" && pos.word >= 0) restoreWordTarget = pos.word;
        renderVisible();
      }
    }

    // Slow path: text indexing streams in the background.
    extractAllText(gen);
  } catch (err) {
    console.error(err);
    setNotice("Could not open this PDF.<br><span style='font-size:12px'>" +
      String(err && err.message ? err.message : err).replace(/</g, "&lt;") + "</span>");
  }
}

async function openUrl(url) {
  setNotice("Downloading&hellip;");
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const buf = await res.arrayBuffer();
    const name = decodeURIComponent(url.split("#")[0].split("?")[0].split("/").pop() || "document.pdf");
    await openData(buf, name, { id: url, kind: "url", url, name });
  } catch (err) {
    console.error(err);
    setNotice("Could not download the PDF (the server may not allow cross-origin access).<br>" +
      "Download it yourself and drop it here instead.");
  }
}

async function openFile(file, handle = null) {
  const buf = await file.arrayBuffer();
  const meta = {
    id: file.name + "|" + file.size,
    kind: "file",
    name: file.name,
    size: file.size,
  };
  if (handle) meta.handle = handle;
  await openData(buf, file.name, meta);
}

// ---------- Text extraction ----------

const SENTENCE_END = /[.!?…]["'”’)\]]*$/;
const HYPHEN_END = /[-­‐]$/;
const LOWER_START = /^[a-zß-öø-ÿ]/;

function resetTextState() {
  words = [];
  wordEls = [];
  current = -1;
  currentEls = [];
  pageTextCache = [];
  pageWordRanges = [];
  sentenceStart = [];
  paceCum = [0];
  pendingTok = null;
  extractedPages = 0;
  extractionDone = false;
}

// Streaming word merge: rejoins words hyphenated across lines
// ("pop-" + "ularity") and drop caps ("W" + "hen") with one token of
// lookbehind, so text can be indexed page-by-page in the background.
function feedToken(tok) {
  const t = pendingTok;
  if (!t) {
    pendingTok = startWord(tok);
    return;
  }
  if (t.text.length > 1 && HYPHEN_END.test(t.text) && t.last.atLineEnd && LOWER_START.test(tok.text)) {
    t.text = t.text.replace(HYPHEN_END, "") + tok.text;
  } else if (
    t.text.length === 1 && /[A-ZÀ-Þ]/.test(t.text) &&
    LOWER_START.test(tok.text) && t.last.fontH >= 1.5 * tok.fontH
  ) {
    t.text += tok.text;
  } else {
    finalizeWord(t);
    pendingTok = startWord(tok);
    return;
  }
  t.segments.push({ page: tok.page, item: tok.item, start: tok.start, len: tok.len });
  t.last = tok;
}

function startWord(tok) {
  return {
    text: tok.text,
    segments: [{ page: tok.page, item: tok.item, start: tok.start, len: tok.len }],
    last: tok,
  };
}

function finalizeWord(t) {
  const wi = words.length;
  if (wi === 0 || SENTENCE_END.test(words[wi - 1].text)) sentenceStart.push(wi);
  words.push({ text: t.text, page: t.segments[0].page, segments: t.segments });
  paceCum.push(paceCum[wi] + paceMultiplier(t.text));
  for (const s of t.segments) {
    pageWordRanges[s.page][s.item].push({ start: s.start, len: s.len, wi });
  }
}

function tokenizePage(p, tc) {
  const items = tc.items;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it.str) continue;
    const fontH = Math.hypot(it.transform[2], it.transform[3]);
    const y = it.transform[5];
    let nextY = null;
    for (let j = i + 1; j < items.length; j++) {
      if (items[j].str && items[j].str.trim()) { nextY = items[j].transform[5]; break; }
    }
    const re = /\S+/g;
    let m;
    let prev = null;
    while ((m = re.exec(it.str))) {
      if (prev) feedToken(prev);
      prev = {
        text: m[0], page: p, item: i, start: m.index, len: m[0].length,
        fontH, atLineEnd: false,
      };
    }
    if (prev) {
      prev.atLineEnd = it.hasEOL || nextY === null || Math.abs(nextY - y) > 2;
      feedToken(prev);
    }
  }
}

// A page's word ranges are final once the *next* page has been tokenized
// (the last word may continue onto the following page).
function wrapReady(p) {
  return extractionDone || extractedPages >= p + 2;
}

function tryWrap(p) {
  const v = pageViews[p];
  if (!v || !v.rendered || v.wrapped || !v.textDivs || !wrapReady(p)) return;
  wrapWords(p, v.textDivs);
  v.wrapped = true;
  if (current >= 0 && words[current] && words[current].page === p) {
    highlightWord(current, false);
  }
}

async function extractAllText(gen) {
  const numPages = pageObjs.length;
  for (let p = 0; p < numPages; p++) {
    let tc = pageTextCache[p];
    if (!tc) {
      try {
        tc = await pageObjs[p].getTextContent();
      } catch (err) {
        console.warn("Text extraction failed for page", p + 1, err);
        tc = { items: [] };
      }
      if (gen !== docGen) return;
      pageTextCache[p] = tc;
    }
    pageWordRanges[p] = tc.items.map(() => []);
    tokenizePage(p, tc);
    extractedPages = p + 1;
    if (p > 0) tryWrap(p - 1);
    if (restoreWordTarget != null && current < 0 && words.length > restoreWordTarget) {
      current = restoreWordTarget;
      restoreWordTarget = null;
    }
    updatePageInfo();
  }
  if (gen !== docGen) return;
  if (pendingTok) { finalizeWord(pendingTok); pendingTok = null; }
  extractionDone = true;
  if (restoreWordTarget != null && current < 0 && words.length) {
    current = Math.min(restoreWordTarget, words.length - 1);
    restoreWordTarget = null;
  }
  for (let p = 0; p < pageViews.length; p++) tryWrap(p);
  updatePageInfo();
  if (words.length === 0) {
    setNotice("No selectable text found in this PDF (it may be a scanned image).<br>RSVP needs a text layer to work.");
  }
}

// The page occupying the center of the viewport.
function currentPageIndex() {
  const center = els.container.scrollTop + els.container.clientHeight / 2;
  for (let i = 0; i < pageViews.length; i++) {
    const d = pageViews[i].div;
    if (center < d.offsetTop + d.offsetHeight + 8) return i;
  }
  return Math.max(0, pageViews.length - 1);
}

function updatePageInfo() {
  if (!pdfDoc) return;
  els.pageInfo.classList.remove("hidden");
  if (document.activeElement !== els.pageInput) {
    els.pageInput.value = currentPageIndex() + 1;
  }
  els.pageInput.max = pdfDoc.numPages;
  els.pageCount.textContent = pdfDoc.numPages;
  els.indexingNote.textContent = !extractionDone && pageObjs.length
    ? " · reading text " + Math.round((extractedPages / pageObjs.length) * 100) + "%"
    : "";
}

function goToPage(n) {
  if (!pdfDoc || !pageViews.length) return;
  const i = Math.min(pdfDoc.numPages, Math.max(1, n)) - 1;
  els.container.scrollTop = Math.max(0, pageViews[i].div.offsetTop - 8);
  renderVisible();
}

els.pageInput.addEventListener("change", () => {
  const n = parseInt(els.pageInput.value, 10);
  if (Number.isFinite(n)) goToPage(n);
  else updatePageInfo();
});
els.pageInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") els.pageInput.blur();
});
els.pageInput.addEventListener("blur", updatePageInfo);

// ---------- Page layout & rendering ----------

function computeFitScale() {
  if (!pageDims.length) return;
  let avail = els.container.clientWidth - 32;
  if (avail < 100) avail = Math.max(100, window.innerWidth - 32);
  scale = Math.min(4, Math.max(0.25, avail / pageDims[0].w));
}

function layoutPages() {
  if (observer) observer.disconnect();
  els.pages.replaceChildren();
  els.pages.style.setProperty("--scale-factor", scale);
  pageViews = [];
  wordEls = [];
  currentEls = [];
  observer = new IntersectionObserver(onIntersect, {
    root: els.container,
    rootMargin: "1200px 0px",
  });
  for (let p = 1; p <= pdfDoc.numPages; p++) {
    const div = document.createElement("div");
    div.className = "page";
    div.dataset.page = p;
    div.style.width = pageDims[p - 1].w * scale + "px";
    div.style.height = pageDims[p - 1].h * scale + "px";
    els.pages.append(div);
    pageViews.push({ div, pageNum: p, rendered: false, rendering: false });
    observer.observe(div);
  }
  els.zoomLabel.textContent = Math.round(scale * 100) + "%";
  updatePageInfo();
  renderVisible();
}

// Geometry-based fallback so pages render even when IntersectionObserver
// is throttled (e.g. hidden/backgrounded documents).
function renderVisible() {
  const top = els.container.scrollTop - 1200;
  const bottom = els.container.scrollTop + els.container.clientHeight + 1200;
  for (const v of pageViews) {
    const y = v.div.offsetTop;
    if (y + v.div.offsetHeight >= top && y <= bottom) renderPage(v);
  }
  updatePageInfo();
}

let scrollPending = false;
els.container.addEventListener("scroll", () => {
  if (scrollPending) return;
  scrollPending = true;
  requestAnimationFrame(() => {
    scrollPending = false;
    renderVisible();
    schedulePositionSave();
  });
});

function onIntersect(entries) {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    const v = pageViews[Number(e.target.dataset.page) - 1];
    renderPage(v);
  }
}

async function renderPage(v) {
  if (!pdfDoc || v.rendered || v.rendering) return;
  v.rendering = true;
  try {
    const page = pageObjs[v.pageNum - 1];
    const vp = page.getViewport({ scale });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(vp.width * dpr);
    canvas.height = Math.floor(vp.height * dpr);
    canvas.style.width = vp.width + "px";
    canvas.style.height = vp.height + "px";
    canvas.className = "pageCanvas";
    const ctx = canvas.getContext("2d", { alpha: false });
    await page.render({
      canvas,
      canvasContext: ctx,
      viewport: vp,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
    }).promise;

    let tc = pageTextCache[v.pageNum - 1];
    if (!tc) tc = pageTextCache[v.pageNum - 1] = await page.getTextContent();
    const tld = document.createElement("div");
    tld.className = "textLayer";
    // The text layer must be attached to the document (with --scale-factor
    // resolvable) while it renders, or its glyph measurements come out wrong
    // and the selectable text drifts away from the painted text.
    v.div.replaceChildren(canvas, tld);
    const textLayer = new pdfjsLib.TextLayer({
      textContentSource: tc,
      container: tld,
      viewport: vp,
    });
    await textLayer.render();

    v.textDivs = textLayer.textDivs && textLayer.textDivs.length
      ? textLayer.textDivs
      : [...tld.querySelectorAll(":scope > span")];
    if (wrapReady(v.pageNum - 1)) {
      wrapWords(v.pageNum - 1, v.textDivs);
      v.wrapped = true;
    }
    await renderLinks(page, v);
    v.canvas = canvas;
    if (inverted) buildImageOverlay(v);
    if (current >= 0 && words[current] && words[current].page === v.pageNum - 1) {
      highlightWord(current, false);
    }
    v.rendered = true;
  } finally {
    v.rendering = false;
  }
}

// Split each text-layer div into per-word spans so words are clickable
// and can be highlighted during playback.
function wrapWords(pageIdx, textDivs) {
  const perItem = pageWordRanges[pageIdx];
  if (!perItem) return;
  const n = Math.min(perItem.length, textDivs.length);
  for (let i = 0; i < n; i++) {
    const ranges = perItem[i];
    if (!ranges || !ranges.length) continue;
    const div = textDivs[i];
    const str = div.textContent;
    const frag = document.createDocumentFragment();
    let pos = 0;
    let ok = true;
    for (const r of ranges) {
      if (r.start + r.len > str.length) { ok = false; break; }
      if (r.start > pos) frag.append(str.slice(pos, r.start));
      const s = document.createElement("span");
      s.className = "w";
      s.dataset.wi = r.wi;
      s.textContent = str.slice(r.start, r.start + r.len);
      frag.append(s);
      pos = r.start + r.len;
    }
    if (!ok) continue;
    if (pos < str.length) frag.append(str.slice(pos));
    div.replaceChildren(frag);
    for (const s of div.querySelectorAll("span.w")) {
      const wi = Number(s.dataset.wi);
      (wordEls[wi] ||= []).push(s);
    }
  }
}

// ---------- Inverted (dark) page mode ----------
// The page canvas is inverted with a CSS filter; an overlay canvas repaints
// just the image regions from the original render so pictures keep their
// real colors. Image regions come from walking the page's operator list.

let inverted = false;
const imageRectsCache = new Map(); // pageNum -> rects in PDF units

function setInverted(on) {
  inverted = !!on;
  document.body.classList.toggle("inverted", inverted);
  // Label names the mode you'll switch to (the button's action).
  const btn = $("btnTheme");
  btn.textContent = inverted ? "☀ Light" : "☾ Dark";
  btn.title = (inverted ? "Switch page to light mode" : "Switch page to dark mode") + " (I)";
  savePref("invert", inverted);
  if (inverted) {
    for (const v of pageViews) if (v.rendered) buildImageOverlay(v);
  }
}

$("btnTheme").addEventListener("click", () => setInverted(!inverted));

async function getImageRects(page) {
  if (imageRectsCache.has(page.pageNumber)) return imageRectsCache.get(page.pageNumber);
  const O = pdfjsLib.OPS;
  const ops = await page.getOperatorList();
  const mul = (m, n) => [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const rects = [];
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i];
    switch (fn) {
      case O.save: stack.push(ctm); break;
      case O.restore: ctm = stack.pop() || ctm; break;
      case O.transform: ctm = mul(ctm, args); break;
      case O.paintFormXObjectBegin:
        stack.push(ctm);
        if (args && args[0]) ctm = mul(ctm, args[0]);
        break;
      case O.paintFormXObjectEnd: ctm = stack.pop() || ctm; break;
      case O.paintImageXObject:
      case O.paintImageXObjectRepeat:
      case O.paintInlineImageXObject:
      case O.paintJpegXObject: {
        // The image fills the unit square under the current transform.
        const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => [
          ctm[0] * x + ctm[2] * y + ctm[4],
          ctm[1] * x + ctm[3] * y + ctm[5],
        ]);
        const xs = pts.map((p) => p[0]);
        const ys = pts.map((p) => p[1]);
        rects.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
        break;
      }
    }
  }
  imageRectsCache.set(page.pageNumber, rects);
  return rects;
}

async function buildImageOverlay(v) {
  if (v.imgOverlayBuilt || !v.canvas) return;
  v.imgOverlayBuilt = true;
  try {
    const page = pageObjs[v.pageNum - 1];
    const rects = await getImageRects(page);
    if (!rects.length) return;
    const canvas = v.canvas;
    const ratio = canvas.width / parseFloat(canvas.style.width);
    const ov = document.createElement("canvas");
    ov.width = canvas.width;
    ov.height = canvas.height;
    ov.style.width = canvas.style.width;
    ov.style.height = canvas.style.height;
    ov.className = "imgOverlay";
    const ctx = ov.getContext("2d");
    const pageH = pageDims[v.pageNum - 1].h;
    for (const [x1, y1, x2, y2] of rects) {
      const x = x1 * scale * ratio;
      const y = (pageH - y2) * scale * ratio;
      const w = (x2 - x1) * scale * ratio;
      const h = (y2 - y1) * scale * ratio;
      ctx.drawImage(canvas, x, y, w, h, x, y, w, h);
    }
    canvas.after(ov);
  } catch (err) {
    console.warn("Image overlay failed for page", v.pageNum, err);
  }
}

// Clickable link annotations (external URLs and in-document jumps).
async function renderLinks(page, v) {
  let annots;
  try { annots = await page.getAnnotations({ intent: "display" }); } catch { return; }
  const links = annots.filter((a) => a.subtype === "Link" && (a.url || a.dest));
  if (!links.length) return;
  const layer = document.createElement("div");
  layer.className = "linkLayer";
  const pageH = pageDims[v.pageNum - 1].h;
  for (const a of links) {
    // PDF rects are [x1, y1, x2, y2] with a bottom-left origin.
    const [x1, y1, x2, y2] = pdfjsLib.Util.normalizeRect(a.rect);
    const el = document.createElement("a");
    el.style.left = x1 * scale + "px";
    el.style.top = (pageH - y2) * scale + "px";
    el.style.width = (x2 - x1) * scale + "px";
    el.style.height = (y2 - y1) * scale + "px";
    if (a.url) {
      el.href = a.url;
      el.target = "_blank";
      el.rel = "noopener noreferrer";
      el.title = a.url;
    } else {
      el.href = "#";
      el.title = "Go to destination in this document";
      el.addEventListener("click", (e) => {
        e.preventDefault();
        goToDest(a.dest);
      });
    }
    layer.append(el);
  }
  v.div.append(layer);
}

// Resolve a destination (named or explicit) to a 0-based page index and the
// raw destination array. Returns null if it can't be resolved.
async function resolveDest(dest) {
  const d = typeof dest === "string" ? await pdfDoc.getDestination(dest) : dest;
  if (!Array.isArray(d) || d[0] == null) return null;
  const pageIndex = typeof d[0] === "object"
    ? await pdfDoc.getPageIndex(d[0])
    : d[0];
  return { pageIndex, ref: d };
}

async function goToDest(dest) {
  try {
    const r = await resolveDest(dest);
    if (!r) return;
    const { pageIndex, ref: d } = r;
    const v = pageViews[pageIndex];
    if (!v) return;
    let top = v.div.offsetTop - 8;
    if (d[1] && d[1].name === "XYZ" && typeof d[3] === "number") {
      top = v.div.offsetTop + (pageDims[pageIndex].h - d[3]) * scale - 8;
    }
    els.container.scrollTop = Math.max(0, top);
    renderVisible();
  } catch (err) {
    console.warn("Could not resolve destination", dest, err);
  }
}

// ---------- Bookmarks / outline sidebar ----------

async function buildOutline(gen) {
  const box = $("outline");
  box.replaceChildren();
  let outline = null;
  try { outline = await pdfDoc.getOutline(); } catch {}
  if (gen !== docGen) return;
  if (!outline || !outline.length) {
    const empty = document.createElement("div");
    empty.className = "sb-empty";
    empty.textContent = "No bookmarks in this document.";
    box.append(empty);
    return;
  }
  // Printed page labels (roman numerals for front matter, etc.) if the PDF
  // defines them; otherwise fall back to the physical page number.
  let labels = null;
  try { labels = await pdfDoc.getPageLabels(); } catch {}
  if (gen !== docGen) return;
  const pending = [];
  box.append(buildOutlineList(outline, pending));
  // Resolve each entry's page number in the background so the sidebar stays
  // responsive on large tables of contents.
  for (const { dest, span } of pending) {
    if (gen !== docGen) return;
    try {
      const r = await resolveDest(dest);
      if (r && r.pageIndex != null) {
        span.textContent = labels ? labels[r.pageIndex] : String(r.pageIndex + 1);
      }
    } catch {}
  }
}

function buildOutlineList(items, pending) {
  const ul = document.createElement("ul");
  for (const it of items) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    const title = document.createElement("span");
    title.className = "toc-title";
    title.textContent = it.title || "(untitled)";
    a.append(title);
    if (it.dest) {
      const page = document.createElement("span");
      page.className = "toc-page";
      a.append(page);
      pending.push({ dest: it.dest, span: page });
    }
    a.href = "#";
    a.addEventListener("click", (e) => {
      e.preventDefault();
      if (it.url) window.open(it.url, "_blank", "noopener");
      else if (it.dest) goToDest(it.dest);
    });
    li.append(a);
    if (it.items && it.items.length) li.append(buildOutlineList(it.items, pending));
    ul.append(li);
  }
  return ul;
}

$("btnToc").addEventListener("click", () => {
  $("sidebar").classList.toggle("hidden");
});

function rerender(preserveScroll = true) {
  if (!pdfDoc) return;
  const frac = preserveScroll
    ? els.container.scrollTop / Math.max(1, els.container.scrollHeight)
    : 0;
  layoutPages();
  els.container.scrollTop = frac * els.container.scrollHeight;
}

// ---------- Zoom ----------

function setZoom(newScale, isFit = false) {
  scale = Math.min(4, Math.max(0.25, newScale));
  fitWidth = isFit;
  rerender();
}

$("btnZoomIn").addEventListener("click", () => setZoom(scale * 1.2));
$("btnZoomOut").addEventListener("click", () => setZoom(scale / 1.2));
$("btnFit").addEventListener("click", () => { computeFitScale(); setZoom(scale, true); });

window.addEventListener("resize", () => {
  if (fitWidth && pdfDoc) { computeFitScale(); rerender(); }
  clampRsvpPosition();
});

// ---------- Picking a start word ----------
// Plain clicks are left alone (text selection, PDF links). The start point is
// set in pick mode (S key or the ⌖ button) or with Alt+click.

const DEFAULT_HINT = "Press S (or Alt+click a word) to set the start point";
let picking = false;

function setPicking(on) {
  picking = on && !!words.length;
  document.body.classList.toggle("picking", picking);
  $("hint").textContent = picking
    ? "Click a word to start RSVP there (Esc to cancel)"
    : DEFAULT_HINT;
}

let downPos = null;
els.container.addEventListener("pointerdown", (e) => { downPos = { x: e.clientX, y: e.clientY }; });
els.container.addEventListener("click", (e) => {
  const w = e.target.closest && e.target.closest("span.w");
  if (!w) return;
  if (!picking && !e.altKey) return;
  // Ignore drags / text selections.
  if (downPos && Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > 5) return;
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed) return;
  setPicking(false);
  stop();
  setCurrent(Number(w.dataset.wi));
  openRsvp(false);
});

// ---------- RSVP engine ----------

function orpIndex(word) {
  // Strip leading punctuation when choosing the pivot letter.
  const lead = (word.match(/^["'“‘(\[]+/) || [""])[0].length;
  const core = Math.max(1, word.length - lead);
  let p;
  if (core <= 1) p = 0;
  else if (core <= 5) p = 1;
  else if (core <= 9) p = 2;
  else if (core <= 13) p = 3;
  else p = 4;
  return Math.min(lead + p, word.length - 1);
}

function paceMultiplier(word) {
  let m = 1;
  if (word.length >= 9) m *= 1.3;
  if (/[,;:—–]["'”’)\]]*$/.test(word)) m *= 1.6;
  else if (SENTENCE_END.test(word)) m *= 2.2;
  return m;
}

function delayFor(word) {
  return (60000 / wpm) * paceMultiplier(word);
}

function formatEta(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return s + " s left";
  const min = Math.round(s / 60);
  if (min < 60) return min + " min left";
  return Math.floor(min / 60) + " h " + (min % 60) + " min left";
}

function updateEta(i) {
  if (!words.length || i < 0) { els.rsvpEta.textContent = ""; return; }
  const unitsLeft = paceCum[words.length] - paceCum[i];
  els.rsvpEta.textContent = formatEta(unitsLeft * (60000 / wpm));
}

function showWord(i) {
  const w = words[i].text;
  const p = orpIndex(w);
  els.wPre.textContent = w.slice(0, p);
  els.wPivot.textContent = w[p] || "";
  els.wPost.textContent = w.slice(p + 1);
  // Shift the word so the pivot letter's center sits on the ORP anchor line.
  const anchor = els.rsvpStage.clientWidth * ORP_X;
  const x = anchor - (els.wPivot.offsetLeft + els.wPivot.offsetWidth / 2);
  els.rsvpWord.style.transform = `translateY(-50%) translateX(${x}px)`;
  els.rsvpCounter.textContent = (i + 1).toLocaleString() + " / " + words.length.toLocaleString();
  els.progressFill.style.width = ((i + 1) / words.length * 100) + "%";
  updateEta(i);
}

function highlightWord(i, scroll = true) {
  for (const el of currentEls) el.classList.remove("current");
  currentEls = wordEls[i] || [];
  for (const el of currentEls) el.classList.add("current");
  const first = currentEls[0];
  if (!scroll || !first) return;
  const r = first.getBoundingClientRect();
  const c = els.container.getBoundingClientRect();
  if (r.top < c.top + 40 || r.bottom > c.bottom - 40) {
    first.scrollIntoView({
      block: "center",
      behavior: playing || document.hidden ? "auto" : "smooth",
    });
    renderVisible();
  }
}

function setCurrent(i) {
  if (!words.length) return;
  current = Math.min(Math.max(0, i), words.length - 1);
  showWord(current);
  highlightWord(current);
  schedulePositionSave();
}

function tick() {
  timer = setTimeout(() => {
    if (current >= words.length - 1) { stop(); return; }
    setCurrent(current + 1);
    tick();
  }, delayFor(words[current].text));
}

function play() {
  if (playing || !words.length) return;
  if (current < 0) setCurrent(firstVisibleWord());
  playing = true;
  els.btnPlay.innerHTML = "&#10074;&#10074;";
  tick();
}

function stop() {
  playing = false;
  clearTimeout(timer);
  timer = null;
  els.btnPlay.innerHTML = "&#9654;";
}

function togglePlay() { playing ? stop() : play(); }

function seekSentence(dir) {
  if (!words.length) return;
  const wasPlaying = playing;
  stop();
  let target;
  if (dir < 0) {
    // Start of current sentence; if already there, the previous one.
    let idx = sentenceStart.filter((s) => s <= current).pop() ?? 0;
    if (idx === current) idx = sentenceStart.filter((s) => s < current).pop() ?? 0;
    target = idx;
  } else {
    target = sentenceStart.find((s) => s > current) ?? words.length - 1;
  }
  setCurrent(target);
  if (wasPlaying) play();
}

function stepWord(dir) {
  if (!words.length) return;
  stop();
  setCurrent(current + dir);
}

function topPageIndex() {
  const top = els.container.scrollTop;
  for (let i = 0; i < pageViews.length; i++) {
    const d = pageViews[i].div;
    if (d.offsetTop + d.offsetHeight > top + 20) return i;
  }
  return 0;
}

function firstVisibleWord() {
  // First word on the topmost page currently in view.
  const pageIdx = topPageIndex();
  const wi = words.findIndex((w) => w.page >= pageIdx);
  return wi === -1 ? 0 : wi;
}

// ---------- RSVP overlay open/close/drag ----------

function openRsvp(autostart) {
  if (!words.length) return;
  els.rsvp.classList.remove("hidden");
  els.btnRsvp.classList.add("active");
  restoreRsvpPosition();
  setCurrent(current < 0 ? firstVisibleWord() : current);
  if (autostart) play();
}

function closeRsvp() {
  stop();
  els.rsvp.classList.add("hidden");
  els.btnRsvp.classList.remove("active");
  for (const el of currentEls) el.classList.remove("current");
  currentEls = [];
}

function toggleRsvp() {
  els.rsvp.classList.contains("hidden") ? openRsvp(false) : closeRsvp();
}

els.btnRsvp.addEventListener("click", toggleRsvp);
$("rsvpClose").addEventListener("click", closeRsvp);
$("btnPick").addEventListener("click", () => setPicking(!picking));
els.btnPlay.addEventListener("click", togglePlay);
$("btnPrevSent").addEventListener("click", () => seekSentence(-1));
$("btnNextSent").addEventListener("click", () => seekSentence(1));

els.progress.addEventListener("click", (e) => {
  if (!words.length) return;
  const r = els.progress.getBoundingClientRect();
  const frac = (e.clientX - r.left) / r.width;
  stop();
  setCurrent(Math.round(frac * (words.length - 1)));
});

function setWpm(v) {
  if (!Number.isFinite(v)) v = wpm;
  wpm = Math.round(Math.min(1500, Math.max(60, v)));
  els.wpmInput.value = wpm;
  savePref("wpm", wpm);
  updateEta(current);
}
$("wpmMinus").addEventListener("click", () => setWpm(wpm - 25));
$("wpmPlus").addEventListener("click", () => setWpm(wpm + 25));
els.wpmInput.addEventListener("change", () => setWpm(parseInt(els.wpmInput.value, 10)));
els.wpmInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") els.wpmInput.blur();
});
setWpm(loadPref("wpm", 350));

// Dragging the overlay.
let rsvpPos = loadPref("pos", null);

function applyRsvpPosition(x, y) {
  els.rsvp.style.left = x + "px";
  els.rsvp.style.top = y + "px";
  els.rsvp.style.right = "auto";
  els.rsvp.style.bottom = "auto";
}

function restoreRsvpPosition() {
  if (rsvpPos) {
    applyRsvpPosition(rsvpPos.x, rsvpPos.y);
    clampRsvpPosition();
  } else {
    const w = els.rsvp.offsetWidth || 420;
    applyRsvpPosition(Math.max(8, (window.innerWidth - w) / 2), Math.max(8, window.innerHeight - 260));
  }
}

function clampRsvpPosition() {
  if (els.rsvp.classList.contains("hidden")) return;
  const r = els.rsvp.getBoundingClientRect();
  const x = Math.min(Math.max(0, r.left), Math.max(0, window.innerWidth - r.width));
  const y = Math.min(Math.max(0, r.top), Math.max(0, window.innerHeight - r.height));
  if (x !== r.left || y !== r.top) applyRsvpPosition(x, y);
}

let drag = null;
els.rsvpHeader.addEventListener("pointerdown", (e) => {
  if (e.target.closest("#rsvpClose")) return;
  const r = els.rsvp.getBoundingClientRect();
  drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
  try { els.rsvpHeader.setPointerCapture(e.pointerId); } catch {}
  e.preventDefault();
});
els.rsvpHeader.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const x = Math.min(Math.max(0, e.clientX - drag.dx), window.innerWidth - els.rsvp.offsetWidth);
  const y = Math.min(Math.max(0, e.clientY - drag.dy), window.innerHeight - els.rsvp.offsetHeight);
  applyRsvpPosition(x, y);
});
els.rsvpHeader.addEventListener("pointerup", (e) => {
  if (!drag) return;
  drag = null;
  const r = els.rsvp.getBoundingClientRect();
  rsvpPos = { x: r.left, y: r.top };
  savePref("pos", rsvpPos);
});

// ---------- Keyboard ----------

window.addEventListener("keydown", (e) => {
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const overlayOpen = !els.rsvp.classList.contains("hidden");
  if (e.key === "r" || e.key === "R") { toggleRsvp(); return; }
  if (e.key === "s" || e.key === "S") { setPicking(!picking); return; }
  if (e.key === "i" || e.key === "I") { setInverted(!inverted); return; }
  if (e.key === "t" || e.key === "T") { setToolbarHidden(!toolbarHidden); return; }
  if (e.key === "Escape" && picking) { setPicking(false); return; }
  if (!overlayOpen) return;
  switch (e.key) {
    case " ": e.preventDefault(); togglePlay(); break;
    case "Escape": closeRsvp(); break;
    case "ArrowLeft": e.preventDefault(); e.shiftKey ? seekSentence(-1) : stepWord(-1); break;
    case "ArrowRight": e.preventDefault(); e.shiftKey ? seekSentence(1) : stepWord(1); break;
    case "ArrowUp": e.preventDefault(); setWpm(wpm + 25); break;
    case "ArrowDown": e.preventDefault(); setWpm(wpm - 25); break;
  }
});

// ---------- File input ----------

async function pickFile() {
  if (window.showOpenFilePicker) {
    let handles;
    try {
      handles = await window.showOpenFilePicker({
        types: [{ description: "PDF documents", accept: { "application/pdf": [".pdf"] } }],
      });
    } catch {
      return; // cancelled
    }
    const handle = handles && handles[0];
    if (handle) openFile(await handle.getFile(), handle);
  } else {
    els.filePicker.click();
  }
}

$("btnOpen").addEventListener("click", pickFile);
els.filePicker.addEventListener("change", () => {
  const f = els.filePicker.files[0];
  if (f) openFile(f);
  els.filePicker.value = "";
});

let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  e.preventDefault();
  dragDepth++;
  document.body.classList.add("dragover");
});
window.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove("dragover"); }
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove("dragover");
  const item = e.dataTransfer.items && e.dataTransfer.items[0];
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (!f) return;
  // Must be requested synchronously, before the DataTransfer goes stale.
  const handlePromise = item && item.getAsFileSystemHandle
    ? item.getAsFileSystemHandle().catch(() => null)
    : Promise.resolve(null);
  handlePromise.then((h) => openFile(f, h && h.kind === "file" ? h : null));
});

// ---------- Startup ----------

let toolbarHidden = false;
function setToolbarHidden(on) {
  toolbarHidden = !!on;
  document.body.classList.toggle("noToolbar", toolbarHidden);
  savePref("toolbarHidden", toolbarHidden);
  if (pdfDoc) renderVisible();
}

setInverted(loadPref("invert", true));
setToolbarHidden(loadPref("toolbarHidden", false));
renderRecent();

const fileParam = new URLSearchParams(location.search).get("file");
if (fileParam) openUrl(fileParam);
