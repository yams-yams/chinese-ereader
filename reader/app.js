const chaptersApiUrl = "/api/chapters";
const modeCopy = {
  read: {
    lede:
      "Read the chapter as one continuous scroll. Hover a character to inspect its word, and click to pin the containing sentence with pinyin and translation.",
  },
  refine: {
    lede:
      "Refine the chapter by inspecting annotation quality, sentence status, and patch-ready data.",
  },
};

const PUNCTUATION_ONLY_RE = /^[\s.,!?;:'"()[\]{}\-_/\\|`~@#$%^&*+=<>，。！？、；：‘’“”《》〈〉「」『』（）【】…·—]+$/;

const state = {
  chapterIndex: [],
  currentChapter: null,
  mode: "read",
  modeNotice: "",
  readModel: null,
  refineModel: null,
  readAnnotations: new Map(),
  refineAnnotations: new Map(),
  annotations: new Map(),
  modelCache: {
    read: new Map(),
    refine: new Map(),
  },
  positionAnchor: null,
  visibleSentenceKeys: new Set(),
  hoveredWordKey: null,
  activeSentenceKey: null,
  activePatchId: null,
  refineSidebarMode: "view",
  draftPatch: null,
  draftBoundaryMode: false,
  draftAnchorPickMode: false,
};

let elements;
let hoverIntentTimer = null;
let viewportAnchorSyncRaf = null;

async function loadJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    return null;
  }
  return response.json();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function imagePath(relativePath) {
  return `../${relativePath}`;
}

function chapterCacheKey(series, chapter) {
  return `${series}::${chapter}`;
}

function chapterEntryFor(series, chapter) {
  return state.chapterIndex.find((entry) => entry.series === series && entry.chapter === chapter) ?? null;
}

function currentChapterEntry() {
  if (!state.currentChapter) {
    return null;
  }
  return chapterEntryFor(state.currentChapter.series, state.currentChapter.chapter);
}

function modeAvailableForChapter(chapter, mode) {
  if (!chapter) {
    return false;
  }
  return mode === "refine" ? Boolean(chapter.hasRefineData) : Boolean(chapter.hasReadModel);
}

function cachedModel(mode, series, chapter) {
  return state.modelCache[mode].get(chapterCacheKey(series, chapter)) ?? null;
}

function cacheModel(mode, model) {
  if (!model?.series || !model?.chapter) {
    return;
  }
  state.modelCache[mode].set(chapterCacheKey(model.series, model.chapter), model);
}

function invalidateChapterCaches(series, chapter, modes = ["read", "refine"]) {
  const key = chapterCacheKey(series, chapter);
  for (const mode of modes) {
    state.modelCache[mode].delete(key);
  }
}

function currentModel() {
  if (state.mode === "refine" && state.refineModel) {
    return state.refineModel;
  }
  return state.readModel;
}

function currentAnnotations() {
  if (state.mode === "refine" && state.refineModel) {
    return state.refineAnnotations;
  }
  return state.readAnnotations;
}

function currentModeLede() {
  return modeCopy[state.mode]?.lede ?? modeCopy.read.lede;
}

function splitSentenceKey(sentenceKey) {
  const separatorIndex = sentenceKey.indexOf(":");
  if (separatorIndex === -1) {
    return null;
  }

  return {
    segmentId: sentenceKey.slice(0, separatorIndex),
    sentenceId: sentenceKey.slice(separatorIndex + 1),
  };
}

function sentenceRecordForKey(sentenceKey, annotations = currentAnnotations()) {
  const parts = splitSentenceKey(sentenceKey);
  if (!parts) {
    return null;
  }

  const annotation = annotations.get(parts.segmentId);
  return annotation?.sentences.find((sentence) => sentence.id === parts.sentenceId) ?? null;
}

function refineSentenceRecordForKey(sentenceKey) {
  const parts = splitSentenceKey(sentenceKey);
  if (!parts) {
    return null;
  }

  return state.refineModel?.sentences.find(
    (sentence) => sentence.segmentId === parts.segmentId && sentence.id === parts.sentenceId,
  ) ?? null;
}

function refinePatchForId(patchId) {
  if (!patchId) {
    return null;
  }

  return state.refineModel?.patches.find((patch) => patch.patch_id === patchId) ?? null;
}

function segmentForSentenceKey(sentenceKey, model = currentModel()) {
  const parts = splitSentenceKey(sentenceKey);
  if (!parts) {
    return null;
  }

  return model?.segments.find((segment) => segment.id === parts.segmentId) ?? null;
}

function sentenceStatusLabel(sentence) {
  return (sentence?.status ?? "active") === "deleted" ? "Deleted" : "Active";
}

function sentenceStatusClass(sentence) {
  return (sentence?.status ?? "active") === "deleted" ? "deleted" : "active";
}

function patchAnchorLabel(patch) {
  if (patch?.anchor?.insert_before_sentence_id) {
    return `Before ${patch.anchor.insert_before_sentence_id}`;
  }
  if (patch?.anchor?.insert_after_sentence_id) {
    return `After ${patch.anchor.insert_after_sentence_id}`;
  }
  return "Append at end";
}

function patchTranscript(patch) {
  return patch?.user_transcript || patch?.ocr_candidate || "No transcript yet.";
}

function segmentForId(segmentId, model = currentModel()) {
  return model?.segments.find((segment) => segment.id === segmentId) ?? null;
}

function sourcePageIdForSegmentId(segmentId) {
  return state.refineModel?.segments.find((segment) => segment.id === segmentId)?.sourcePageId ?? null;
}

function imagePathForSegmentId(segmentId) {
  return state.refineModel?.segments.find((segment) => segment.id === segmentId)?.image ?? null;
}

function reviewPatchFromRefinePatch(patch) {
  const pageId = sourcePageIdForSegmentId(patch.segmentId);
  if (!pageId) {
    return null;
  }

  return {
    patch_id: patch.patch_id,
    page_id: pageId,
    kind: patch.kind ?? "missing_region",
    region: patch.region ?? { polygon: [] },
    text_flow: patch.text_flow ?? { mode: "vertical_rl", guide: [] },
    ocr_candidate: patch.ocr_candidate ?? "",
    user_transcript: patch.user_transcript ?? "",
    anchor: patch.anchor ?? {
      insert_after_sentence_id: null,
      insert_before_sentence_id: null,
    },
    notes: patch.notes ?? "",
  };
}

function autoGuideForPolygon(polygon, flowMode = "vertical_rl") {
  if (!polygon?.length) {
    return [];
  }

  const xs = polygon.map((point) => point.x);
  const ys = polygon.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;

  if (flowMode.startsWith("vertical")) {
    return [
      { x: maxX, y: midY },
      { x: minX, y: midY },
    ];
  }

  return [
    { x: midX, y: maxY },
    { x: midX, y: minY },
  ];
}

function draftPatchGeometry(draftPatch) {
  if (!draftPatch?.region?.polygon?.length) {
    return null;
  }
  if (draftPatch.region.polygon.length >= 3) {
    return polygonToStyle(draftPatch.region.polygon);
  }
  return null;
}

function renderDraftPoints(overlay, draftPatch, segmentId) {
  for (const point of overlay.querySelectorAll(".draft-point")) {
    point.remove();
  }

  if (!draftPatch || draftPatch.segmentId !== segmentId) {
    return;
  }

  for (const point of draftPatch.region?.polygon ?? []) {
    const marker = document.createElement("div");
    marker.className = "draft-point";
    marker.style.left = `${point.x * 100}%`;
    marker.style.top = `${(1 - point.y) * 100}%`;
    overlay.appendChild(marker);
  }
}

function draftPatchKey() {
  return state.draftPatch?.patch_id ?? "draft-patch";
}

function createDraftPatchFromSentence(sentence) {
  const segment = segmentForId(sentence.segmentId, state.refineModel);
  if (!segment) {
    return null;
  }

  return {
    patch_id: draftPatchKey(),
    segmentId: sentence.segmentId,
    kind: "missing_region",
    region: {
      polygon: [],
    },
    text_flow: {
      mode: "vertical_rl",
      guide: [],
    },
    ocr_candidate: "",
    user_transcript: "",
    anchorMode: "after",
    anchor: {
      insert_after_sentence_id: sentence.id,
      insert_before_sentence_id: null,
    },
    notes: "",
    sourcePageId: segment.sourcePageId,
  };
}

function createEmptyDraftPatch() {
  return {
    patch_id: draftPatchKey(),
    segmentId: null,
    kind: "missing_region",
    region: {
      polygon: [],
    },
    text_flow: {
      mode: "vertical_rl",
      guide: [],
    },
    ocr_candidate: "",
    user_transcript: "",
    anchorMode: "append",
    anchor: {
      insert_after_sentence_id: null,
      insert_before_sentence_id: null,
    },
    notes: "",
    sourcePageId: null,
  };
}

function draftPatchStatusText(draftPatch) {
  if (!draftPatch) {
    return "";
  }
  if (state.draftBoundaryMode) {
    return "Click points on the page to outline the patch boundary, then finish the boundary.";
  }
  if (!draftPatch.segmentId) {
    return "Start boundary drawing, then click points on the page where the missing text should be patched.";
  }
  if (!draftPatch.region?.polygon?.length) {
    return "Start boundary drawing to outline the missing-text region.";
  }
  if (!draftPatch.user_transcript.trim()) {
    return "Add the accepted transcript before processing.";
  }
  return "Draft is ready to process.";
}

function patchAnchorDraftLabel(anchor, anchorMode = "append") {
  if (anchor?.insert_before_sentence_id) {
    return `Before ${anchor.insert_before_sentence_id}`;
  }
  if (anchor?.insert_after_sentence_id) {
    return `After ${anchor.insert_after_sentence_id}`;
  }
  if (anchorMode === "before") {
    return "Before sentence (select one)";
  }
  if (anchorMode === "after") {
    return "After sentence (select one)";
  }
  return "Append at end";
}

