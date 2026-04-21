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
  mode: "read",
  readModel: null,
  refineModel: null,
  readAnnotations: new Map(),
  refineAnnotations: new Map(),
  annotations: new Map(),
  positionAnchor: null,
  visibleSentenceKeys: new Set(),
  hoveredWordKey: null,
  activeSentenceKey: null,
  activePatchId: null,
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

function annotationPathForSentenceKey(sentenceKey) {
  const parts = splitSentenceKey(sentenceKey);
  if (!parts || !state.refineModel) {
    return null;
  }

  const segment = segmentForSentenceKey(sentenceKey, state.refineModel);
  if (!segment?.sourcePageId) {
    return null;
  }

  return `data/processed/annotations/${state.refineModel.series}/${state.refineModel.chapter}/${segment.sourcePageId}.json`;
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
  return model?.title ?? `${model?.series ?? ""} / ${model?.chapter ?? ""}`.trim();
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
  elements.readModeButton.classList.toggle("active", isRead);
  elements.refineModeButton.classList.toggle("active", !isRead);
  elements.readModeButton.setAttribute("aria-pressed", isRead ? "true" : "false");
  elements.refineModeButton.setAttribute("aria-pressed", !isRead ? "true" : "false");
  elements.refineModeButton.disabled = !state.refineModel;
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
  const annotations = currentAnnotations();
  const currentPatch = refinePatchForId(state.activePatchId ?? "");
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
              <h3>${escapeHtml(segment.id)}</h3>
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

  const detailMarkup = currentPatch
    ? patchDetailMarkup(currentPatch)
    : currentSentence
      ? sentenceDetailMarkup(currentSentence)
      : "";

  elements.refinePanel.innerHTML = `
    <h2>Refine</h2>
    <p class="empty">Inspect annotation quality, deleted sentences, and patch-ready chapter state.</p>
    <div class="refine-summary">
      <p><span class="label">Segments</span>${escapeHtml(String(refineModel?.segments?.length ?? 0))}</p>
      <p><span class="label">Sentences</span>${escapeHtml(String(sentences.length))}</p>
      <p><span class="label">Deleted</span>${escapeHtml(String(deletedCount))}</p>
      <p><span class="label">Patches</span>${escapeHtml(String(patchCount))}</p>
    </div>
    ${detailMarkup}
    <section class="refine-visible">
      <div class="refine-section-header">
        <h3>Visible now</h3>
        <span>${escapeHtml(String(visibleSentences.length))}</span>
      </div>
      ${visibleSections}
    </section>
    ${patchList}
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

async function mutateSentenceStatus(sentenceKey, status) {
  if (state.mode !== "refine") {
    return;
  }

  const annotationPath = annotationPathForSentenceKey(sentenceKey);
  const sentence = refineSentenceRecordForKey(sentenceKey);
  if (!annotationPath || !sentence) {
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
      annotationPath,
      sentenceId: sentence.id,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || `Could not ${status === "deleted" ? "delete" : "restore"} sentence.`);
  }

  const currentSelection = sentenceKey;
  const currentChapter = currentModel();
  if (!currentChapter) {
    return;
  }
  const scrollTop = window.scrollY;

  await loadChapterFromApi(currentChapter.series, currentChapter.chapter, {
    activeSentenceKey: currentSelection,
    activePatchId: null,
    preservePosition: true,
    restoreScrollTop: scrollTop,
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

  await loadChapterFromApi(currentChapter.series, currentChapter.chapter, {
    activeSentenceKey: null,
    activePatchId: null,
    preservePosition: true,
    restoreScrollTop: scrollTop,
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

function setMode(nextMode, { preservePosition = true } = {}) {
  if (nextMode === "refine" && !state.refineModel) {
    return;
  }

  if (state.mode === nextMode) {
    return;
  }

  const anchor = preservePosition ? captureTopVisibleSentenceAnchor() : null;
  state.mode = nextMode;
  state.hoveredWordKey = null;
  state.activePatchId = null;
  state.activeSentenceKey = anchor?.sentenceKey ?? null;
  state.positionAnchor = anchor ?? state.positionAnchor;
  syncActiveAnnotations();
  renderModeControls();
  renderModePanels();
  renderChapterPanel();
  renderChapter();
  renderInteractionState();
  updateChapterUrl(currentModel()?.series ?? "", currentModel()?.chapter ?? "", state.mode);
  queueViewportAnchorSync();
  requestAnimationFrame(() => restoreTopVisibleSentenceAnchor(anchor));
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
  }
}

function renderInteractionState() {
  updateFocusOverlays();

  for (const focus of elements.chapterStack.querySelectorAll(".word-focus")) {
    focus.classList.toggle("visible", state.mode === "read" && focus.dataset.wordKey === state.hoveredWordKey);
  }

  for (const focus of elements.chapterStack.querySelectorAll(".sentence-focus")) {
    focus.classList.toggle("visible", focus.dataset.sentenceKey === state.activeSentenceKey);
  }

  for (const focus of elements.chapterStack.querySelectorAll(".patch-focus")) {
    focus.classList.toggle("visible", focus.dataset.patchId === state.activePatchId);
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
  if (state.mode === "read") {
    renderEmptyPanels();
  } else {
    renderModePanels();
  }
  renderInteractionState();
}

function renderChapterPanel() {
  const chapterOptions = state.chapterIndex.length > 0
    ? state.chapterIndex
      .map((chapter) => {
        const value = `${chapter.series}::${chapter.chapter}`;
        const selected = chapter.series === currentModel()?.series && chapter.chapter === currentModel()?.chapter;
        const label = chapter.hasReadModel ? chapter.title : `${chapter.title} (read unavailable)`;
        return `<option value="${escapeHtml(value)}" ${selected ? "selected" : ""} ${chapter.hasReadModel ? "" : "disabled"}>${escapeHtml(label)}</option>`;
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
    <p><span class="label">Title</span>${escapeHtml(chapterTitle())}</p>
    <p><span class="label">Series</span>${escapeHtml(currentModel()?.series ?? "")}</p>
    <p><span class="label">Chapter</span>${escapeHtml(currentModel()?.chapter ?? "")}</p>
    <p><span class="label">Mode</span>${escapeHtml(state.mode)}</p>
  `;

  const chapterSelect = elements.chapterPanel.querySelector("#chapterSelect");
  if (chapterSelect) {
    chapterSelect.addEventListener("change", async (event) => {
      const [series, chapter] = String(event.target.value).split("::");
      if (!series || !chapter) {
        return;
      }
      await loadChapterFromApi(series, chapter);
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

  const readInteractionsEnabled = state.mode === "read";

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

    hotspot.addEventListener("click", () => {
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

function setChapterModels(readModel, refineModel, { activeSentenceKey = null, activePatchId = null } = {}) {
  state.readModel = readModel;
  state.refineModel = refineModel;
  state.readAnnotations = buildAnnotationMapFromChapterModel(readModel);
  state.refineAnnotations = refineModel ? buildAnnotationMapFromChapterModel(refineModel, { includeDeleted: true }) : new Map();
  syncActiveAnnotations();
  state.hoveredWordKey = null;
  state.activeSentenceKey = activeSentenceKey;
  state.activePatchId = activePatchId;
  state.visibleSentenceKeys = new Set();
  hideHoverTooltip();
}

async function loadChapterFromApi(
  series,
  chapter,
  {
    activeSentenceKey = state.activeSentenceKey,
    activePatchId = state.activePatchId,
    preservePosition = true,
    restoreScrollTop = null,
  } = {},
) {
  const previousAnchor = preservePosition ? state.positionAnchor ?? captureTopVisibleSentenceAnchor() : null;
  const [readModel, refineModel] = await Promise.all([
    loadJson(`/api/chapters/${series}/${chapter}/read`),
    loadJson(`/api/chapters/${series}/${chapter}/refine`),
  ]);
  if (!readModel) {
    throw new Error(`Could not load read data for ${series} / ${chapter}.`);
  }

  setChapterModels(readModel, refineModel, { activeSentenceKey, activePatchId });
  if (state.mode === "refine" && !state.refineModel) {
    state.mode = "read";
  }
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
    throw new Error("No chapters with persisted read models are currently available.");
  }

  const url = new URL(window.location.href);
  const requestedSeries = url.searchParams.get("series");
  const requestedChapter = url.searchParams.get("chapter");
  const requestedMode = url.searchParams.get("mode");
  if (requestedMode === "refine" || requestedMode === "read") {
    state.mode = requestedMode;
  }
  const selectedChapter = chapters.find(
    (entry) => entry.series === requestedSeries && entry.chapter === requestedChapter && entry.hasReadModel,
  ) ?? chapters.find((entry) => entry.hasReadModel) ?? null;

  if (!selectedChapter) {
    throw new Error("No chapter with a persisted read model is currently available.");
  }

  await loadChapterFromApi(selectedChapter.series, selectedChapter.chapter);
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
    if (!clickedHotspot && !clickedSidebar) {
      clearInteractionState();
    }
  });

  window.addEventListener("scroll", queueViewportAnchorSync, { passive: true });
  window.addEventListener("resize", queueViewportAnchorSync);

  elements.readModeButton.addEventListener("click", () => {
    setMode("read");
  });
  elements.refineModeButton.addEventListener("click", () => {
    setMode("refine");
  });

  elements.refinePanel.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const patchActionButton = target?.closest(".refine-patch-action");
    if (patchActionButton) {
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
    if (actionButton) {
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
    if (patchButton) {
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
    if (!sentenceButton) {
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