function panelMarkup(title, fields) {
  return `
    <h2>${title}</h2>
    ${fields
      .filter(({ value }) => value !== null && value !== undefined && value !== "")
      .map(
        ({ label, value }) => `
          <p><span class="label">${label}</span>${value}</p>
        `,
      )
      .join("")}
  `;
}

function renderEmptyPanels() {
  elements.wordPanel.innerHTML = `<h2>Word</h2><p class="empty">Hover a character.</p>`;
  elements.sentencePanel.innerHTML = `<h2>Sentence</h2><p class="empty">Click a character.</p>`;
}

function renderEmptyNotesPanel() {
  elements.notesBody.innerHTML =
    `<p class="empty">Chapter-level notes will appear here when available.</p>`;
}

function groupBySegment(items) {
  const grouped = new Map();
  for (const item of items ?? []) {
    const bucket = grouped.get(item.segmentId) ?? [];
    bucket.push(item);
    grouped.set(item.segmentId, bucket);
  }
  return grouped;
}

function mapById(items) {
  return new Map((items ?? []).map((item) => [item.id, item]));
}

function chapterTitle() {
  const model = currentModel();
  const chapter = currentChapterEntry();
  return model?.title ?? chapter?.title ?? `${state.currentChapter?.series ?? ""} / ${state.currentChapter?.chapter ?? ""}`.trim();
}

function segmentEntries() {
  return currentModel()?.segments ?? [];
}

function updateChapterUrl(series, chapter, mode = state.mode) {
  const url = new URL(window.location.href);
  url.searchParams.set("series", series);
  url.searchParams.set("chapter", chapter);
  url.searchParams.set("mode", mode);
  window.history.replaceState({}, "", url);
}

function wordKey(segmentId, wordId) {
  return `${segmentId}:${wordId}`;
}

function sentenceKey(segmentId, sentenceId) {
  return `${segmentId}:${sentenceId}`;
}

function tooltipForWord(word, fallbackText) {
  if (!word) {
    return fallbackText;
  }

  const parts = [word.pinyin, word.translation].filter(Boolean);
  return parts.length > 0 ? parts.join(" - ") : fallbackText;
}

function isPunctuationOnly(text) {
  return Boolean(text) && PUNCTUATION_ONLY_RE.test(text);
}

function showHoverTooltip(text, x, y) {
  if (!text) {
    hideHoverTooltip();
    return;
  }

  elements.hoverTooltip.textContent = text;
  elements.hoverTooltip.classList.add("visible");
  elements.hoverTooltip.setAttribute("aria-hidden", "false");
  moveHoverTooltip(x, y);
}

function moveHoverTooltip(x, y) {
  const offsetX = 16;
  const offsetY = 18;
  const maxX = window.innerWidth - elements.hoverTooltip.offsetWidth - 12;
  const maxY = window.innerHeight - elements.hoverTooltip.offsetHeight - 12;
  const nextX = Math.min(x + offsetX, Math.max(12, maxX));
  const nextY = Math.min(y + offsetY, Math.max(12, maxY));

  elements.hoverTooltip.style.left = `${nextX}px`;
  elements.hoverTooltip.style.top = `${nextY}px`;
}

function hideHoverTooltip() {
  elements.hoverTooltip.classList.remove("visible");
  elements.hoverTooltip.setAttribute("aria-hidden", "true");
}

function polygonToStyle(polygon) {
  if (!polygon || polygon.length === 0) {
    return {
      left: "0%",
      top: "0%",
      width: "0%",
      height: "0%",
      clipPath: "inset(0)",
    };
  }

  const xs = polygon.map((point) => point.x);
  const ys = polygon.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const width = Math.max(maxX - minX, 0.0001);
  const height = Math.max(maxY - minY, 0.0001);

  const clipPath = polygon
    .map((point) => {
      const localX = ((point.x - minX) / width) * 100;
      const localY = ((maxY - point.y) / height) * 100;
      return `${localX}% ${localY}%`;
    })
    .join(", ");

  return {
    left: `${minX * 100}%`,
    top: `${(1 - maxY) * 100}%`,
    width: `${width * 100}%`,
    height: `${height * 100}%`,
    clipPath: `polygon(${clipPath})`,
  };
}

function boundsStyleFromPolygons(polygons, paddingX = 0.01, paddingY = 0) {
  const points = polygons.flat().filter(Boolean);
  if (points.length === 0) {
    return null;
  }

  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.max(0, Math.min(...xs) - paddingX);
  const maxX = Math.min(1, Math.max(...xs) + paddingX);
  const minY = Math.max(0, Math.min(...ys) - paddingY);
  const maxY = Math.min(1, Math.max(...ys) + paddingY);

  return {
    left: `${minX * 100}%`,
    top: `${(1 - maxY) * 100}%`,
    width: `${Math.max(maxX - minX, 0.0001) * 100}%`,
    height: `${Math.max(maxY - minY, 0.0001) * 100}%`,
  };
}

function sentencePolygon(sentence, charactersById) {
  if (sentence?.polygon?.length) {
    return sentence.polygon;
  }

  if (!sentence?.characterIds?.length) {
    return null;
  }

  const sentencePolygons = sentence.characterIds
    .map((id) => charactersById.get(id)?.polygon)
    .filter(Boolean);
  const bounds = boundsStyleFromPolygons(sentencePolygons, 0, 0);
  if (!bounds) {
    return null;
  }

  const left = Number.parseFloat(bounds.left) / 100;
  const top = Number.parseFloat(bounds.top) / 100;
  const width = Number.parseFloat(bounds.width) / 100;
  const height = Number.parseFloat(bounds.height) / 100;

  const maxY = 1 - top;
  const minY = maxY - height;
  const minX = left;
  const maxX = left + width;

  return [
    { x: minX, y: maxY },
    { x: maxX, y: maxY },
    { x: maxX, y: minY },
    { x: minX, y: minY },
  ];
}

function applyGeometry(element, geometry) {
  element.style.left = geometry.left;
  element.style.top = geometry.top;
  element.style.width = geometry.width;
  element.style.height = geometry.height;
  if (geometry.clipPath) {
    element.style.setProperty("--clip-path", geometry.clipPath);
  } else {
    element.style.removeProperty("--clip-path");
  }
}

function buildAnnotationMapFromChapterModel(model, { includeDeleted = false } = {}) {
  const sentencesBySegment = groupBySegment(model?.sentences ?? []);
  const wordsBySegment = groupBySegment(model?.words ?? []);
  const charactersBySegment = groupBySegment(model?.characters ?? []);
  const annotations = new Map();

  for (const segment of model?.segments ?? []) {
    const activeSentences = (sentencesBySegment.get(segment.id) ?? [])
      .filter((sentence) => includeDeleted || (sentence.status ?? "active") !== "deleted")
      .map((sentence) => ({ ...sentence }));
    const keptSentenceIds = new Set(activeSentences.map((sentence) => sentence.id));

    const characters = (charactersBySegment.get(segment.id) ?? [])
      .filter((character) => keptSentenceIds.has(character.sentenceId))
      .map((character) => ({ ...character }));
    const keptCharacterIds = new Set(characters.map((character) => character.id));

    const words = (wordsBySegment.get(segment.id) ?? [])
      .filter((word) => (word.characterIds ?? []).some((characterId) => keptCharacterIds.has(characterId)))
      .map((word) => ({ ...word }));

    annotations.set(segment.id, {
      sourceImage: segment.image,
      imageSize: segment.imageSize ?? null,
      characters,
      words,
      sentences: activeSentences,
    });
  }

  return annotations;
}

function syncActiveAnnotations() {
  state.annotations = currentAnnotations();
}

function captureTopVisibleSentenceAnchor() {
  let bestAnchor = null;

  for (const hotspot of elements.chapterStack.querySelectorAll(".hotspot")) {
    const rect = hotspot.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      continue;
    }
    if (rect.bottom <= 0 || rect.top >= window.innerHeight) {
      continue;
    }

    if (!bestAnchor || rect.top < bestAnchor.offsetTop) {
      bestAnchor = {
        sentenceKey: hotspot.dataset.sentenceKey || "",
        offsetTop: rect.top,
      };
    }
  }

  return bestAnchor;
}

function syncViewportAnchor() {
  viewportAnchorSyncRaf = null;
  state.positionAnchor = captureTopVisibleSentenceAnchor();
  const nextVisibleKeys = new Set(collectVisibleSentenceKeys());
  const changed =
    nextVisibleKeys.size !== state.visibleSentenceKeys.size ||
    [...nextVisibleKeys].some((key) => !state.visibleSentenceKeys.has(key));
  state.visibleSentenceKeys = nextVisibleKeys;
  if (state.mode === "refine" && changed) {
    renderRefinePanel();
    renderInteractionState();
  }
}

function queueViewportAnchorSync() {
  if (viewportAnchorSyncRaf !== null) {
    return;
  }

  viewportAnchorSyncRaf = window.requestAnimationFrame(syncViewportAnchor);
}

function collectVisibleSentenceKeys() {
  const visibleKeys = [];
  const seen = new Set();

  for (const hotspot of elements?.chapterStack?.querySelectorAll(".hotspot") ?? []) {
    const sentenceKey = hotspot.dataset.sentenceKey;
    if (!sentenceKey || seen.has(sentenceKey)) {
      continue;
    }

    const rect = hotspot.getBoundingClientRect();
    const intersectsViewport =
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > 0 &&
      rect.top < window.innerHeight &&
      rect.right > 0 &&
      rect.left < window.innerWidth;
    if (!intersectsViewport) {
      continue;
    }

    visibleKeys.push(sentenceKey);
    seen.add(sentenceKey);
  }

  return visibleKeys;
}

function restoreTopVisibleSentenceAnchor(anchor) {
  if (!anchor?.sentenceKey) {
    return;
  }

  const hotspot = elements.chapterStack.querySelector(
    `.hotspot[data-sentence-key="${CSS.escape(anchor.sentenceKey)}"]`,
  );
  if (!hotspot) {
    return;
  }

  const rect = hotspot.getBoundingClientRect();
  const delta = rect.top - anchor.offsetTop;
  window.scrollBy({ top: delta, left: 0, behavior: "auto" });
}

function renderModeControls() {
  const isRead = state.mode === "read";
  const chapter = currentChapterEntry();
  elements.readModeButton.classList.toggle("active", isRead);
  elements.refineModeButton.classList.toggle("active", !isRead);
  elements.readModeButton.setAttribute("aria-pressed", isRead ? "true" : "false");
  elements.refineModeButton.setAttribute("aria-pressed", !isRead ? "true" : "false");
  elements.readModeButton.disabled = !modeAvailableForChapter(chapter, "read");
  elements.refineModeButton.disabled = !modeAvailableForChapter(chapter, "refine");
  elements.modeDescription.textContent = currentModeLede();
  document.body.dataset.mode = state.mode;
}

function formatRefineSentenceMeta(sentence) {
  const parts = [];
  if (sentence?.source?.type) {
    parts.push(sentence.source.type);
  }
  if (sentence?.ocrConfidence !== null && sentence?.ocrConfidence !== undefined) {
    parts.push(`OCR ${Math.round(sentence.ocrConfidence * 100)}%`);
  }
  if (sentence?.qualityScore !== null && sentence?.qualityScore !== undefined) {
    parts.push(`Quality ${Math.round(sentence.qualityScore * 100)}%`);
  }
  if (sentence?.flags?.length) {
    parts.push(sentence.flags.join(", "));
  }
  return parts;
}

function sentenceDetailMarkup(sentence) {
  const meta = formatRefineSentenceMeta(sentence);
  const sourceLabel = sentence.source?.patchId ? `Patch ${sentence.source.patchId}` : sentence.source?.type ?? "ocr";
  const wordCount = sentence.characterIds?.length ?? 0;
  return `
    <div class="refine-detail">
      <div class="refine-detail-header">
        <div>
          <p class="refine-kicker">Selected sentence</p>
          <h3>${escapeHtml(sentence.text)}</h3>
        </div>
        <span class="status-pill ${sentenceStatusClass(sentence)}">${sentenceStatusLabel(sentence)}</span>
      </div>
      <p><span class="label">Segment</span>${escapeHtml(sentence.segmentId)}</p>
      <p><span class="label">Sentence ID</span>${escapeHtml(sentence.id)}</p>
      <p><span class="label">Source</span>${escapeHtml(sourceLabel)}</p>
      <p><span class="label">Characters</span>${escapeHtml(String(wordCount))}</p>
      <p><span class="label">Pinyin</span>${escapeHtml(sentence.pinyin || "Pending")}</p>
      <p><span class="label">Meaning</span>${escapeHtml(sentence.translation || "Pending")}</p>
      <p><span class="label">Flags</span>${escapeHtml(meta.length > 0 ? meta.join(" · ") : "None")}</p>
    </div>
  `;
}

function patchDetailMarkup(patch) {
  return `
    <div class="refine-activity refine-patch-detail">
      <p class="refine-kicker">Focused patch context</p>
      <p><span class="label">Patch ID</span>${escapeHtml(patch.patch_id)}</p>
      <p><span class="label">Segment</span>${escapeHtml(patch.segmentId)}</p>
      <p><span class="label">Anchor</span>${escapeHtml(patchAnchorLabel(patch))}</p>
      <p><span class="label">Transcript</span>${escapeHtml(patchTranscript(patch))}</p>
      <p><span class="label">OCR Candidate</span>${escapeHtml(patch.ocr_candidate || "Pending")}</p>
      <p><span class="label">Notes</span>${escapeHtml(patch.notes || "None")}</p>
    </div>
  `;
}

function draftPatchDetailMarkup(draftPatch, sentenceOptions) {
  const draftTitle = draftPatch.segmentId || "New patch";
  const anchorMode = draftPatch.anchorMode
    ?? (draftPatch.anchor?.insert_before_sentence_id
      ? "before"
      : draftPatch.anchor?.insert_after_sentence_id
        ? "after"
        : "append");
  const anchorSentenceId = draftPatch.anchor?.insert_before_sentence_id
    ?? draftPatch.anchor?.insert_after_sentence_id
    ?? "";
  const boundaryButtonLabel = state.draftBoundaryMode ? "Finish boundary" : "Start boundary drawing";
  const anchorPickValue = state.draftAnchorPickMode ? "__pick_from_page__" : anchorSentenceId;

  return `
    <div class="refine-activity refine-draft-detail">
      <div class="refine-detail-header">
        <div>
          <p class="refine-kicker">Create Patch</p>
          <h3>${escapeHtml(draftTitle)}</h3>
        </div>
        <span class="status-pill active">Local draft</span>
      </div>
      <p><span class="label">Anchor</span>${escapeHtml(patchAnchorDraftLabel(draftPatch.anchor, anchorMode))}</p>
      <p><span class="label">Status</span>${escapeHtml(draftPatchStatusText(draftPatch))}</p>
      <div class="field">
        <span class="label">Reading Direction</span>
        <select data-draft-field="text-flow-mode">
          <option value="vertical_rl" ${draftPatch.text_flow.mode === "vertical_rl" ? "selected" : ""}>Vertical Right-to-Left</option>
          <option value="horizontal_ltr" ${draftPatch.text_flow.mode === "horizontal_ltr" ? "selected" : ""}>Horizontal Left-to-Right</option>
        </select>
      </div>
      <div class="field">
        <span class="label">Anchor Mode</span>
        <select data-draft-field="anchor-mode">
          <option value="after" ${anchorMode === "after" ? "selected" : ""}>After sentence</option>
          <option value="before" ${anchorMode === "before" ? "selected" : ""}>Before sentence</option>
          <option value="append" ${anchorMode === "append" ? "selected" : ""}>Append at end</option>
        </select>
      </div>
      <div class="field">
        <span class="label">Anchor Sentence</span>
        <select data-draft-field="anchor-sentence" ${anchorMode === "append" ? "disabled" : ""}>
          <option value="__pick_from_page__" ${anchorPickValue === "__pick_from_page__" ? "selected" : ""}>I'll select from the page</option>
          <option value="">Select sentence</option>
          ${sentenceOptions}
        </select>
      </div>
      <label class="field">
        <span class="label">Accepted Transcript</span>
        <textarea data-draft-field="user-transcript" rows="3" placeholder="Enter the missing text">${escapeHtml(draftPatch.user_transcript ?? "")}</textarea>
      </label>
      <label class="field">
        <span class="label">Notes</span>
        <textarea data-draft-field="notes" rows="2" placeholder="Optional notes">${escapeHtml(draftPatch.notes ?? "")}</textarea>
      </label>
      <div class="draft-actions">
        <button class="draft-button" type="button" data-draft-action="toggle-boundary">${boundaryButtonLabel}</button>
        <button class="draft-button" type="button" data-draft-action="undo-point" ${draftPatch.region?.polygon?.length ? "" : "disabled"}>Undo point</button>
        <button class="draft-button" type="button" data-draft-action="clear-region" ${draftPatch.region?.polygon?.length ? "" : "disabled"}>Clear region</button>
        <button class="draft-button" type="button" data-draft-action="cancel">Cancel draft</button>
        <button class="draft-button primary" type="button" data-draft-action="process">Process patch</button>
      </div>
    </div>
  `;
}

function renderRefineSentenceCard(sentence) {
  const key = sentenceKey(sentence.segmentId, sentence.id);
  const active = key === state.activeSentenceKey ? "active" : "";
  const statusClass = sentenceStatusClass(sentence);
  const meta = formatRefineSentenceMeta(sentence);
  const actionLabel = sentenceStatusLabel(sentence) === "Deleted" ? "Restore sentence" : "Delete sentence";
  const actionIcon = sentenceStatusLabel(sentence) === "Deleted" ? "↩" : "🗑";
  const action = sentenceStatusLabel(sentence) === "Deleted" ? "restore" : "delete";

  return `
    <article class="refine-sentence ${active} ${statusClass}" data-sentence-key="${escapeHtml(key)}">
      <button class="refine-sentence-body" type="button" data-sentence-key="${escapeHtml(key)}">
        <span class="refine-sentence-text">${escapeHtml(sentence.text)}</span>
        <span class="refine-sentence-meta">
          ${escapeHtml(sentence.id)}
          ${meta.length > 0 ? ` · ${escapeHtml(meta.join(" · "))}` : ""}
        </span>
      </button>
      <div class="refine-sentence-controls">
        <span class="status-pill ${statusClass}">${escapeHtml(sentenceStatusLabel(sentence))}</span>
        <button
          class="refine-sentence-action"
          type="button"
          data-action="${escapeHtml(action)}"
          data-sentence-key="${escapeHtml(key)}"
          aria-label="${escapeHtml(actionLabel)}"
          title="${escapeHtml(actionLabel)}"
        >${actionIcon}</button>
      </div>
    </article>
  `;
}

function renderRefinePatchCard(patch) {
  const active = patch.patch_id === state.activePatchId ? "active" : "";
  const actionLabel = `Delete patch ${patch.patch_id}`;

  return `
    <article class="refine-patch ${active}" data-patch-id="${escapeHtml(patch.patch_id)}">
      <button class="refine-patch-body" type="button" data-patch-id="${escapeHtml(patch.patch_id)}">
        <span class="refine-patch-title">${escapeHtml(patch.patch_id)}</span>
        <span class="refine-patch-meta">${escapeHtml(patch.segmentId)} · ${escapeHtml(patchAnchorLabel(patch))}</span>
        <span class="refine-patch-body-text">${escapeHtml(patchTranscript(patch))}</span>
      </button>
      <div class="refine-patch-controls">
        <button
          class="refine-patch-action"
          type="button"
          data-patch-id="${escapeHtml(patch.patch_id)}"
          aria-label="${escapeHtml(actionLabel)}"
          title="${escapeHtml(actionLabel)}"
        >🗑</button>
      </div>
    </article>
  `;
}

function renderRefinePanel() {
  const refineModel = state.refineModel;
  const sidebarMode = state.refineSidebarMode ?? "view";
  const isCreateMode = sidebarMode === "create";
  const annotations = currentAnnotations();
  const currentPatch = refinePatchForId(state.activePatchId ?? "");
  const draftPatch = state.draftPatch;
  const currentSentence = currentPatch
    ? null
    : (refineSentenceRecordForKey(state.activeSentenceKey ?? "") ?? sentenceRecordForKey(state.activeSentenceKey ?? "", annotations));
  const sentences = refineModel?.sentences ?? [];
  const visibleSentenceKeys = state.visibleSentenceKeys.size > 0 ? state.visibleSentenceKeys : new Set(collectVisibleSentenceKeys());
  const visibleSentences = [];
  for (const segment of refineModel?.segments ?? []) {
    for (const sentence of annotations.get(segment.id)?.sentences ?? []) {
      const key = sentenceKey(sentence.segmentId, sentence.id);
      if (visibleSentenceKeys.has(key)) {
        visibleSentences.push(sentence);
      }
    }
  }

  const deletedCount = sentences.filter((sentence) => (sentence.status ?? "active") === "deleted").length;
  const patchCount = refineModel?.patches?.length ?? 0;
  const sentenceOptions = (refineModel?.sentences ?? [])
    .filter((sentence) => (sentence.status ?? "active") !== "deleted")
    .map((sentence) => {
      const anchorSentenceId = draftPatch?.anchor?.insert_before_sentence_id
        ?? draftPatch?.anchor?.insert_after_sentence_id
        ?? "";
      const selected = sentence.id === anchorSentenceId ? "selected" : "";
      return `<option value="${escapeHtml(sentence.id)}" ${selected}>${escapeHtml(`${sentence.segmentId} · ${sentence.id} · ${sentence.text}`)}</option>`;
    })
    .join("");

  const draftMarkup = draftPatch
    ? draftPatchDetailMarkup(draftPatch, sentenceOptions)
    : `
      <div class="refine-activity refine-draft-empty">
        <p class="refine-kicker">Create Patch</p>
        <p class="empty">Start a local patch draft, then draw the missing-text boundary directly on the page.</p>
      </div>
    `;

  const visibleSections = visibleSentences.length > 0
    ? (refineModel?.segments ?? [])
      .map((segment) => {
        const segmentSentences = (annotations.get(segment.id)?.sentences ?? []).filter((sentence) => {
          const key = sentenceKey(sentence.segmentId, sentence.id);
          return visibleSentenceKeys.has(key);
        });
        if (segmentSentences.length === 0) {
          return "";
        }

        return `
          <section class="refine-section">
            <div class="refine-section-header">
              <h3>Visible Sentences</h3>
              <span>${escapeHtml(String(segmentSentences.length))} visible</span>
            </div>
            <div class="refine-sentence-list">
              ${segmentSentences.map((sentence) => renderRefineSentenceCard(sentence)).join("")}
            </div>
          </section>
        `;
      })
      .join("")
    : `
      <div class="refine-empty-state">
        <h3>Visible sentences</h3>
        <p class="empty">Scroll the chapter to reveal sentences for the refine list.</p>
      </div>
    `;

  const patchList = (refineModel?.patches ?? []).length > 0
    ? `
      <section class="refine-section">
        <div class="refine-section-header">
          <h3>Patches</h3>
          <span>${escapeHtml(String(patchCount))}</span>
        </div>
        <div class="refine-patch-list">
          ${(refineModel?.patches ?? []).map((patch) => renderRefinePatchCard(patch)).join("")}
        </div>
      </section>
    `
    : "";

  const detailMarkup = isCreateMode
    ? draftMarkup
    : currentPatch
      ? patchDetailMarkup(currentPatch)
    : currentSentence
      ? sentenceDetailMarkup(currentSentence)
      : "";

  const viewSectionMarkup = `
    <section class="refine-workspace">
      <div class="refine-workspace-header">
        <div>
          <h3>View Sentences + Patches</h3>
        </div>
      </div>
      <div class="refine-summary">
        <p><span class="label">Segments</span>${escapeHtml(String(refineModel?.segments?.length ?? 0))}</p>
        <p><span class="label">Sentences</span>${escapeHtml(String(sentences.length))}</p>
        <p><span class="label">Deleted</span>${escapeHtml(String(deletedCount))}</p>
        <p><span class="label">Patches</span>${escapeHtml(String(patchCount))}</p>
      </div>
      ${detailMarkup}
      <section class="refine-visible">
        ${visibleSections}
      </section>
      ${patchList}
      <div class="refine-workspace-actions">
        <button class="draft-button primary" type="button" data-refine-action="enter-create">Create a New Patch</button>
      </div>
    </section>
  `;

  const createSectionMarkup = `
    <section class="refine-workspace refine-workspace-create">
      <div class="refine-workspace-header">
        <div>
          <h3>Create Patch</h3>
        </div>
      </div>
      ${draftMarkup}
      <div class="refine-workspace-actions">
        <button class="draft-button" type="button" data-refine-action="enter-view">Back to Sentences + Patches</button>
      </div>
    </section>
  `;

  elements.refinePanel.innerHTML = `
    <h2>Refine</h2>
    <p class="empty">Inspect annotation quality, deleted sentences, and patch-ready chapter state.</p>
    ${isCreateMode ? createSectionMarkup : viewSectionMarkup}
  `;
}

function sentenceLocationElement(sentenceKey) {
  return elements.chapterStack.querySelector(`.hotspot[data-sentence-key="${CSS.escape(sentenceKey)}"]`);
}

function sentenceCardElement(sentenceKey) {
  return elements.refinePanel.querySelector(`.refine-sentence[data-sentence-key="${CSS.escape(sentenceKey)}"]`);
}

function patchCardElement(patchId) {
  return elements.refinePanel.querySelector(`.refine-patch[data-patch-id="${CSS.escape(patchId)}"]`);
}

function scrollElementIntoView(element) {
  if (element) {
    element.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
  }
}

function scrollSentenceHotspotIntoView(sentenceKey) {
  scrollElementIntoView(sentenceLocationElement(sentenceKey));
}

function scrollSentenceCardIntoView(sentenceKey) {
  scrollElementIntoView(sentenceCardElement(sentenceKey));
}

function scrollPatchCardIntoView(patchId) {
  scrollElementIntoView(patchCardElement(patchId));
}

function focusSentence(sentenceKey, { scrollPage = true, scrollSidebar = true } = {}) {
  if (!sentenceKey) {
    return;
  }

  state.activePatchId = null;
  state.activeSentenceKey = sentenceKey;
  state.hoveredWordKey = null;
  renderModePanels();
  renderInteractionState();
  queueViewportAnchorSync();

  requestAnimationFrame(() => {
    if (scrollPage) {
      scrollSentenceHotspotIntoView(sentenceKey);
    }
    if (scrollSidebar) {
      scrollSentenceCardIntoView(sentenceKey);
    }
    requestAnimationFrame(() => {
      renderInteractionState();
    });
  });
}

function focusPatch(patchId, { scrollSidebar = false } = {}) {
  if (!patchId) {
    return;
  }

  enterRefineViewMode({ preserveDraft: true, rerenderPanel: false, rerenderInteraction: false });
  state.activePatchId = patchId;
  state.activeSentenceKey = null;
  state.hoveredWordKey = null;
  renderModePanels();
  renderInteractionState();
  queueViewportAnchorSync();

  requestAnimationFrame(() => {
    if (scrollSidebar) {
      scrollPatchCardIntoView(patchId);
    }
    requestAnimationFrame(() => {
      renderInteractionState();
    });
  });
}

function updateDraftPatch(updater, { rerenderPanel = true, rerenderInteraction = true } = {}) {
  if (!state.draftPatch) {
    return;
  }

  state.draftPatch = updater(JSON.parse(JSON.stringify(state.draftPatch)));
  if (rerenderPanel) {
    renderModePanels();
  }
  if (rerenderInteraction) {
    renderInteractionState();
  }
}

function cancelDraftPatch() {
  state.draftPatch = null;
  enterRefineViewMode({ preserveDraft: false });
}

function enterRefineViewMode({ preserveDraft = true, rerenderPanel = true, rerenderInteraction = true } = {}) {
  state.refineSidebarMode = "view";
  state.draftBoundaryMode = false;
  state.draftAnchorPickMode = false;
  if (!preserveDraft) {
    state.draftPatch = null;
  }
  if (rerenderPanel) {
    renderModePanels();
  }
  if (rerenderInteraction) {
    renderInteractionState();
  }
}

function enterRefineCreateMode({ ensureDraft = true } = {}) {
  if (state.mode !== "refine") {
    return;
  }

  state.refineSidebarMode = "create";
  if (ensureDraft && !state.draftPatch) {
    state.draftPatch = createEmptyDraftPatch();
  }
  state.draftBoundaryMode = false;
  state.draftAnchorPickMode = false;
  state.hoveredWordKey = null;
  renderModePanels();
  renderInteractionState();
}

function updateDraftAnchor(mode, sentenceId) {
  state.draftAnchorPickMode = false;
  updateDraftPatch((draftPatch) => {
    if (mode === "before") {
      draftPatch.anchorMode = "before";
      draftPatch.anchor = {
        insert_before_sentence_id: sentenceId || null,
        insert_after_sentence_id: null,
      };
    } else if (mode === "append") {
      draftPatch.anchorMode = "append";
      draftPatch.anchor = {
        insert_before_sentence_id: null,
        insert_after_sentence_id: null,
      };
    } else {
      draftPatch.anchorMode = "after";
      draftPatch.anchor = {
        insert_before_sentence_id: null,
        insert_after_sentence_id: sentenceId || null,
      };
    }
    return draftPatch;
  });
}

function toggleDraftBoundaryMode() {
  if (!state.draftPatch) {
    return;
  }

  if (state.draftBoundaryMode) {
    if ((state.draftPatch.region?.polygon?.length ?? 0) < 3) {
      throw new Error("Add at least three points before finishing the boundary.");
    }
    updateDraftPatch((draftPatch) => ({
      ...draftPatch,
      text_flow: {
        ...draftPatch.text_flow,
        guide: autoGuideForPolygon(draftPatch.region?.polygon ?? [], draftPatch.text_flow.mode),
      },
    }));
    state.draftBoundaryMode = false;
    renderModePanels();
    renderInteractionState();
    return;
  }

  state.draftBoundaryMode = true;
  state.draftAnchorPickMode = false;
  renderModePanels();
  renderInteractionState();
}

function appendDraftBoundaryPoint(segmentId, point) {
  if (!state.draftPatch) {
    return;
  }

  updateDraftPatch((draftPatch) => {
    const nextSegmentId = draftPatch.segmentId ?? segmentId;
    if (draftPatch.segmentId && draftPatch.segmentId !== segmentId) {
      throw new Error("Finish or clear the current boundary before drawing on a different segment.");
    }

    const nextPolygon = [...(draftPatch.region?.polygon ?? []), point];
    return {
      ...draftPatch,
      segmentId: nextSegmentId,
      sourcePageId: sourcePageIdForSegmentId(nextSegmentId),
      region: {
        polygon: nextPolygon,
      },
      text_flow: {
        ...draftPatch.text_flow,
        guide: nextPolygon.length >= 3
          ? autoGuideForPolygon(nextPolygon, draftPatch.text_flow.mode)
          : [],
      },
    };
  });
}

function undoDraftBoundaryPoint() {
  if (!state.draftPatch) {
    return;
  }

  updateDraftPatch((draftPatch) => {
    const nextPolygon = (draftPatch.region?.polygon ?? []).slice(0, -1);
    return {
      ...draftPatch,
      segmentId: nextPolygon.length > 0 ? draftPatch.segmentId : null,
      sourcePageId: nextPolygon.length > 0 ? draftPatch.sourcePageId : null,
      region: {
        polygon: nextPolygon,
      },
      text_flow: {
        ...draftPatch.text_flow,
        guide: nextPolygon.length >= 3
          ? autoGuideForPolygon(nextPolygon, draftPatch.text_flow.mode)
          : [],
      },
    };
  });
}

function clientPointToNormalizedPoint(event, frame) {
  const rect = frame.getBoundingClientRect();
  const x = (event.clientX - rect.left) / rect.width;
  const y = 1 - ((event.clientY - rect.top) / rect.height);
  return {
    x: Math.min(1, Math.max(0, x)),
    y: Math.min(1, Math.max(0, y)),
  };
}

function addDraftBoundaryPoint(event, frame) {
  if (state.mode !== "refine" || state.refineSidebarMode !== "create" || !state.draftPatch || !state.draftBoundaryMode) {
    return;
  }

  event.preventDefault();
  appendDraftBoundaryPoint(frame.dataset.segmentId, clientPointToNormalizedPoint(event, frame));
}

async function processDraftPatch() {
  if (state.mode !== "refine" || !state.draftPatch || !state.currentChapter) {
    return;
  }

  if (!state.draftPatch.region?.polygon?.length) {
    throw new Error("Draw a patch region before processing.");
  }
  if (!state.draftPatch.user_transcript.trim()) {
    throw new Error("Add the accepted transcript before processing.");
  }

  const imagePath = imagePathForSegmentId(state.draftPatch.segmentId);
  const pageId = sourcePageIdForSegmentId(state.draftPatch.segmentId);
  if (!imagePath || !pageId) {
    throw new Error("Could not resolve the draft patch segment.");
  }

  const reviewPatches = (state.refineModel?.patches ?? [])
    .map((patch) => reviewPatchFromRefinePatch(patch))
    .filter(Boolean);
  const draftPatch = {
    ...state.draftPatch,
    page_id: pageId,
  };

  const response = await fetch("/api/process-patch", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      series: state.currentChapter.series,
      chapter: state.currentChapter.chapter,
      imagePath,
      patch: draftPatch,
      patches: reviewPatches,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || `Could not process draft patch ${draftPatch.patch_id}.`);
  }

  const payload = await response.json();
  const nextPatchId = payload.patch?.patch_id ?? draftPatch.patch_id;
  const scrollTop = window.scrollY;
  cancelDraftPatch();
  invalidateChapterCaches(state.currentChapter.series, state.currentChapter.chapter);
  await loadChapterFromApi(state.currentChapter.series, state.currentChapter.chapter, {
    preferredMode: "refine",
    activeSentenceKey: null,
    activePatchId: nextPatchId,
    preservePosition: true,
    restoreScrollTop: scrollTop,
    forceModes: ["read", "refine"],
  });
}

async function mutateSentenceStatus(sentenceKey, status) {
  if (state.mode !== "refine") {
    return;
  }

  const parts = splitSentenceKey(sentenceKey);
  const sentence = refineSentenceRecordForKey(sentenceKey);
  const currentChapter = state.currentChapter;
  if (!parts || !sentence || !currentChapter) {
    return;
  }

  state.activeSentenceKey = sentenceKey;
  state.activePatchId = null;
  renderModePanels();
  renderInteractionState();

  const endpoint = status === "deleted" ? "/api/delete-sentence" : "/api/restore-sentence";
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      series: currentChapter.series,
      chapter: currentChapter.chapter,
      segmentId: parts.segmentId,
      sentenceId: sentence.id,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || `Could not ${status === "deleted" ? "delete" : "restore"} sentence.`);
  }

  const currentSelection = sentenceKey;
  const scrollTop = window.scrollY;
  invalidateChapterCaches(currentChapter.series, currentChapter.chapter);

  await loadChapterFromApi(currentChapter.series, currentChapter.chapter, {
    preferredMode: "refine",
    activeSentenceKey: currentSelection,
    activePatchId: null,
    preservePosition: true,
    restoreScrollTop: scrollTop,
    forceModes: ["refine"],
  });
}

async function mutatePatchDelete(patchId) {
  if (state.mode !== "refine") {
    return;
  }

  const patch = refinePatchForId(patchId);
  const currentChapter = currentModel();
  if (!patch || !currentChapter) {
    return;
  }

  state.activePatchId = patchId;
  state.activeSentenceKey = null;
  renderModePanels();
  renderInteractionState();

  const response = await fetch("/api/delete-patch", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      series: currentChapter.series,
      chapter: currentChapter.chapter,
      patchId: patch.patch_id,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || `Could not delete patch ${patch.patch_id}.`);
  }
  const scrollTop = window.scrollY;
  invalidateChapterCaches(currentChapter.series, currentChapter.chapter);

  await loadChapterFromApi(currentChapter.series, currentChapter.chapter, {
    preferredMode: "refine",
    activeSentenceKey: null,
    activePatchId: null,
    preservePosition: true,
    restoreScrollTop: scrollTop,
    forceModes: ["refine"],
  });
}

function renderModePanels() {
  const isRead = state.mode === "read";
  elements.wordPanel.hidden = !isRead;
  elements.sentencePanel.hidden = !isRead;
  elements.notesPanel.hidden = !isRead;
  elements.refinePanel.hidden = isRead;

  if (isRead) {
    if (!state.hoveredWordKey && !state.activeSentenceKey) {
      renderEmptyPanels();
    }
    if (elements.notesPanel.classList.contains("expanded")) {
      renderNotesPanel();
    } else {
      renderEmptyNotesPanel();
    }
  } else {
    renderRefinePanel();
  }
}

async function setMode(nextMode, { preservePosition = true } = {}) {
  if (!state.currentChapter) {
    return;
  }

  const anchor = preservePosition ? captureTopVisibleSentenceAnchor() : null;
  state.hoveredWordKey = null;
  hideHoverTooltip();
  await loadChapterFromApi(state.currentChapter.series, state.currentChapter.chapter, {
    preferredMode: nextMode,
    activeSentenceKey: null,
    activePatchId: null,
    preservePosition,
    positionAnchor: anchor,
  });
}

function updateWordPanel(word) {
  if (!word) {
    return;
  }

  elements.wordPanel.innerHTML = panelMarkup("Word", [
    { label: "Chinese", value: escapeHtml(word.text) },
    { label: "Pinyin", value: escapeHtml(word.pinyin || "Pending") },
    { label: "Meaning", value: escapeHtml(word.translation || "Pending") },
  ]);
}

function updateSentencePanel(sentence) {
  if (!sentence) {
    return;
  }

  const sentenceNotes = [...(sentence.notes ?? [])];
  if (sentence.ocrText && sentence.text && sentence.ocrText !== sentence.text) {
    sentenceNotes.unshift(`Original OCR: ${sentence.ocrText}`);
  }

  elements.sentencePanel.innerHTML = panelMarkup("Sentence", [
    { label: "Chinese", value: escapeHtml(sentence.text) },
    { label: "Pinyin", value: escapeHtml(sentence.pinyin || "Pending") },
    { label: "Meaning", value: escapeHtml(sentence.translation || "Pending") },
    { label: "Grammar", value: escapeHtml(sentence.grammarNotes || "") },
    { label: "Notes", value: escapeHtml(sentenceNotes.join(" ")) },
  ]);
}

function renderNotesPanel() {
  const notes = currentModel()?.chapterNotes ?? [];
  if (notes.length === 0) {
    renderEmptyNotesPanel();
    return;
  }

  elements.notesBody.innerHTML = `
    <div class="notes-list">
      ${notes.map((note) => `<p>${escapeHtml(note)}</p>`).join("")}
    </div>
  `;
}

function setNotesExpanded(expanded) {
  elements.notesPanel.classList.toggle("expanded", expanded);
  elements.notesPanel.setAttribute("aria-hidden", expanded ? "false" : "true");
  elements.notesToggle.setAttribute("aria-expanded", expanded ? "true" : "false");
  elements.notesToggle.querySelector(".notes-toggle-state").textContent = expanded ? "Hide" : "Show";
  if (expanded && elements.notesBody.innerHTML.trim().length === 0) {
    renderNotesPanel();
  }
}

function refreshPanelsFromSelection() {
  if (state.mode !== "read") {
    return;
  }

  if (state.hoveredWordKey) {
    for (const [segmentId, annotation] of state.annotations.entries()) {
      const word = annotation.words.find((candidate) => wordKey(segmentId, candidate.id) === state.hoveredWordKey);
      if (word) {
        updateWordPanel(word);
        break;
      }
    }
  } else {
    elements.wordPanel.innerHTML = `<h2>Word</h2><p class="empty">Hover a character.</p>`;
  }

  if (state.activeSentenceKey) {
    const separatorIndex = state.activeSentenceKey.indexOf(":");
    if (separatorIndex !== -1) {
      const segmentId = state.activeSentenceKey.slice(0, separatorIndex);
      const sentenceId = state.activeSentenceKey.slice(separatorIndex + 1);
      const annotation = state.annotations.get(segmentId);
      const sentence = annotation?.sentences.find((candidate) => candidate.id === sentenceId);
      if (sentence) {
        updateSentencePanel(sentence);
        return;
      }
    }
  }

  elements.sentencePanel.innerHTML = `<h2>Sentence</h2><p class="empty">Click a character.</p>`;
}

function updateFocusOverlays() {
  for (const frame of elements.chapterStack.querySelectorAll(".page-frame")) {
    const segmentId = frame.dataset.segmentId;
    const annotation = state.annotations.get(segmentId);
    if (!annotation) {
      continue;
    }

    const charactersById = mapById(annotation.characters);

    const wordFocus = frame.querySelector(".word-focus");
    if (state.mode === "read") {
      const activeWord = annotation.words.find((word) => wordKey(segmentId, word.id) === state.hoveredWordKey);
      if (wordFocus && activeWord?.characterIds?.length) {
        const wordPolygons = activeWord.characterIds
          .map((id) => charactersById.get(id)?.polygon)
          .filter(Boolean);
        const geometry = boundsStyleFromPolygons(wordPolygons, 0.003, 0);
        if (geometry) {
          wordFocus.dataset.wordKey = wordKey(segmentId, activeWord.id);
          applyGeometry(wordFocus, geometry);
        }
      } else if (wordFocus) {
        wordFocus.dataset.wordKey = "";
        applyGeometry(wordFocus, { left: "0%", top: "0%", width: "0%", height: "0%" });
      }
    } else if (wordFocus) {
      wordFocus.dataset.wordKey = "";
      applyGeometry(wordFocus, { left: "0%", top: "0%", width: "0%", height: "0%" });
    }

    const sentenceFocus = frame.querySelector(".sentence-focus");
    const activeSentence = annotation.sentences.find(
      (sentence) => sentenceKey(segmentId, sentence.id) === state.activeSentenceKey,
    );

    if (sentenceFocus && activeSentence) {
      const polygon = sentencePolygon(activeSentence, charactersById);
      const geometry = polygon ? boundsStyleFromPolygons([polygon], 0.012, 0) : null;
      if (geometry) {
        sentenceFocus.dataset.sentenceKey = sentenceKey(segmentId, activeSentence.id);
        applyGeometry(sentenceFocus, geometry);
      }
    } else if (sentenceFocus) {
      sentenceFocus.dataset.sentenceKey = "";
      applyGeometry(sentenceFocus, { left: "0%", top: "0%", width: "0%", height: "0%" });
    }

    const patchFocus = frame.querySelector(".patch-focus");
    const activePatch = state.activePatchId ? refinePatchForId(state.activePatchId) : null;
    if (patchFocus && activePatch?.segmentId === segmentId && activePatch.region?.polygon?.length) {
      const geometry = boundsStyleFromPolygons([activePatch.region.polygon], 0.012, 0);
      if (geometry) {
        patchFocus.dataset.patchId = activePatch.patch_id;
        applyGeometry(patchFocus, geometry);
      }
    } else if (patchFocus) {
      patchFocus.dataset.patchId = "";
      applyGeometry(patchFocus, { left: "0%", top: "0%", width: "0%", height: "0%" });
    }

    const draftFocus = frame.querySelector(".draft-focus");
    const draftPatch = state.refineSidebarMode === "create" ? state.draftPatch : null;
    const overlay = frame.querySelector(".overlay");
    if (overlay) {
      renderDraftPoints(overlay, draftPatch, segmentId);
    }
    if (draftFocus && draftPatch?.segmentId === segmentId && draftPatch.region?.polygon?.length) {
      const geometry = draftPatchGeometry(draftPatch);
      if (geometry) {
        draftFocus.dataset.draftPatchId = draftPatch.patch_id;
        applyGeometry(draftFocus, geometry);
      }
    } else if (draftFocus) {
      draftFocus.dataset.draftPatchId = "";
      applyGeometry(draftFocus, { left: "0%", top: "0%", width: "0%", height: "0%" });
    }
  }
}

function renderInteractionState() {
  updateFocusOverlays();

  for (const focus of elements.chapterStack.querySelectorAll(".word-focus")) {
    focus.classList.toggle("visible", state.mode === "read" && focus.dataset.wordKey === state.hoveredWordKey);
  }

  for (const focus of elements.chapterStack.querySelectorAll(".sentence-focus")) {
    focus.classList.toggle("visible", state.mode === "refine"
      ? state.refineSidebarMode === "view" && focus.dataset.sentenceKey === state.activeSentenceKey
      : focus.dataset.sentenceKey === state.activeSentenceKey);
  }

  for (const focus of elements.chapterStack.querySelectorAll(".patch-focus")) {
    focus.classList.toggle("visible", state.mode === "refine"
      ? state.refineSidebarMode === "view" && focus.dataset.patchId === state.activePatchId
      : focus.dataset.patchId === state.activePatchId);
  }

  for (const focus of elements.chapterStack.querySelectorAll(".draft-focus")) {
    focus.classList.toggle("visible", state.mode === "refine"
      && state.refineSidebarMode === "create"
      && focus.dataset.draftPatchId === draftPatchKey());
  }
}

function clearInteractionState() {
  state.hoveredWordKey = null;
  state.activeSentenceKey = null;
  state.activePatchId = null;
  if (hoverIntentTimer) {
    clearTimeout(hoverIntentTimer);
    hoverIntentTimer = null;
  }
  hideHoverTooltip();
  if (state.mode === "refine") {
    state.draftBoundaryMode = false;
    state.draftAnchorPickMode = false;
    renderModePanels();
    renderInteractionState();
    return;
  }

  state.refineSidebarMode = "view";
  state.draftPatch = null;
  state.draftBoundaryMode = false;
  state.draftAnchorPickMode = false;
  if (state.mode === "read") {
    renderEmptyPanels();
  } else {
    renderModePanels();
  }
  renderInteractionState();
}

function clearReadSelection() {
  if (state.mode !== "read") {
    return;
  }

  clearInteractionState();
}

function renderChapterPanel() {
  const chapterOptions = state.chapterIndex.length > 0
    ? state.chapterIndex
      .map((chapter) => {
        const value = `${chapter.series}::${chapter.chapter}`;
        const selected = chapter.series === state.currentChapter?.series && chapter.chapter === state.currentChapter?.chapter;
        const capabilityLabel = chapter.hasReadModel && chapter.hasRefineData
          ? ""
          : chapter.hasReadModel
            ? " (read only)"
            : chapter.hasRefineData
              ? " (refine only)"
              : " (unavailable)";
        return `<option value="${escapeHtml(value)}" ${selected ? "selected" : ""} ${chapter.hasReadModel || chapter.hasRefineData ? "" : "disabled"}>${escapeHtml(`${chapter.title}${capabilityLabel}`)}</option>`;
      })
      .join("")
    : "";

  const pickerMarkup = chapterOptions
    ? `
      <label class="field">
        <span class="label">Chapter Picker</span>
        <select id="chapterSelect">${chapterOptions}</select>
      </label>
    `
    : "";

  elements.chapterPanel.innerHTML = `
    <h2>Chapter</h2>
    ${pickerMarkup}
    ${state.modeNotice ? `<p class="empty">${escapeHtml(state.modeNotice)}</p>` : ""}
    <p><span class="label">Title</span>${escapeHtml(chapterTitle())}</p>
    <p><span class="label">Series</span>${escapeHtml(state.currentChapter?.series ?? "")}</p>
    <p><span class="label">Chapter</span>${escapeHtml(state.currentChapter?.chapter ?? "")}</p>
    <p><span class="label">Mode</span>${escapeHtml(state.mode)}</p>
  `;

  const chapterSelect = elements.chapterPanel.querySelector("#chapterSelect");
  if (chapterSelect) {
    chapterSelect.addEventListener("change", async (event) => {
      const [series, chapter] = String(event.target.value).split("::");
      if (!series || !chapter) {
        return;
      }
      await loadChapterFromApi(series, chapter, {
        preferredMode: state.mode,
        activeSentenceKey: null,
        activePatchId: null,
        preservePosition: false,
      });
    });
  }
}

function buildSegmentFrame(segment) {
  const annotation = state.annotations.get(segment.id);
  if (!annotation) {
    return null;
  }

  const wordsById = mapById(annotation.words);
  const sentencesById = mapById(annotation.sentences);
  const charactersById = mapById(annotation.characters);

  const frame = document.createElement("section");
  frame.className = "page-frame";
  frame.dataset.segmentId = segment.id;

  const canvas = document.createElement("div");
  canvas.className = "page-canvas";

  const image = document.createElement("img");
  image.className = "page-image";
  image.alt = "Chapter image";
  image.src = imagePath(segment.image);

  const overlay = document.createElement("div");
  overlay.className = "overlay";

  const wordFocus = document.createElement("div");
  wordFocus.className = "word-focus";
  overlay.appendChild(wordFocus);

  const sentenceFocus = document.createElement("div");
  sentenceFocus.className = "sentence-focus";
  overlay.appendChild(sentenceFocus);

  const patchFocus = document.createElement("div");
  patchFocus.className = "patch-focus";
  overlay.appendChild(patchFocus);

  const draftFocus = document.createElement("div");
  draftFocus.className = "draft-focus";
  overlay.appendChild(draftFocus);

  const readInteractionsEnabled = state.mode === "read";
  const draftInteractionsEnabled =
    state.mode === "refine"
    && state.refineSidebarMode === "create"
    && state.draftBoundaryMode
    && (!state.draftPatch?.segmentId || state.draftPatch.segmentId === segment.id);

  if (draftInteractionsEnabled) {
    frame.classList.add("draft-target");
    canvas.addEventListener("click", (event) => {
      addDraftBoundaryPoint(event, frame);
    });
  }

  for (const character of annotation.characters) {
    const currentWord = wordsById.get(character.wordId);
    if (isPunctuationOnly(currentWord?.text ?? character.text)) {
      continue;
    }

    const hotspot = document.createElement("button");
    hotspot.className = "hotspot";
    hotspot.type = "button";
    applyGeometry(hotspot, polygonToStyle(character.polygon ?? []));
    hotspot.dataset.wordKey = wordKey(segment.id, character.wordId);
    hotspot.dataset.sentenceKey = sentenceKey(segment.id, character.sentenceId);

    if (readInteractionsEnabled) {
      hotspot.addEventListener("mouseenter", (event) => {
        const nextWordKey = wordKey(segment.id, character.wordId);
        if (hoverIntentTimer) {
          clearTimeout(hoverIntentTimer);
        }

        hoverIntentTimer = setTimeout(() => {
          hoverIntentTimer = null;
          state.hoveredWordKey = nextWordKey;
          updateWordPanel(currentWord);
          showHoverTooltip(tooltipForWord(currentWord, character.text), event.clientX, event.clientY);
          renderInteractionState();
        }, 100);
      });

      hotspot.addEventListener("mouseleave", () => {
        if (hoverIntentTimer) {
          clearTimeout(hoverIntentTimer);
          hoverIntentTimer = null;
        }
        if (state.hoveredWordKey === wordKey(segment.id, character.wordId)) {
          state.hoveredWordKey = null;
          elements.wordPanel.innerHTML = `<h2>Word</h2><p class="empty">Hover a character.</p>`;
          renderInteractionState();
        }
        hideHoverTooltip();
      });

      hotspot.addEventListener("mousemove", (event) => {
        if (state.hoveredWordKey === wordKey(segment.id, character.wordId)) {
          moveHoverTooltip(event.clientX, event.clientY);
        }
      });
    }

    hotspot.addEventListener("click", (event) => {
      const sentence = sentencesById.get(character.sentenceId);
      const nextSentenceKey = sentenceKey(segment.id, character.sentenceId);
      if (state.mode === "read") {
        state.hoveredWordKey = wordKey(segment.id, character.wordId);
        state.activeSentenceKey = nextSentenceKey;
        hideHoverTooltip();
        if (hoverIntentTimer) {
          clearTimeout(hoverIntentTimer);
          hoverIntentTimer = null;
        }
        updateWordPanel(currentWord);
        updateSentencePanel(sentence);
        renderInteractionState();
        return;
      }

      if (state.mode === "refine") {
        if (state.refineSidebarMode === "create") {
          if (state.draftBoundaryMode) {
            addDraftBoundaryPoint(event, frame);
            return;
          }

          if (state.draftPatch && state.draftAnchorPickMode) {
            const currentMode = state.draftPatch.anchorMode ?? "after";
            updateDraftAnchor(currentMode, character.sentenceId);
            state.draftAnchorPickMode = false;
            renderModePanels();
            renderInteractionState();
          }
          return;
        }

        if (state.refineSidebarMode === "view") {
          focusSentence(nextSentenceKey, { scrollPage: true, scrollSidebar: true });
        }
        return;
      }

      focusSentence(nextSentenceKey, { scrollPage: true, scrollSidebar: true });
    });

    overlay.appendChild(hotspot);
  }

  canvas.append(image, overlay);
  frame.append(canvas);
  return frame;
}

function renderNoReadState() {
  if (state.mode === "read") {
    elements.wordPanel.innerHTML = `<h2>Word</h2><p class="empty">No learner-ready word data is loaded for this chapter.</p>`;
    elements.sentencePanel.innerHTML = `<h2>Sentence</h2><p class="empty">Sentence details will appear here when a read model is available.</p>`;
  }
}

function renderChapter() {
  elements.chapterStack.innerHTML = "";

  let totalCharacters = 0;
  const annotations = currentAnnotations();
  for (const segment of segmentEntries()) {
    const annotation = annotations.get(segment.id);
    if (!annotation) {
      continue;
    }
    totalCharacters += annotation.characters.length;
    const frame = buildSegmentFrame(segment);
    if (frame) {
      elements.chapterStack.appendChild(frame);
    }
  }

  if (totalCharacters === 0) {
    renderNoReadState();
  }

  queueViewportAnchorSync();
}

function setChapterModels(series, chapter, { readModel = null, refineModel = null, activeSentenceKey = null, activePatchId = null } = {}) {
  state.currentChapter = { series, chapter };
  state.readModel = readModel;
  state.refineModel = refineModel;
  state.readAnnotations = readModel ? buildAnnotationMapFromChapterModel(readModel) : new Map();
  state.refineAnnotations = refineModel ? buildAnnotationMapFromChapterModel(refineModel, { includeDeleted: true }) : new Map();
  syncActiveAnnotations();
  state.hoveredWordKey = null;
  state.refineSidebarMode = "view";
  state.activeSentenceKey = activeSentenceKey;
  state.activePatchId = activePatchId;
  state.visibleSentenceKeys = new Set();
  hideHoverTooltip();
}

async function ensureChapterModel(series, chapter, mode, { force = false } = {}) {
  const cached = !force ? cachedModel(mode, series, chapter) : null;
  if (cached) {
    return cached;
  }

  const model = await loadJson(`/api/chapters/${series}/${chapter}/${mode}`);
  if (model) {
    cacheModel(mode, model);
  }
  return model;
}

function fallbackModeForChapter(chapter, requestedMode) {
  if (modeAvailableForChapter(chapter, requestedMode)) {
    return {
      mode: requestedMode,
      notice: "",
    };
  }

  const alternateMode = requestedMode === "read" ? "refine" : "read";
  if (modeAvailableForChapter(chapter, alternateMode)) {
    return {
      mode: alternateMode,
      notice: `${requestedMode === "read" ? "Read" : "Refine"} data is unavailable for this chapter, so the app switched to ${alternateMode}.`,
    };
  }

  return {
    mode: requestedMode,
    notice: `No persisted ${requestedMode} data is available for this chapter yet.`,
  };
}

async function loadChapterFromApi(
  series,
  chapter,
  {
    preferredMode = state.mode,
    activeSentenceKey = state.activeSentenceKey,
    activePatchId = state.activePatchId,
    preservePosition = true,
    restoreScrollTop = null,
    forceModes = [],
    positionAnchor = null,
  } = {},
) {
  const chapterEntry = chapterEntryFor(series, chapter);
  if (!chapterEntry) {
    throw new Error(`Unknown chapter: ${series} / ${chapter}.`);
  }

  const previousAnchor = preservePosition ? positionAnchor ?? state.positionAnchor ?? captureTopVisibleSentenceAnchor() : null;
  const modeSelection = fallbackModeForChapter(chapterEntry, preferredMode);
  const nextMode = modeSelection.mode;
  const requiredModel = await ensureChapterModel(series, chapter, nextMode, {
    force: forceModes.includes(nextMode),
  });
  if (!requiredModel) {
    throw new Error(`Could not load ${nextMode} data for ${series} / ${chapter}.`);
  }

  const nextReadModel = nextMode === "read"
    ? requiredModel
    : (forceModes.includes("read")
      ? await ensureChapterModel(series, chapter, "read", { force: true })
      : cachedModel("read", series, chapter));
  const nextRefineModel = nextMode === "refine"
    ? requiredModel
    : (forceModes.includes("refine")
      ? await ensureChapterModel(series, chapter, "refine", { force: true })
      : cachedModel("refine", series, chapter));

  state.mode = nextMode;
  state.modeNotice = modeSelection.notice;
  setChapterModels(series, chapter, {
    readModel: nextReadModel,
    refineModel: nextRefineModel,
    activeSentenceKey,
    activePatchId,
  });
  updateChapterUrl(series, chapter, state.mode);
  renderModeControls();
  renderModePanels();
  renderChapterPanel();
  renderChapter();
  renderInteractionState();
  if (preservePosition && previousAnchor) {
    state.positionAnchor = previousAnchor;
  }
  requestAnimationFrame(() => {
    if (restoreScrollTop !== null) {
      window.scrollTo({ top: restoreScrollTop, left: 0, behavior: "auto" });
    } else {
      restoreTopVisibleSentenceAnchor(previousAnchor);
    }
    if (activeSentenceKey && state.mode === "refine") {
      scrollSentenceCardIntoView(activeSentenceKey);
    }
    if (activePatchId && state.mode === "refine") {
      scrollPatchCardIntoView(activePatchId);
    }
  });
}

async function bootstrapChapterData() {
  const chaptersPayload = await loadJson(chaptersApiUrl);
  const chapters = Array.isArray(chaptersPayload?.chapters) ? chaptersPayload.chapters : [];
  state.chapterIndex = chapters;
  if (chapters.length === 0) {
    throw new Error("No chapters with persisted read or refine data are currently available.");
  }

  const url = new URL(window.location.href);
  const requestedSeries = url.searchParams.get("series");
  const requestedChapter = url.searchParams.get("chapter");
  const requestedMode = url.searchParams.get("mode");
  if (requestedMode === "refine" || requestedMode === "read") {
    state.mode = requestedMode;
  }
  const preferredMode = requestedMode === "refine" ? "refine" : "read";
  const selectedChapter = chapters.find((entry) => {
    return entry.series === requestedSeries
      && entry.chapter === requestedChapter
      && (modeAvailableForChapter(entry, preferredMode) || modeAvailableForChapter(entry, preferredMode === "read" ? "refine" : "read"));
  }) ?? chapters.find((entry) => modeAvailableForChapter(entry, preferredMode))
    ?? chapters.find((entry) => modeAvailableForChapter(entry, preferredMode === "read" ? "refine" : "read"))
    ?? null;

  if (!selectedChapter) {
    throw new Error("No chapter with persisted read or refine data is currently available.");
  }

  await loadChapterFromApi(selectedChapter.series, selectedChapter.chapter, {
    preferredMode,
  });
}

async function init() {
  elements = {
    chapterPanel: document.querySelector("#chapterPanel"),
    modeDescription: document.querySelector("#modeDescription"),
    readModeButton: document.querySelector("#readModeButton"),
    refineModeButton: document.querySelector("#refineModeButton"),
    wordPanel: document.querySelector("#wordPanel"),
    sentencePanel: document.querySelector("#sentencePanel"),
    notesToggle: document.querySelector("#notesToggle"),
    notesPanel: document.querySelector("#notesPanel"),
    notesBody: document.querySelector("#notesPanel .notes-body"),
    refinePanel: document.querySelector("#refinePanel"),
    chapterStack: document.querySelector("#chapterStack"),
    hoverTooltip: document.querySelector("#hoverTooltip"),
  };

  for (const [key, value] of Object.entries(elements)) {
    if (!value) {
      throw new Error(`Missing reader element: ${key}`);
    }
  }

  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const clickedHotspot = target?.closest(".hotspot");
    const clickedSidebar = target?.closest(".sidebar");
    const clickedChapter = target?.closest("#chapterStack");
    if (!clickedHotspot && !clickedSidebar && !clickedChapter) {
      clearInteractionState();
    }
  });

  elements.chapterStack.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest(".hotspot")) {
      return;
    }

    clearReadSelection();
  });

  window.addEventListener("scroll", queueViewportAnchorSync, { passive: true });
  window.addEventListener("resize", queueViewportAnchorSync);

  elements.readModeButton.addEventListener("click", () => {
    setMode("read").catch((error) => {
      console.error(error);
      window.alert(error.message);
    });
  });
  elements.refineModeButton.addEventListener("click", () => {
    setMode("refine").catch((error) => {
      console.error(error);
      window.alert(error.message);
    });
  });

  elements.refinePanel.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const refineActionButton = target?.closest("[data-refine-action]");
    if (refineActionButton) {
      const action = refineActionButton.getAttribute("data-refine-action");
      if (!action) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      if (action === "enter-create") {
        enterRefineCreateMode({ ensureDraft: true });
        return;
      }
      if (action === "enter-view") {
        enterRefineViewMode({ preserveDraft: true });
      }
      return;
    }

    const draftActionButton = target?.closest("[data-draft-action]");
    if (draftActionButton) {
      const action = draftActionButton.getAttribute("data-draft-action");
      if (!action) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      if (action === "cancel") {
        cancelDraftPatch();
        return;
      }
      if (action === "toggle-boundary") {
        try {
          toggleDraftBoundaryMode();
        } catch (error) {
          console.error(error);
          window.alert(error.message);
        }
        return;
      }
      if (action === "undo-point") {
        undoDraftBoundaryPoint();
        return;
      }
      if (action === "clear-region") {
        updateDraftPatch((draftPatch) => ({
          ...draftPatch,
          segmentId: null,
          sourcePageId: null,
          region: { polygon: [] },
          text_flow: {
            ...draftPatch.text_flow,
            guide: [],
          },
        }));
        return;
      }
      if (action === "process") {
        processDraftPatch().catch((error) => {
          console.error(error);
          window.alert(error.message);
        });
      }
      return;
    }

    const patchActionButton = target?.closest(".refine-patch-action");
    if (patchActionButton && state.refineSidebarMode === "view") {
      const patchId = patchActionButton.getAttribute("data-patch-id");
      if (!patchId) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      mutatePatchDelete(patchId).catch((error) => {
        console.error(error);
        window.alert(error.message);
      });
      return;
    }

    const actionButton = target?.closest(".refine-sentence-action");
    if (actionButton && state.refineSidebarMode === "view") {
      const sentenceKey = actionButton.getAttribute("data-sentence-key");
      const action = actionButton.getAttribute("data-action");
      if (!sentenceKey || !action) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      mutateSentenceStatus(sentenceKey, action === "delete" ? "deleted" : "active").catch((error) => {
        console.error(error);
        window.alert(error.message);
      });
      return;
    }

    const patchButton = target?.closest(".refine-patch-body");
    if (patchButton && state.refineSidebarMode === "view") {
      event.preventDefault();
      event.stopPropagation();

      const patchId = patchButton.getAttribute("data-patch-id");
      if (!patchId) {
        return;
      }

      focusPatch(patchId, { scrollSidebar: true });
      return;
    }

    const sentenceButton = target?.closest(".refine-sentence-body");
    if (!sentenceButton || state.refineSidebarMode !== "view") {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const sentenceKey = sentenceButton.getAttribute("data-sentence-key");
    if (!sentenceKey) {
      return;
    }

    focusSentence(sentenceKey, { scrollPage: true, scrollSidebar: true });
  });

  elements.refinePanel.addEventListener("input", (event) => {
    const target = event.target instanceof HTMLTextAreaElement ? event.target : null;
    if (!target || state.refineSidebarMode !== "create" || !state.draftPatch) {
      return;
    }

    const field = target.getAttribute("data-draft-field");
    if (field === "user-transcript") {
      updateDraftPatch((draftPatch) => ({
        ...draftPatch,
        user_transcript: target.value,
      }), { rerenderPanel: false, rerenderInteraction: false });
      return;
    }
    if (field === "notes") {
      updateDraftPatch((draftPatch) => ({
        ...draftPatch,
        notes: target.value,
      }), { rerenderPanel: false, rerenderInteraction: false });
    }
  });

  elements.refinePanel.addEventListener("change", (event) => {
    const target = event.target instanceof HTMLSelectElement ? event.target : null;
    if (!target || state.refineSidebarMode !== "create" || !state.draftPatch) {
      return;
    }

    const field = target.getAttribute("data-draft-field");
    if (field === "text-flow-mode") {
      updateDraftPatch((draftPatch) => ({
        ...draftPatch,
        text_flow: {
          ...draftPatch.text_flow,
          mode: target.value,
          guide: autoGuideForPolygon(draftPatch.region?.polygon ?? [], target.value),
        },
      }));
      return;
    }

    if (field === "anchor-mode") {
      const currentSentenceId = state.draftPatch.anchor?.insert_before_sentence_id
        ?? state.draftPatch.anchor?.insert_after_sentence_id
        ?? "";
      if (target.value === "append") {
        state.draftAnchorPickMode = false;
      }
      updateDraftAnchor(target.value, currentSentenceId);
      return;
    }

    if (field === "anchor-sentence") {
      if (target.value === "__pick_from_page__") {
        state.draftAnchorPickMode = true;
        state.draftBoundaryMode = false;
        renderModePanels();
        renderInteractionState();
        return;
      }

      state.draftAnchorPickMode = false;
      const currentMode = state.draftPatch.anchorMode ?? "append";
      updateDraftAnchor(currentMode, target.value);
    }
  });

  renderEmptyPanels();
  renderEmptyNotesPanel();
  setNotesExpanded(false);
  await bootstrapChapterData();

  elements.notesToggle.addEventListener("click", () => {
    const expanded = !elements.notesPanel.classList.contains("expanded");
    if (expanded) {
      renderNotesPanel();
    }
    setNotesExpanded(expanded);
  });
}

init().catch((error) => {
  console.error(error);
  document.body.innerHTML = `<pre>${escapeHtml(error.message)}</pre>`;
});
