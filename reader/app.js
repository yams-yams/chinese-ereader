const manifestUrl =
  "../data/processed/chapters/renjian-bailijin/chapter-001.json";
const chaptersApiUrl = "/api/chapters";

const PUNCTUATION_ONLY_RE = /^[\s.,!?;:'"()[\]{}\-_/\\|`~@#$%^&*+=<>，。！？、；：‘’“”《》〈〉「」『』（）【】…·—]+$/;

const state = {
  manifest: null,
  chapterIndex: [],
  annotations: new Map(),
  rawAnnotations: new Map(),
  displayAnnotations: new Map(),
  enrichment: null,
  dataSource: "legacy",
  hoveredWordKey: null,
  activeSentenceKey: null,
  selectedDebugPageId: null,
  showDebugPolygons: false,
  review: {
    enabled: false,
    activeTool: null,
    storageKey: null,
    patches: [],
    draft: makeEmptyDraft(),
    anchorMode: "append",
    isProcessing: false,
    statusMessage: "",
    errorMessage: "",
    needsReload: false,
  },
};

let elements;
let hoverIntentTimer = null;

function makeEmptyDraft(pageId = "") {
  return {
    patch_id: null,
    page_id: pageId,
    kind: "missing_region",
    region: { polygon: [] },
    text_flow: {
      mode: "vertical_rl",
      guide: [],
    },
    ocr_candidate: "",
    user_transcript: "",
    anchor: {
      insert_after_sentence_id: "",
      insert_before_sentence_id: "",
    },
    notes: "",
  };
}

async function loadJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    return null;
  }
  return response.json();
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  let body = null;
  try {
    body = await response.json();
  } catch (error) {
    body = null;
  }

  return { response, body };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function panelMarkup(title, fields) {
  return `
    <h2>${title}</h2>
    ${fields
      .filter(({ value }) => value !== null && value !== undefined && value !== "")
      .map(
        ({ label, value }) => `
          <p><span class="label">${label}</span>${value ?? "Pending"}</p>
        `,
      )
      .join("")}
  `;
}

function renderEmptyPanels() {
  elements.wordPanel.innerHTML = `<h2>Word</h2><p class="empty">Hover a character hotspot.</p>`;
  elements.sentencePanel.innerHTML = `<h2>Sentence</h2><p class="empty">Click a character hotspot.</p>`;
}

function renderEmptyPageReviewPanel(message = "Turn on debug mode and click within a page.") {
  elements.pageReviewPanel.innerHTML = `<h2>Page Sentences</h2><p class="empty">${message}</p>`;
}

function imagePath(relativePath) {
  return `../${relativePath}`;
}

function pageEntry(pageId) {
  return state.manifest?.pages.find((page) => page.id === pageId) ?? null;
}

function pageIdForSegment(segment) {
  return segment.sourcePageId ?? segment.id;
}

function annotationPathForPage(series, chapter, pageId) {
  return `data/processed/annotations/${series}/${chapter}/${pageId}.json`;
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

function manifestFromApiModels(refineModel) {
  const pages = refineModel.segments.map((segment) => {
    const pageId = pageIdForSegment(segment);
    return {
      id: pageId,
      image: segment.image,
      annotation: annotationPathForPage(refineModel.series, refineModel.chapter, pageId),
      segmentId: segment.id,
      sourcePageId: pageId,
      imageSize: segment.imageSize,
    };
  });

  return {
    series: refineModel.series,
    chapter: refineModel.chapter,
    title: refineModel.title ?? `${refineModel.series} / ${refineModel.chapter}`,
    pageCount: pages.length,
    pages,
  };
}

function annotationMapFromModel(model, manifest) {
  const sentencesBySegment = groupBySegment(model?.sentences ?? []);
  const wordsBySegment = groupBySegment(model?.words ?? []);
  const charactersBySegment = groupBySegment(model?.characters ?? []);
  const annotations = new Map();

  for (const page of manifest.pages) {
    const segmentId = page.segmentId ?? page.id;
    annotations.set(page.id, {
      sourceImage: page.image,
      imageSize: page.imageSize ?? null,
      characters: (charactersBySegment.get(segmentId) ?? []).map((character) => ({ ...character })),
      words: (wordsBySegment.get(segmentId) ?? []).map((word) => ({ ...word })),
      sentences: (sentencesBySegment.get(segmentId) ?? []).map((sentence) => ({ ...sentence })),
    });
  }

  return annotations;
}

function displayAnnotationFromApi(pageId, filteredRawAnnotation) {
  const baseDisplayAnnotation = state.displayAnnotations.get(pageId);
  if (!baseDisplayAnnotation) {
    return filteredRawAnnotation;
  }

  const displayCharactersById = mapById(baseDisplayAnnotation.characters);
  const displaySentencesById = mapById(baseDisplayAnnotation.sentences);

  const characters = filteredRawAnnotation.characters.map((character) => ({
    ...character,
    ...displayCharactersById.get(character.id),
    sentenceId: character.sentenceId,
  }));
  const keptCharacterIds = new Set(characters.map((character) => character.id));

  const words = baseDisplayAnnotation.words.length > 0
    ? baseDisplayAnnotation.words
      .filter((word) => (word.characterIds ?? []).some((characterId) => keptCharacterIds.has(characterId)))
      .map((word) => ({ ...word }))
    : filteredRawAnnotation.words.map((word) => ({ ...word }));

  const sentences = filteredRawAnnotation.sentences.map((sentence) => ({
    ...sentence,
    ...displaySentencesById.get(sentence.id),
    status: sentence.status ?? displaySentencesById.get(sentence.id)?.status ?? "active",
  }));

  return {
    ...filteredRawAnnotation,
    characters,
    words,
    sentences,
  };
}

function apiPatchesToReviewPatches(refineModel, manifest) {
  const pageIdBySegmentId = new Map(
    manifest.pages.map((page) => [page.segmentId ?? page.id, page.id]),
  );

  return (refineModel.patches ?? []).map((patch) => ({
    ...patch,
    page_id: pageIdBySegmentId.get(patch.segmentId) ?? patch.segmentId,
  }));
}

function mergePatchesById(basePatches, localPatches) {
  const merged = new Map((basePatches ?? []).map((patch) => [patch.patch_id, { ...patch }]));
  for (const patch of localPatches ?? []) {
    merged.set(patch.patch_id, { ...patch });
  }
  return [...merged.values()];
}

function currentChapterChoice() {
  return state.chapterIndex.find(
    (entry) => entry.series === state.manifest?.series && entry.chapter === state.manifest?.chapter,
  ) ?? null;
}

function updateChapterUrl(series, chapter) {
  const url = new URL(window.location.href);
  url.searchParams.set("series", series);
  url.searchParams.set("chapter", chapter);
  window.history.replaceState({}, "", url);
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

function rerenderChapterPreservingScroll() {
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;
  renderChapter();
  requestAnimationFrame(() => {
    window.scrollTo(scrollX, scrollY);
    requestAnimationFrame(() => {
      window.scrollTo(scrollX, scrollY);
    });
  });
}

function enrichmentPathForManifest(manifest) {
  const match = manifest.chapter.match(/^chapter-(\d+)$/);
  if (!match) {
    return null;
  }

  return `../data/translated/chapter${Number(match[1])}.json`;
}

function analysisKey(pageId, sentenceId) {
  return `${pageId}:${sentenceId}`;
}

function enrichAnnotation(pageId, annotation) {
  if (!state.enrichment?.sentence_analyses?.length) {
    return annotation;
  }

  const analysesBySentenceId = new Map();
  for (const analysis of state.enrichment.sentence_analyses) {
    analysesBySentenceId.set(analysisKey(analysis.page_id, analysis.sentence_id), analysis);
  }

  const characters = annotation.characters.map((character) => ({ ...character }));
  const characterById = new Map(characters.map((character) => [character.id, character]));
  const fallbackWords = annotation.words.map((word) => ({ ...word }));
  const fallbackWordsById = new Map(fallbackWords.map((word) => [word.id, word]));
  const enrichedWords = [];
  let wordCounter = 1;

  const sentences = annotation.sentences.map((sentence) => {
    const analysis = analysesBySentenceId.get(analysisKey(pageId, sentence.id));
    if (!analysis) {
      return { ...sentence };
    }

    for (const word of analysis.words) {
      const wordId = `enriched-word-${wordCounter.toString().padStart(4, "0")}`;
      wordCounter += 1;

      enrichedWords.push({
        id: wordId,
        text: word.surface_text,
        pinyin: word.pinyin,
        translation: word.translation,
        characterIds: [...word.ocr_token_ids],
        normalizedText: word.normalized_text,
        confidence: word.confidence,
      });

      for (const tokenId of word.ocr_token_ids) {
        const character = characterById.get(tokenId);
        if (character) {
          character.wordId = wordId;
        }
      }
    }

    return {
      ...sentence,
      text: analysis.normalized_text || sentence.text,
      pinyin: analysis.sentence_pinyin,
      translation: analysis.sentence_translation,
      grammarNotes: analysis.grammar_notes,
      notes: [...analysis.notes],
      ocrText: analysis.ocr_text,
    };
  });

  for (const character of characters) {
    if (!fallbackWordsById.has(character.wordId)) {
      continue;
    }

    const fallbackWord = fallbackWordsById.get(character.wordId);
    if (!fallbackWord) {
      continue;
    }

    fallbackWord.characterIds = fallbackWord.characterIds ?? [character.id];
  }

  const words = enrichedWords.length > 0 ? enrichedWords : fallbackWords;

  return {
    ...annotation,
    characters,
    words,
    sentences,
  };
}

function isDeletedSentence(sentence) {
  return (sentence?.status ?? "active") === "deleted";
}

function filteredAnnotationForPage(pageId) {
  const rawAnnotation = state.rawAnnotations.get(pageId);
  if (!rawAnnotation) {
    return null;
  }

  const keptSentences = rawAnnotation.sentences
    .filter((sentence) => !isDeletedSentence(sentence))
    .map((sentence) => ({ ...sentence }));
  const keptSentenceIds = new Set(keptSentences.map((sentence) => sentence.id));
  const keptCharacters = rawAnnotation.characters
    .filter((character) => keptSentenceIds.has(character.sentenceId))
    .map((character) => ({ ...character }));
  const keptCharacterIds = new Set(keptCharacters.map((character) => character.id));
  const keptWordIds = new Set(keptCharacters.map((character) => character.wordId));
  const keptWords = rawAnnotation.words
    .filter((word) => {
      if (keptWordIds.has(word.id)) {
        return true;
      }
      return (word.characterIds ?? []).some((characterId) => keptCharacterIds.has(characterId));
    })
    .map((word) => ({ ...word }));

  return {
    ...rawAnnotation,
    characters: keptCharacters,
    words: keptWords,
    sentences: keptSentences,
  };
}

function rebuildAnnotation(pageId) {
  const filteredAnnotation = filteredAnnotationForPage(pageId);
  if (!filteredAnnotation) {
    return;
  }

  if (state.dataSource === "api") {
    state.annotations.set(pageId, displayAnnotationFromApi(pageId, filteredAnnotation));
    return;
  }

  state.annotations.set(pageId, enrichAnnotation(pageId, filteredAnnotation));
}

function sentenceDisplayText(sentence, index) {
  const text = sentence.text?.trim();
  if (text) {
    return text;
  }
  return `Sentence ${index + 1}`;
}

function renderPageReviewPanel() {
  if (!state.showDebugPolygons) {
    renderEmptyPageReviewPanel("Turn on debug mode and click within a page.");
    return;
  }

  if (!state.selectedDebugPageId) {
    renderEmptyPageReviewPanel("Click on text or non-text within a page to inspect its OCR sentences.");
    return;
  }

  const annotation = state.rawAnnotations.get(state.selectedDebugPageId);
  if (!annotation) {
    renderEmptyPageReviewPanel("No OCR annotations are loaded for this page.");
    return;
  }

  const itemsMarkup = annotation.sentences.length > 0
    ? `
      <div class="page-review-list">
        ${annotation.sentences
          .map((sentence, index) => {
            const isActive = sentenceKey(state.selectedDebugPageId, sentence.id) === state.activeSentenceKey;
            const isDeleted = isDeletedSentence(sentence);
            return `
              <div class="page-review-item ${isActive ? "active" : ""} ${isDeleted ? "deleted" : ""}" data-sentence-id="${sentence.id}">
                <button
                  class="page-review-delete ${isDeleted ? "page-review-restore" : ""}"
                  type="button"
                  ${isDeleted ? `data-restore-sentence-id="${sentence.id}" aria-label="Restore sentence ${index + 1}" title="Restore sentence">↺` : `data-delete-sentence-id="${sentence.id}" aria-label="Delete sentence ${index + 1}" title="Delete sentence">🗑`}
                </button>
                <button
                  class="page-review-body"
                  type="button"
                  data-select-sentence-id="${sentence.id}"
                >
                  <p class="page-review-index">Sentence ${index + 1}</p>
                  <p class="page-review-status">${isDeleted ? "Deleted" : "Active"}</p>
                  <p class="page-review-text">${sentenceDisplayText(sentence, index)}</p>
                </button>
              </div>
            `;
          })
          .join("")}
      </div>
    `
    : `<p class="empty">No OCR sentences are available on this page.</p>`;

  elements.pageReviewPanel.innerHTML = `
    <h2>Page Sentences</h2>
    <p><span class="label">Page</span>${state.selectedDebugPageId}</p>
    ${itemsMarkup}
    <div class="page-review-actions">
      <button class="page-review-reload" type="button" id="reloadPageReviewButton">Reload Page</button>
    </div>
  `;

  for (const deleteButton of elements.pageReviewPanel.querySelectorAll("[data-delete-sentence-id]")) {
    deleteButton.addEventListener("click", (event) => {
      event.stopPropagation();
      const sentenceId = event.currentTarget.dataset.deleteSentenceId;
      if (!sentenceId) {
        return;
      }
      deleteSentenceFromPage(state.selectedDebugPageId, sentenceId);
    });
  }

  for (const restoreButton of elements.pageReviewPanel.querySelectorAll("[data-restore-sentence-id]")) {
    restoreButton.addEventListener("click", (event) => {
      event.stopPropagation();
      const sentenceId = event.currentTarget.dataset.restoreSentenceId;
      if (!sentenceId) {
        return;
      }
      restoreSentenceFromPage(state.selectedDebugPageId, sentenceId);
    });
  }

  for (const selectButton of elements.pageReviewPanel.querySelectorAll("[data-select-sentence-id]")) {
    selectButton.addEventListener("click", (event) => {
      event.stopPropagation();
      const sentenceId = event.currentTarget.dataset.selectSentenceId;
      if (!sentenceId) {
        return;
      }
      selectSentenceFromReviewPanel(state.selectedDebugPageId, sentenceId);
    });
  }

  const reloadButton = elements.pageReviewPanel.querySelector("#reloadPageReviewButton");
  if (reloadButton) {
    reloadButton.addEventListener("click", async (event) => {
      event.stopPropagation();
      await reloadSelectedDebugPage();
    });
  }
}

function selectDebugPage(pageId) {
  state.selectedDebugPageId = pageId;
  renderPageReviewPanel();
}

async function reloadSelectedDebugPage() {
  if (!state.selectedDebugPageId) {
    return;
  }

  await reloadPageById(state.selectedDebugPageId);
}

async function reloadPageById(pageId) {
  if (!pageId) {
    return;
  }

  if (state.dataSource === "api") {
    await loadChapter(state.manifest.series, state.manifest.chapter);
    rerenderChapterPreservingScroll();
    refreshPanelsFromSelection();
    renderPageReviewPanel();
    renderReviewPanel();
    renderInteractionState();
    return;
  }

  const page = pageEntry(pageId);
  if (page) {
    const rawAnnotation =
      (await loadJson(imagePath(page.annotation))) ?? {
        sourceImage: page.image,
        characters: [],
        words: [],
        sentences: [],
      };
    state.rawAnnotations.set(page.id, rawAnnotation);
  }
  rebuildAnnotation(pageId);
  rerenderChapterPreservingScroll();
  refreshPanelsFromSelection();
  renderPageReviewPanel();
  renderInteractionState();
}

function selectSentenceFromReviewPanel(pageId, sentenceId) {
  const annotation = state.rawAnnotations.get(pageId) ?? state.annotations.get(pageId);
  const sentence = annotation?.sentences.find((candidate) => candidate.id === sentenceId);
  if (!sentence) {
    return;
  }

  state.selectedDebugPageId = pageId;
  state.hoveredWordKey = null;
  state.activeSentenceKey = sentenceKey(pageId, sentenceId);
  hideHoverTooltip();
  if (hoverIntentTimer) {
    clearTimeout(hoverIntentTimer);
    hoverIntentTimer = null;
  }

  const charactersById = new Map(annotation.characters.map((character) => [character.id, character]));
  elements.wordPanel.innerHTML = `<h2>Word</h2><p class="empty">Hover a character hotspot.</p>`;
  updateSentencePanel(
    sentence,
    state.showDebugPolygons
      ? { polygon: sentencePolygon(sentence, charactersById) }
      : {},
  );
  renderPageReviewPanel();
  renderInteractionState();
}

async function setSentenceStatusFromPage(pageId, sentenceId, nextStatus) {
  const annotation = state.rawAnnotations.get(pageId) ?? state.annotations.get(pageId);
  const sentence = annotation?.sentences.find((candidate) => candidate.id === sentenceId);
  if (!sentence) {
    return;
  }

  const actionLabel = nextStatus === "deleted" ? "Delete" : "Restore";
  const endpoint = nextStatus === "deleted" ? "/api/delete-sentence" : "/api/restore-sentence";
  const confirmed = window.confirm(
    `${actionLabel} "${sentenceDisplayText(sentence, 0)}" ${nextStatus === "deleted" ? "from" : "on"} ${pageId}?`,
  );
  if (!confirmed) {
    return;
  }

  const page = pageEntry(pageId);
  if (!page) {
    return;
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      annotationPath: page.annotation,
      sentenceId,
    }),
  });

  if (!response.ok) {
    const responseText = await response.text();
    if (response.status === 404 || response.status === 501) {
      window.alert(`${actionLabel} API is unavailable. Restart the reader with \`python3 scripts/serve_reader.py\`.`);
    } else {
      window.alert(`Failed to ${nextStatus === "deleted" ? "delete" : "restore"} the sentence on disk (${response.status}). ${responseText}`);
    }
    return;
  }

  const body = await response.json();
  if (state.dataSource === "api") {
    await loadChapter(state.manifest.series, state.manifest.chapter);
  } else {
    state.rawAnnotations.set(pageId, body.annotation);
    if (nextStatus === "deleted" && sentenceKey(pageId, sentenceId) === state.activeSentenceKey) {
      state.activeSentenceKey = null;
    }
    rebuildAnnotation(pageId);
  }

  rerenderChapterPreservingScroll();
  refreshPanelsFromSelection();
  renderPageReviewPanel();
  renderReviewPanel();
  renderInteractionState();
}

async function deleteSentenceFromPage(pageId, sentenceId) {
  await setSentenceStatusFromPage(pageId, sentenceId, "deleted");
}

async function restoreSentenceFromPage(pageId, sentenceId) {
  await setSentenceStatusFromPage(pageId, sentenceId, "active");
}

async function loadEnrichment() {
  if (state.dataSource === "api") {
    state.enrichment = null;
    return;
  }

  const enrichmentPath = enrichmentPathForManifest(state.manifest);
  if (!enrichmentPath) {
    state.enrichment = null;
    return;
  }

  state.enrichment = await loadJson(enrichmentPath);
}

async function loadAnnotations() {
  if (state.dataSource === "api") {
    for (const page of state.manifest.pages) {
      rebuildAnnotation(page.id);
    }
    return;
  }

  const annotationPromises = state.manifest.pages.map(async (page) => {
    const rawAnnotation =
      (await loadJson(imagePath(page.annotation))) ?? {
        sourceImage: page.image,
        characters: [],
        words: [],
        sentences: [],
      };

    state.rawAnnotations.set(page.id, rawAnnotation);
    rebuildAnnotation(page.id);
  });
  await Promise.all(annotationPromises);
}

function resetChapterData() {
  state.annotations = new Map();
  state.rawAnnotations = new Map();
  state.displayAnnotations = new Map();
  state.hoveredWordKey = null;
  state.activeSentenceKey = null;
  state.selectedDebugPageId = null;
  state.review.patches = [];
  state.review.draft = makeEmptyDraft();
  state.review.anchorMode = "append";
  state.review.statusMessage = "";
  state.review.errorMessage = "";
  state.review.needsReload = false;
}

async function loadChapterFromApi(series, chapter) {
  const [readModel, refineModel] = await Promise.all([
    loadJson(`/api/chapters/${series}/${chapter}/read`),
    loadJson(`/api/chapters/${series}/${chapter}/refine`),
  ]);

  if (!refineModel) {
    throw new Error(`Could not load refine data for ${series} / ${chapter}.`);
  }

  resetChapterData();
  state.dataSource = "api";
  state.manifest = manifestFromApiModels(refineModel);
  state.displayAnnotations = readModel
    ? annotationMapFromModel(readModel, state.manifest)
    : new Map();
  state.rawAnnotations = annotationMapFromModel(refineModel, state.manifest);
  state.review.patches = apiPatchesToReviewPatches(refineModel, state.manifest);
  state.review.storageKey = `ocr-review:${state.manifest.series}:${state.manifest.chapter}`;
  loadReviewStateFromStorage();
  if (!state.review.draft.page_id) {
    state.review.draft.page_id = state.manifest.pages[0]?.id ?? "";
  }

  updateChapterUrl(series, chapter);
  await loadEnrichment();
  await loadAnnotations();
}

async function loadChapterFromLegacyManifest() {
  resetChapterData();
  state.dataSource = "legacy";
  state.manifest = await loadJson(manifestUrl);
  state.review.storageKey = `ocr-review:${state.manifest.series}:${state.manifest.chapter}`;
  state.review.patches = [];
  loadReviewStateFromStorage();
  if (!state.review.draft.page_id) {
    state.review.draft.page_id = state.manifest.pages[0]?.id ?? "";
  }

  await loadEnrichment();
  await loadAnnotations();
}

async function loadChapter(series, chapter) {
  if (state.chapterIndex.length > 0) {
    await loadChapterFromApi(series, chapter);
    return;
  }

  await loadChapterFromLegacyManifest();
}

async function bootstrapChapterData() {
  const chaptersPayload = await loadJson(chaptersApiUrl);
  const chapters = Array.isArray(chaptersPayload?.chapters) ? chaptersPayload.chapters : [];
  if (chapters.length === 0) {
    state.chapterIndex = [];
    await loadChapterFromLegacyManifest();
    return;
  }

  state.chapterIndex = chapters;
  const url = new URL(window.location.href);
  const requestedSeries = url.searchParams.get("series");
  const requestedChapter = url.searchParams.get("chapter");
  const selectedChapter = chapters.find(
    (entry) => entry.series === requestedSeries && entry.chapter === requestedChapter,
  ) ?? chapters.find((entry) => entry.hasRefineData) ?? chapters[0];

  await loadChapterFromApi(selectedChapter.series, selectedChapter.chapter);
}

function renderChapterPanel() {
  const chapterOptions = state.chapterIndex.length > 0
    ? state.chapterIndex
      .map((chapter) => {
        const value = `${chapter.series}::${chapter.chapter}`;
        const selected = chapter.series === state.manifest.series && chapter.chapter === state.manifest.chapter;
        const label = chapter.hasRefineData ? chapter.title : `${chapter.title} (refine unavailable)`;
        return `<option value="${escapeHtml(value)}" ${selected ? "selected" : ""} ${chapter.hasRefineData ? "" : "disabled"}>${escapeHtml(label)}</option>`;
      })
      .join("")
    : "";

  const currentChoice = currentChapterChoice();
  const pickerMarkup = chapterOptions
    ? `
      <label class="field">
        <span class="label">Chapter Picker</span>
        <select id="chapterSelect">${chapterOptions}</select>
      </label>
    `
    : "";

  const modeSummary = state.dataSource === "api"
    ? (currentChoice?.hasReadModel ? "Read + Refine models" : "Refine model")
    : "Manifest + page annotations";

  elements.chapterPanel.innerHTML = `
    <h2>Chapter</h2>
    ${pickerMarkup}
    <p><span class="label">Series</span>${escapeHtml(state.manifest.series)}</p>
    <p><span class="label">Chapter</span>${escapeHtml(state.manifest.chapter)}</p>
    <p><span class="label">Segments</span>${escapeHtml(String(state.manifest.pageCount))}</p>
    <p><span class="label">Data Source</span>${escapeHtml(modeSummary)}</p>
  `;

  const chapterSelect = elements.chapterPanel.querySelector("#chapterSelect");
  if (chapterSelect) {
    chapterSelect.addEventListener("change", async (event) => {
      const [series, chapter] = String(event.target.value).split("::");
      if (!series || !chapter) {
        return;
      }
      await loadChapter(series, chapter);
      renderChapterPanel();
      renderReviewPanel();
      renderChapter();
      refreshPanelsFromSelection();
      renderPageReviewPanel();
      renderInteractionState();
    });
  }
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

function renderNoOcrState() {
  elements.wordPanel.innerHTML = `<h2>Word</h2><p class="empty">No OCR annotations are loaded yet for this chapter.</p>`;
  elements.sentencePanel.innerHTML = `<h2>Sentence</h2><p class="empty">Sentence annotations will appear here after OCR succeeds.</p>`;
}

function characterKey(pageId, characterId) {
  return `${pageId}:${characterId}`;
}

function wordKey(pageId, wordId) {
  return `${pageId}:${wordId}`;
}

function sentenceKey(pageId, sentenceId) {
  return `${pageId}:${sentenceId}`;
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

function clearInteractionState() {
  state.hoveredWordKey = null;
  state.activeSentenceKey = null;
  if (hoverIntentTimer) {
    clearTimeout(hoverIntentTimer);
    hoverIntentTimer = null;
  }
  hideHoverTooltip();
  renderEmptyPanels();
  renderPageReviewPanel();
  renderInteractionState();
}

function renderInteractionState() {
  updateFocusOverlays();

  for (const hotspot of elements.chapterStack.querySelectorAll(".hotspot")) {
    hotspot.classList.toggle("debug-visible", state.showDebugPolygons);
    hotspot.disabled = state.review.enabled;
  }

  for (const lowlight of elements.chapterStack.querySelectorAll(".page-lowlight")) {
    lowlight.classList.remove("visible");
  }

  for (const focus of elements.chapterStack.querySelectorAll(".word-focus")) {
    focus.classList.toggle("visible", focus.dataset.wordKey === state.hoveredWordKey);
  }

  for (const focus of elements.chapterStack.querySelectorAll(".sentence-focus")) {
    focus.classList.toggle("visible", focus.dataset.sentenceKey === state.activeSentenceKey);
  }
}

function keyId(scopedKey) {
  if (!scopedKey) {
    return null;
  }

  const separatorIndex = scopedKey.indexOf(":");
  if (separatorIndex === -1) {
    return null;
  }

  return scopedKey.slice(separatorIndex + 1);
}

function updateFocusOverlays() {
  for (const frame of elements.chapterStack.querySelectorAll(".page-frame")) {
    const pageId = frame.dataset.pageId;
    const annotation = state.annotations.get(pageId);
    if (!annotation) {
      continue;
    }

    const charactersById = new Map(
      annotation.characters.map((character) => [character.id, character]),
    );

    const wordFocus = frame.querySelector(".word-focus");
    const activeWord = annotation.words.find((word) => wordKey(pageId, word.id) === state.hoveredWordKey);
    if (wordFocus && activeWord?.characterIds?.length) {
      const wordPolygons = activeWord.characterIds
        .map((id) => charactersById.get(id)?.polygon)
        .filter(Boolean);
      const geometry = boundsStyleFromPolygons(wordPolygons, 0.003, 0);
      if (geometry) {
        wordFocus.dataset.wordKey = wordKey(pageId, activeWord.id);
        applyGeometry(wordFocus, geometry);
      }
    } else if (wordFocus) {
      wordFocus.dataset.wordKey = "";
      applyGeometry(wordFocus, { left: "0%", top: "0%", width: "0%", height: "0%" });
    }

    const sentenceFocus = frame.querySelector(".sentence-focus");
    const activeSentence = annotation.sentences.find(
      (sentence) => sentenceKey(pageId, sentence.id) === state.activeSentenceKey,
    );
    if (sentenceFocus && activeSentence?.characterIds?.length) {
      const sentencePolygons = activeSentence.characterIds
        .map((id) => charactersById.get(id)?.polygon)
        .filter(Boolean);
      const geometry = boundsStyleFromPolygons(sentencePolygons, 0.012, 0);
      if (geometry) {
        sentenceFocus.dataset.sentenceKey = sentenceKey(pageId, activeSentence.id);
        applyGeometry(sentenceFocus, geometry);
      }
    } else if (sentenceFocus && activeSentence?.polygon?.length) {
      const geometry = boundsStyleFromPolygons([activeSentence.polygon], 0.012, 0);
      if (geometry) {
        sentenceFocus.dataset.sentenceKey = sentenceKey(pageId, activeSentence.id);
        applyGeometry(sentenceFocus, geometry);
      }
    } else if (sentenceFocus) {
      sentenceFocus.dataset.sentenceKey = "";
      applyGeometry(sentenceFocus, { left: "0%", top: "0%", width: "0%", height: "0%" });
    }
  }
}

function updateWordPanel(word) {
  if (!word) {
    return;
  }
  elements.wordPanel.innerHTML = panelMarkup("Word", [
    { label: "Chinese", value: word.text },
    { label: "Pinyin", value: word.pinyin },
    { label: "Meaning", value: word.translation ?? "Pending" },
  ]);
}

function updateSentencePanel(sentence, options = {}) {
  if (!sentence) {
    return;
  }

  const sentenceNotes = [...(sentence.notes ?? [])];
  if (sentence.ocrText && sentence.text && sentence.ocrText !== sentence.text) {
    sentenceNotes.unshift(`Original OCR: ${sentence.ocrText}`);
  }

  elements.sentencePanel.innerHTML = panelMarkup("Sentence", [
    { label: "Status", value: sentence.status ?? "active" },
    { label: "Chinese", value: sentence.text },
    { label: "Pinyin", value: sentence.pinyin ?? "Pending" },
    { label: "Meaning", value: sentence.translation ?? "Pending" },
    { label: "Grammar", value: sentence.grammarNotes ?? "" },
    { label: "Notes", value: sentenceNotes.join(" ") },
  ]);
}

function refreshPanelsFromSelection() {
  if (state.hoveredWordKey) {
    for (const [pageId, annotation] of state.annotations.entries()) {
      const word = annotation.words.find((candidate) => wordKey(pageId, candidate.id) === state.hoveredWordKey);
      if (word) {
        updateWordPanel(word);
        break;
      }
    }
  } else {
    elements.wordPanel.innerHTML = `<h2>Word</h2><p class="empty">Hover a character hotspot.</p>`;
  }

  if (state.activeSentenceKey) {
    const separatorIndex = state.activeSentenceKey.indexOf(":");
    if (separatorIndex !== -1) {
      const pageId = state.activeSentenceKey.slice(0, separatorIndex);
      const sentenceId = state.activeSentenceKey.slice(separatorIndex + 1);
      const annotation = state.annotations.get(pageId);
      const fallbackAnnotation = state.rawAnnotations.get(pageId);
      const sentence = annotation?.sentences.find((candidate) => candidate.id === sentenceId)
        ?? fallbackAnnotation?.sentences.find((candidate) => candidate.id === sentenceId);
      const geometryAnnotation = annotation?.sentences.some((candidate) => candidate.id === sentenceId)
        ? annotation
        : fallbackAnnotation;
      if (sentence && geometryAnnotation) {
        const charactersById = new Map(
          geometryAnnotation.characters.map((character) => [character.id, character]),
        );
        updateSentencePanel(
          sentence,
          state.showDebugPolygons
            ? { polygon: sentencePolygon(sentence, charactersById) }
            : {},
        );
        return;
      }
    }
  }

  elements.sentencePanel.innerHTML = `<h2>Sentence</h2><p class="empty">Click a character hotspot.</p>`;
}

function normalizedPointToCss(point) {
  return {
    left: `${point.x * 100}%`,
    top: `${(1 - point.y) * 100}%`,
  };
}

function polygonSvgPoints(points) {
  return points
    .map((point) => `${point.x.toFixed(6)},${(1 - point.y).toFixed(6)}`)
    .join(" ");
}

function polylineSvgPoints(points) {
  return polygonSvgPoints(points);
}

function pointerToNormalizedPoint(event, container) {
  const rect = container.getBoundingClientRect();
  const x = (event.clientX - rect.left) / rect.width;
  const y = 1 - (event.clientY - rect.top) / rect.height;
  return {
    x: Math.min(Math.max(x, 0), 1),
    y: Math.min(Math.max(y, 0), 1),
  };
}

function getPageReviewPatches(pageId) {
  return state.review.patches.filter((patch) => patch.page_id === pageId);
}

function sentenceLabel(sentence) {
  const text = String(sentence.text ?? "").trim();
  return text.length > 28 ? `${text.slice(0, 28)}...` : text;
}

function nextPatchId() {
  const highest = state.review.patches.reduce((max, patch) => {
    const match = String(patch.patch_id).match(/patch-(\d+)$/);
    if (!match) {
      return max;
    }
    return Math.max(max, Number(match[1]));
  }, 0);
  return `patch-${String(highest + 1).padStart(4, "0")}`;
}

function reviewStoragePayload() {
  return {
    patches: state.review.patches,
    draft: state.review.draft,
    anchorMode: state.review.anchorMode,
  };
}

function persistReviewState() {
  if (!state.review.storageKey) {
    return;
  }

  window.localStorage.setItem(state.review.storageKey, JSON.stringify(reviewStoragePayload()));
}

function loadReviewStateFromStorage() {
  if (!state.review.storageKey) {
    return;
  }

  const raw = window.localStorage.getItem(state.review.storageKey);
  if (!raw) {
    return;
  }

  try {
    const parsed = JSON.parse(raw);
    state.review.patches = mergePatchesById(
      state.review.patches,
      Array.isArray(parsed.patches) ? parsed.patches : [],
    );
    state.review.draft = parsed.draft ? parsed.draft : makeEmptyDraft(state.manifest.pages[0]?.id ?? "");
    state.review.anchorMode = parsed.anchorMode || inferAnchorMode(state.review.draft);
  } catch (error) {
    console.warn("Failed to restore review state", error);
  }
}

function replaceDraft(nextDraft) {
  state.review.draft = {
    ...makeEmptyDraft(nextDraft.page_id),
    ...nextDraft,
    region: {
      polygon: [...(nextDraft.region?.polygon ?? [])],
    },
    text_flow: {
      mode: nextDraft.text_flow?.mode ?? "vertical_rl",
      guide: [...(nextDraft.text_flow?.guide ?? [])],
    },
    anchor: {
      insert_after_sentence_id: nextDraft.anchor?.insert_after_sentence_id ?? "",
      insert_before_sentence_id: nextDraft.anchor?.insert_before_sentence_id ?? "",
    },
  };
  state.review.anchorMode = inferAnchorMode(state.review.draft);
  persistReviewState();
  renderReviewPanel();
}

function setDraftPage(pageId) {
  const keepExisting = state.review.draft.page_id === pageId;
  const nextDraft = keepExisting ? state.review.draft : makeEmptyDraft(pageId);
  replaceDraft(nextDraft);
  rerenderChapterPreservingScroll();
  renderInteractionState();
}

function setActiveReviewTool(tool) {
  state.review.enabled = true;
  state.review.activeTool = state.review.activeTool === tool ? null : tool;
  renderReviewPanel();
  rerenderChapterPreservingScroll();
}

function addDraftPoint(tool, point) {
  if (tool === "region") {
    state.review.draft.region.polygon.push(point);
  } else if (tool === "guide") {
    state.review.draft.text_flow.guide.push(point);
  }
  persistReviewState();
  renderReviewPanel();
  rerenderChapterPreservingScroll();
}

function undoDraftPoint(tool) {
  if (tool === "region") {
    state.review.draft.region.polygon.pop();
  } else if (tool === "guide") {
    state.review.draft.text_flow.guide.pop();
  }
  persistReviewState();
  renderReviewPanel();
  rerenderChapterPreservingScroll();
}

function clearDraftGeometry(tool) {
  if (tool === "region") {
    state.review.draft.region.polygon = [];
  } else if (tool === "guide") {
    state.review.draft.text_flow.guide = [];
  } else if (tool === null) {
    state.review.draft = makeEmptyDraft(state.review.draft.page_id);
  } else {
    return;
  }
  persistReviewState();
  renderReviewPanel();
  rerenderChapterPreservingScroll();
}

function updateDraftField(field, value) {
  if (field === "ocr_candidate" || field === "user_transcript" || field === "notes") {
    state.review.draft[field] = value;
  } else if (field === "text_flow.mode") {
    state.review.draft.text_flow.mode = value;
  }
  persistReviewState();
}

function inferAnchorMode(draft) {
  if (draft.anchor?.insert_after_sentence_id) {
    return "after";
  }
  if (draft.anchor?.insert_before_sentence_id) {
    return "before";
  }
  return "append";
}

function setDraftAnchor(mode, sentenceId = "") {
  state.review.anchorMode = mode;
  state.review.draft.anchor.insert_after_sentence_id = "";
  state.review.draft.anchor.insert_before_sentence_id = "";
  if (mode === "after" && sentenceId) {
    state.review.draft.anchor.insert_after_sentence_id = sentenceId;
  }
  if (mode === "before" && sentenceId) {
    state.review.draft.anchor.insert_before_sentence_id = sentenceId;
  }
  persistReviewState();
  renderReviewPanel();
}

function draftAnchorMode() {
  return state.review.anchorMode || inferAnchorMode(state.review.draft);
}

function draftAnchorSentenceId() {
  return (
    state.review.draft.anchor.insert_after_sentence_id ||
    state.review.draft.anchor.insert_before_sentence_id ||
    ""
  );
}

function validateDraft() {
  if (!state.review.draft.page_id) {
    return "Choose a segment for the patch.";
  }
  if (state.review.draft.region.polygon.length < 3) {
    return "Draw at least 3 points for the missing region.";
  }
  if (state.review.draft.text_flow.guide.length < 2) {
    return "Draw at least 2 points for the text-flow guide.";
  }
  return null;
}

function buildPatchFromDraft() {
  const patchId = state.review.draft.patch_id || nextPatchId();
  return {
    patch_id: patchId,
    page_id: state.review.draft.page_id,
    kind: "missing_region",
    region: {
      polygon: [...state.review.draft.region.polygon],
    },
    text_flow: {
      mode: state.review.draft.text_flow.mode,
      guide: [...state.review.draft.text_flow.guide],
    },
    ocr_candidate: state.review.draft.ocr_candidate.trim(),
    user_transcript: state.review.draft.user_transcript.trim(),
    anchor: {
      insert_after_sentence_id: state.review.draft.anchor.insert_after_sentence_id || null,
      insert_before_sentence_id: state.review.draft.anchor.insert_before_sentence_id || null,
    },
    notes: state.review.draft.notes.trim(),
  };
}

function saveDraftPatch() {
  const error = validateDraft();
  if (error) {
    window.alert(error);
    return;
  }

  const patch = buildPatchFromDraft();
  const patchId = patch.patch_id;
  const existingIndex = state.review.patches.findIndex((item) => item.patch_id === patchId);
  if (existingIndex >= 0) {
    state.review.patches.splice(existingIndex, 1, patch);
  } else {
    state.review.patches.push(patch);
  }

  state.review.statusMessage = `Saved ${patchId}.`;
  state.review.errorMessage = "";
  state.review.draft = makeEmptyDraft(state.review.draft.page_id);
  persistReviewState();
  renderReviewPanel();
  rerenderChapterPreservingScroll();
}

function loadPatchIntoDraft(patchId) {
  const patch = state.review.patches.find((item) => item.patch_id === patchId);
  if (!patch) {
    return;
  }
  replaceDraft({
    ...patch,
    anchor: {
      insert_after_sentence_id: patch.anchor?.insert_after_sentence_id ?? "",
      insert_before_sentence_id: patch.anchor?.insert_before_sentence_id ?? "",
    },
  });
  rerenderChapterPreservingScroll();
  renderInteractionState();
}

function deletePatch(patchId) {
  state.review.patches = state.review.patches.filter((patch) => patch.patch_id !== patchId);
  if (state.review.draft.patch_id === patchId) {
    state.review.draft = makeEmptyDraft(state.review.draft.page_id);
  }
  persistReviewState();
  renderReviewPanel();
  rerenderChapterPreservingScroll();
}

function reviewExportPayload() {
  return {
    series: state.manifest.series,
    chapter: state.manifest.chapter,
    patches: state.review.patches.map((patch) => ({
      ...patch,
      anchor: {
        insert_after_sentence_id: patch.anchor?.insert_after_sentence_id ?? null,
        insert_before_sentence_id: patch.anchor?.insert_before_sentence_id ?? null,
      },
    })),
  };
}

function downloadTextFile(filename, contents, type = "application/json") {
  const blob = new Blob([contents], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function exportReviewPatches() {
  const payload = JSON.stringify(reviewExportPayload(), null, 2);
  downloadTextFile(`${state.manifest.chapter}-patches.json`, payload);
}

function handleReviewImport(file) {
  if (!file) {
    return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(String(reader.result));
      if (!Array.isArray(parsed.patches)) {
        throw new Error("Patch file is missing a patches array.");
      }
      state.review.patches = parsed.patches;
      state.review.draft = makeEmptyDraft(state.manifest.pages[0]?.id ?? "");
      persistReviewState();
      renderReviewPanel();
      rerenderChapterPreservingScroll();
    } catch (error) {
      window.alert(error.message);
    }
  };
  reader.readAsText(file);
}

function currentDraftPageImage() {
  if (!state.review.draft.page_id) {
    return null;
  }
  return elements.chapterStack.querySelector(
    `.page-frame[data-page-id="${CSS.escape(state.review.draft.page_id)}"] .page-image`,
  );
}

function downloadDraftCrop() {
  if (state.review.draft.region.polygon.length < 3) {
    window.alert("Draw a region first.");
    return;
  }

  const image = currentDraftPageImage();
  if (!image || !image.complete || !image.naturalWidth || !image.naturalHeight) {
    window.alert("The page image is not ready yet.");
    return;
  }

  const xs = state.review.draft.region.polygon.map((point) => point.x);
  const ys = state.review.draft.region.polygon.map((point) => point.y);
  const minX = Math.max(0, Math.min(...xs));
  const maxX = Math.min(1, Math.max(...xs));
  const minY = Math.max(0, Math.min(...ys));
  const maxY = Math.min(1, Math.max(...ys));

  const sourceX = Math.floor(minX * image.naturalWidth);
  const sourceY = Math.floor((1 - maxY) * image.naturalHeight);
  const sourceWidth = Math.max(1, Math.ceil((maxX - minX) * image.naturalWidth));
  const sourceHeight = Math.max(1, Math.ceil((maxY - minY) * image.naturalHeight));

  const canvas = document.createElement("canvas");
  canvas.width = sourceWidth;
  canvas.height = sourceHeight;
  const context = canvas.getContext("2d");
  context.drawImage(
    image,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    sourceWidth,
    sourceHeight,
  );
  canvas.toBlob((blob) => {
    if (!blob) {
      return;
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${state.review.draft.page_id}-${state.review.draft.patch_id || "draft"}-crop.png`;
    link.click();
    URL.revokeObjectURL(url);
  });
}

function reviewStatusText() {
  const draft = state.review.draft;
  const toolLabel =
    state.review.activeTool === "region"
      ? "Click the page to place region points."
      : state.review.activeTool === "guide"
        ? "Click the page to place guide points."
        : "Choose a drawing tool to keep building the patch.";

  return `${toolLabel} Region points: ${draft.region.polygon.length}. Guide points: ${draft.text_flow.guide.length}.`;
}

function reviewPatchListMarkup() {
  if (state.review.patches.length === 0) {
    return `<p class="empty">No saved patches yet.</p>`;
  }

  return `
    <div class="review-patch-list">
      ${state.review.patches
        .map((patch) => {
          const snippet = patch.user_transcript || patch.ocr_candidate || "Untitled patch";
          return `
            <article class="review-patch-item">
              <div>
                <p class="review-patch-title">${escapeHtml(patch.patch_id)}</p>
                <p class="review-patch-meta">${escapeHtml(patch.page_id)} · ${escapeHtml(snippet.slice(0, 28))}</p>
              </div>
              <div class="review-patch-actions">
                <button type="button" data-review-load="${escapeHtml(patch.patch_id)}">Load</button>
                <button type="button" class="secondary" data-review-delete="${escapeHtml(patch.patch_id)}">Delete</button>
              </div>
            </article>
          `;
        })
        .join("")}
    </div>
  `;
}

async function processDraftPatch() {
  const error = validateDraft();
  if (error) {
    window.alert(error);
    return;
  }

  const page = pageEntry(state.review.draft.page_id);
  if (!page) {
    window.alert("Could not find the selected page.");
    return;
  }

  state.review.isProcessing = true;
  state.review.errorMessage = "";
  state.review.statusMessage = "Running OCR and patch pipeline...";
  renderReviewPanel();

  const patch = buildPatchFromDraft();
  const patches = state.review.patches.filter((item) => item.patch_id !== patch.patch_id);
  patches.push(patch);

  try {
    const { response, body } = await postJson("/api/process-patch", {
      series: state.manifest.series,
      chapter: state.manifest.chapter,
      imagePath: page.image,
      patch,
      patches,
    });

    if (!response.ok) {
      const message = body?.error || `Patch processing failed (${response.status}).`;
      if (response.status === 404 || response.status === 501) {
        throw new Error("Patch API is unavailable. Restart the reader with `python3 scripts/serve_reader.py`.");
      }
      throw new Error(message);
    }

    state.review.patches = body?.patches ?? patches;
    replaceDraft(body?.patch ?? patch);
    state.review.needsReload = Boolean(body?.needsReload);
    const transcript = body?.patch?.user_transcript || body?.ocr?.text || patch.user_transcript;
    const translation = body?.analysis?.sentence_translation;
    state.review.statusMessage = translation
      ? `Patch applied for ${body?.patch?.patch_id}. OCR: ${transcript}. Translation: ${translation}. Reload the page to see it.`
      : `Patch applied for ${body?.patch?.patch_id}. Reload the page to see it.`;
    state.review.errorMessage = "";
    rerenderChapterPreservingScroll();
  } catch (processError) {
    state.review.errorMessage = processError.message;
    state.review.statusMessage = "";
  } finally {
    state.review.isProcessing = false;
    renderReviewPanel();
  }
}

function renderReviewPanel() {
  const pageOptions = state.manifest.pages
    .map((page) => {
      const patchCount = getPageReviewPatches(page.id).length;
      const suffix = patchCount > 0 ? ` (${patchCount} saved)` : "";
      return `<option value="${escapeHtml(page.id)}" ${page.id === state.review.draft.page_id ? "selected" : ""}>${escapeHtml(page.id)}${suffix}</option>`;
    })
    .join("");

  const sentences = state.annotations.get(state.review.draft.page_id)?.sentences ?? [];
  const anchorMode = draftAnchorMode();
  const anchorSentenceId = draftAnchorSentenceId();
  const anchorOptions = sentences
    .map(
      (sentence) => `
        <option value="${escapeHtml(sentence.id)}" ${sentence.id === anchorSentenceId ? "selected" : ""}>
          ${escapeHtml(sentence.id)} · ${escapeHtml(sentenceLabel(sentence))}
        </option>
      `,
    )
    .join("");

  const actionSlotMarkup = state.review.isProcessing
    ? `
      <div class="review-loading-wrap" aria-live="polite">
        <span class="review-loading-spinner" aria-hidden="true"></span>
        <span class="review-loading-text">Processing patch...</span>
      </div>
    `
    : `<button type="button" class="secondary page-review-reload" id="reviewReloadPage">Reload Page</button>`;

  elements.reviewPanel.innerHTML = `
    <div class="review-header">
      <div>
        <h2>OCR Review</h2>
        <p class="empty">Draw a missing region, trace the text flow, run OCR + patch, then reload the page to inspect the result.</p>
      </div>
      <label class="toggle">
        <input id="reviewModeToggle" type="checkbox" ${state.review.enabled ? "checked" : ""} />
        <span>Review mode</span>
      </label>
    </div>
    ${state.review.statusMessage ? `<p class="review-feedback success">${escapeHtml(state.review.statusMessage)}</p>` : ""}
    ${state.review.errorMessage ? `<p class="review-feedback error">${escapeHtml(state.review.errorMessage)}</p>` : ""}
    <div class="review-grid">
      <label class="field">
        <span class="label">Segment</span>
        <select id="reviewPageSelect">${pageOptions}</select>
      </label>
      <label class="field">
        <span class="label">Text Flow</span>
        <select id="reviewFlowMode">
          <option value="vertical_rl" ${state.review.draft.text_flow.mode === "vertical_rl" ? "selected" : ""}>Vertical right-to-left</option>
          <option value="vertical_lr" ${state.review.draft.text_flow.mode === "vertical_lr" ? "selected" : ""}>Vertical left-to-right</option>
          <option value="horizontal_ltr" ${state.review.draft.text_flow.mode === "horizontal_ltr" ? "selected" : ""}>Horizontal left-to-right</option>
          <option value="horizontal_rtl" ${state.review.draft.text_flow.mode === "horizontal_rtl" ? "selected" : ""}>Horizontal right-to-left</option>
        </select>
      </label>
    </div>
    <div class="review-toolbar">
      <button type="button" class="${state.review.activeTool === "region" ? "active" : ""}" id="reviewRegionTool">Draw Region</button>
      <button type="button" class="${state.review.activeTool === "guide" ? "active" : ""}" id="reviewGuideTool">Draw Guide</button>
      <button type="button" class="secondary" id="reviewUndoPoint">Undo Point</button>
      <button type="button" class="secondary" id="reviewClearCurrent">Clear Current Tool</button>
      <button type="button" class="secondary" id="reviewResetDraft">Reset Draft</button>
    </div>
    <p class="review-status">${escapeHtml(reviewStatusText())}</p>
    <label class="field">
      <span class="label">OCR Candidate</span>
      <textarea id="reviewOcrCandidate" rows="3" placeholder="Paste the focused OCR result here if you ran it on the crop.">${escapeHtml(state.review.draft.ocr_candidate)}</textarea>
    </label>
    <label class="field">
      <span class="label">Accepted Transcript</span>
      <textarea id="reviewTranscript" rows="3" placeholder="Confirm or correct the final transcript.">${escapeHtml(state.review.draft.user_transcript)}</textarea>
    </label>
    <div class="review-grid">
      <label class="field">
        <span class="label">Insert</span>
        <select id="reviewAnchorMode">
          <option value="append" ${anchorMode === "append" ? "selected" : ""}>Append at end</option>
          <option value="after" ${anchorMode === "after" ? "selected" : ""}>After sentence</option>
          <option value="before" ${anchorMode === "before" ? "selected" : ""}>Before sentence</option>
        </select>
      </label>
      ${anchorMode === "append"
        ? ""
        : `
      <label class="field">
        <span class="label">Anchor Sentence</span>
        <select id="reviewAnchorSentence">
          <option value="">Choose sentence</option>
          ${anchorOptions}
        </select>
      </label>
      `}
    </div>
    <label class="field">
      <span class="label">Notes</span>
      <textarea id="reviewNotes" rows="2" placeholder="Optional context for the later Codex run.">${escapeHtml(state.review.draft.notes)}</textarea>
    </label>
    <div class="review-toolbar">
      <button type="button" id="reviewDownloadCrop">Download Crop</button>
      <button type="button" id="reviewSavePatch">Save Patch</button>
      <button type="button" id="reviewProcessPatch" ${state.review.isProcessing ? "disabled" : ""}>Run OCR + Patch</button>
      <button type="button" class="secondary" id="reviewExport">Export Patches JSON</button>
      <button type="button" class="secondary" id="reviewImport">Import JSON</button>
    </div>
    <div class="page-review-actions">
      ${actionSlotMarkup}
    </div>
    <div class="review-list-wrap">
      <p class="label">Saved Patches</p>
      ${reviewPatchListMarkup()}
    </div>
  `;

  const reviewModeToggle = elements.reviewPanel.querySelector("#reviewModeToggle");
  const reviewPageSelect = elements.reviewPanel.querySelector("#reviewPageSelect");
  const reviewFlowMode = elements.reviewPanel.querySelector("#reviewFlowMode");
  const reviewRegionTool = elements.reviewPanel.querySelector("#reviewRegionTool");
  const reviewGuideTool = elements.reviewPanel.querySelector("#reviewGuideTool");
  const reviewUndoPoint = elements.reviewPanel.querySelector("#reviewUndoPoint");
  const reviewClearCurrent = elements.reviewPanel.querySelector("#reviewClearCurrent");
  const reviewResetDraft = elements.reviewPanel.querySelector("#reviewResetDraft");
  const reviewOcrCandidate = elements.reviewPanel.querySelector("#reviewOcrCandidate");
  const reviewTranscript = elements.reviewPanel.querySelector("#reviewTranscript");
  const reviewAnchorMode = elements.reviewPanel.querySelector("#reviewAnchorMode");
  const reviewAnchorSentence = elements.reviewPanel.querySelector("#reviewAnchorSentence");
  const reviewNotes = elements.reviewPanel.querySelector("#reviewNotes");
  const reviewDownloadCrop = elements.reviewPanel.querySelector("#reviewDownloadCrop");
  const reviewSavePatch = elements.reviewPanel.querySelector("#reviewSavePatch");
  const reviewProcessPatch = elements.reviewPanel.querySelector("#reviewProcessPatch");
  const reviewExport = elements.reviewPanel.querySelector("#reviewExport");
  const reviewImport = elements.reviewPanel.querySelector("#reviewImport");
  const reviewReloadPage = elements.reviewPanel.querySelector("#reviewReloadPage");

  reviewModeToggle.addEventListener("change", (event) => {
    state.review.enabled = event.target.checked;
    renderReviewPanel();
    rerenderChapterPreservingScroll();
    renderInteractionState();
  });
  reviewPageSelect.addEventListener("change", (event) => setDraftPage(event.target.value));
  reviewFlowMode.addEventListener("change", (event) => updateDraftField("text_flow.mode", event.target.value));
  reviewRegionTool.addEventListener("click", () => setActiveReviewTool("region"));
  reviewGuideTool.addEventListener("click", () => setActiveReviewTool("guide"));
  reviewUndoPoint.addEventListener("click", () => undoDraftPoint(state.review.activeTool));
  reviewClearCurrent.addEventListener("click", () => clearDraftGeometry(state.review.activeTool));
  reviewResetDraft.addEventListener("click", () => clearDraftGeometry(null));
  reviewOcrCandidate.addEventListener("input", (event) => updateDraftField("ocr_candidate", event.target.value));
  reviewTranscript.addEventListener("input", (event) => updateDraftField("user_transcript", event.target.value));
  reviewAnchorMode.addEventListener("change", (event) => {
    const mode = event.target.value;
    setDraftAnchor(mode, mode === "append" ? "" : draftAnchorSentenceId());
  });
  if (reviewAnchorSentence) {
    reviewAnchorSentence.addEventListener("change", (event) => {
      setDraftAnchor(reviewAnchorMode.value, event.target.value);
    });
  }
  reviewNotes.addEventListener("input", (event) => updateDraftField("notes", event.target.value));
  reviewDownloadCrop.addEventListener("click", () => downloadDraftCrop());
  reviewSavePatch.addEventListener("click", () => saveDraftPatch());
  reviewProcessPatch.addEventListener("click", () => processDraftPatch());
  reviewExport.addEventListener("click", () => exportReviewPatches());
  reviewImport.addEventListener("click", () => elements.reviewImportInput.click());
  if (reviewReloadPage) {
    reviewReloadPage.addEventListener("click", async () => {
      await reloadPageById(state.review.draft.page_id);
      state.review.needsReload = false;
      state.review.statusMessage = `Reloaded ${state.review.draft.page_id}.`;
      renderReviewPanel();
    });
  }

  for (const button of elements.reviewPanel.querySelectorAll("[data-review-load]")) {
    button.addEventListener("click", () => loadPatchIntoDraft(button.dataset.reviewLoad));
  }

  for (const button of elements.reviewPanel.querySelectorAll("[data-review-delete]")) {
    button.addEventListener("click", () => deletePatch(button.dataset.reviewDelete));
  }
}

function appendReviewOverlays(overlay, pageId) {
  const reviewLayer = document.createElement("div");
  reviewLayer.className = "review-layer";

  for (const patch of getPageReviewPatches(pageId)) {
    if (patch.region?.polygon?.length >= 3) {
      const polygon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      polygon.setAttribute("viewBox", "0 0 1 1");
      polygon.setAttribute("class", "review-svg");
      polygon.setAttribute("preserveAspectRatio", "none");
      polygon.innerHTML = `<polygon class="saved-region" points="${polygonSvgPoints(patch.region.polygon)}"></polygon>`;
      reviewLayer.appendChild(polygon);
    }

    if (patch.text_flow?.guide?.length >= 2) {
      const guide = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      guide.setAttribute("viewBox", "0 0 1 1");
      guide.setAttribute("class", "review-svg");
      guide.setAttribute("preserveAspectRatio", "none");
      guide.innerHTML = `<polyline class="saved-guide" points="${polylineSvgPoints(patch.text_flow.guide)}"></polyline>`;
      reviewLayer.appendChild(guide);
    }
  }

  if (state.review.draft.page_id === pageId) {
    if (state.review.draft.region.polygon.length >= 1) {
      const polygon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      polygon.setAttribute("viewBox", "0 0 1 1");
      polygon.setAttribute("class", "review-svg");
      polygon.setAttribute("preserveAspectRatio", "none");
      if (state.review.draft.region.polygon.length >= 3) {
        polygon.innerHTML = `<polygon class="draft-region" points="${polygonSvgPoints(state.review.draft.region.polygon)}"></polygon>`;
      } else {
        polygon.innerHTML = `<polyline class="draft-region-outline" points="${polylineSvgPoints(state.review.draft.region.polygon)}"></polyline>`;
      }
      reviewLayer.appendChild(polygon);
    }

    if (state.review.draft.text_flow.guide.length >= 1) {
      const guide = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      guide.setAttribute("viewBox", "0 0 1 1");
      guide.setAttribute("class", "review-svg");
      guide.setAttribute("preserveAspectRatio", "none");
      guide.innerHTML = `<polyline class="draft-guide" points="${polylineSvgPoints(state.review.draft.text_flow.guide)}"></polyline>`;
      reviewLayer.appendChild(guide);
    }

    for (const point of state.review.draft.region.polygon) {
      const handle = document.createElement("span");
      handle.className = "review-point draft";
      const position = normalizedPointToCss(point);
      handle.style.left = position.left;
      handle.style.top = position.top;
      reviewLayer.appendChild(handle);
    }

    for (const point of state.review.draft.text_flow.guide) {
      const handle = document.createElement("span");
      handle.className = "review-point guide";
      const position = normalizedPointToCss(point);
      handle.style.left = position.left;
      handle.style.top = position.top;
      reviewLayer.appendChild(handle);
    }
  }

  const reviewSurface = document.createElement("button");
  reviewSurface.type = "button";
  reviewSurface.className = "review-surface";
  reviewSurface.dataset.pageId = pageId;
  reviewSurface.disabled =
    !state.review.enabled ||
    !state.review.activeTool;
  reviewSurface.addEventListener("click", (event) => {
    if (reviewSurface.disabled) {
      return;
    }
    if (state.review.draft.page_id !== pageId) {
      state.review.draft = makeEmptyDraft(pageId);
    }
    const point = pointerToNormalizedPoint(event, reviewSurface);
    addDraftPoint(state.review.activeTool, point);
  });

  overlay.append(reviewLayer, reviewSurface);
}

function buildPageFrame(page, index) {
  if (!state.annotations.has(page.id)) {
    return null;
  }

  const annotation = state.annotations.get(page.id);
  const wordById = new Map(annotation.words.map((word) => [word.id, word]));
  const sentenceById = new Map(
    annotation.sentences.map((sentence) => [sentence.id, sentence]),
  );
  const charactersById = new Map(
    annotation.characters.map((character) => [character.id, character]),
  );

  const frame = document.createElement("section");
  frame.className = "page-frame";
  frame.dataset.pageId = page.id;

  const header = document.createElement("div");
  header.className = "page-header";

  const savedPatchCount = getPageReviewPatches(page.id).length;
  const patchBadge = savedPatchCount > 0 ? `<span class="page-badge">${savedPatchCount} patches</span>` : "";
  header.innerHTML = `
    <div>
      <p class="page-title">Segment ${index + 1}</p>
      <span class="page-meta">${page.id}</span>
      ${patchBadge}
    </div>
    <button type="button" class="secondary page-review-button">Use For Patch</button>
  `;

  header.querySelector(".page-review-button").addEventListener("click", () => setDraftPage(page.id));

  const canvas = document.createElement("div");
  canvas.className = "page-canvas";

  const image = document.createElement("img");
  image.className = "page-image";
  image.alt = `Chapter segment ${index + 1}`;
  image.src = imagePath(page.image);

  const overlay = document.createElement("div");
  overlay.className = "overlay";

  const lowlight = document.createElement("div");
  lowlight.className = "page-lowlight";
  overlay.appendChild(lowlight);

  const debugLabel = document.createElement("div");
  debugLabel.className = "debug-page-label";
  debugLabel.classList.toggle("visible", state.showDebugPolygons);
  debugLabel.innerHTML = `
    <span class="debug-page-label-eyebrow">Segment ${index + 1}</span>
    <span class="debug-page-label-id">${page.id}</span>
    <span class="debug-page-label-file">${annotation.sourceImage ?? page.image}</span>
  `;
  overlay.appendChild(debugLabel);

  const wordFocus = document.createElement("div");
  wordFocus.className = "word-focus";
  overlay.appendChild(wordFocus);

  const sentenceFocus = document.createElement("div");
  sentenceFocus.className = "sentence-focus";
  overlay.appendChild(sentenceFocus);

  canvas.addEventListener("click", (event) => {
    if (!state.showDebugPolygons || event.target.closest(".hotspot")) {
      return;
    }

    event.stopPropagation();
    selectDebugPage(page.id);
    state.hoveredWordKey = null;
    state.activeSentenceKey = null;
    hideHoverTooltip();
    if (hoverIntentTimer) {
      clearTimeout(hoverIntentTimer);
      hoverIntentTimer = null;
    }
    renderEmptyPanels();
    renderInteractionState();
  });

  for (const character of annotation.characters) {
    const fallbackPolygon = character.box
      ? [
          { x: character.box.x, y: character.box.y + character.box.height },
          { x: character.box.x + character.box.width, y: character.box.y + character.box.height },
          { x: character.box.x + character.box.width, y: character.box.y },
          { x: character.box.x, y: character.box.y },
        ]
      : [];
    const geometry = polygonToStyle(character.polygon ?? fallbackPolygon);
    const currentWord = wordById.get(character.wordId);
    if (isPunctuationOnly(currentWord?.text ?? character.text)) {
      continue;
    }
    const hotspot = document.createElement("button");
    hotspot.className = "hotspot";
    hotspot.type = "button";
    applyGeometry(hotspot, geometry);
    hotspot.dataset.characterKey = characterKey(page.id, character.id);
    hotspot.dataset.wordKey = wordKey(page.id, character.wordId);
    hotspot.dataset.sentenceKey = sentenceKey(page.id, character.sentenceId);

    hotspot.addEventListener("mouseenter", (event) => {
      if (state.review.enabled) {
        return;
      }
      const nextWordKey = wordKey(page.id, character.wordId);
      if (hoverIntentTimer) {
        clearTimeout(hoverIntentTimer);
      }

      hoverIntentTimer = setTimeout(() => {
        hoverIntentTimer = null;
        if (state.hoveredWordKey !== nextWordKey) {
          state.hoveredWordKey = nextWordKey;
        }
        updateWordPanel(currentWord);
        showHoverTooltip(tooltipForWord(currentWord, character.text), event.clientX, event.clientY);
        renderInteractionState();
      }, 100);
    });

    hotspot.addEventListener("mouseleave", () => {
      if (state.review.enabled) {
        return;
      }
      if (hoverIntentTimer) {
        clearTimeout(hoverIntentTimer);
        hoverIntentTimer = null;
      }
      if (state.hoveredWordKey === wordKey(page.id, character.wordId)) {
        state.hoveredWordKey = null;
        elements.wordPanel.innerHTML = `<h2>Word</h2><p class="empty">Hover a character hotspot.</p>`;
        renderInteractionState();
      }
      hideHoverTooltip();
    });

    hotspot.addEventListener("click", () => {
      const sentence = sentenceById.get(character.sentenceId);
      selectDebugPage(page.id);
      if (state.review.enabled) {
        return;
      }
      state.hoveredWordKey = wordKey(page.id, character.wordId);
      state.activeSentenceKey = sentenceKey(page.id, character.sentenceId);
      hideHoverTooltip();
      if (hoverIntentTimer) {
        clearTimeout(hoverIntentTimer);
        hoverIntentTimer = null;
      }
      updateWordPanel(currentWord);
      updateSentencePanel(
        sentence,
        state.showDebugPolygons
          ? { polygon: sentencePolygon(sentence, charactersById) }
          : {},
      );
      renderInteractionState();
    });

    overlay.appendChild(hotspot);
  }

  appendReviewOverlays(overlay, page.id);

  canvas.append(image, overlay);
  frame.append(header, canvas);
  return frame;
}

function renderChapter() {
  elements.chapterStack.innerHTML = "";

  let totalCharacters = 0;
  for (const [pageIndex, page] of state.manifest.pages.entries()) {
    const annotation = state.annotations.get(page.id);
    if (!annotation) {
      continue;
    }
    totalCharacters += annotation.characters.length;
    const frame = buildPageFrame(page, pageIndex);
    if (frame) {
      elements.chapterStack.appendChild(frame);
    }
  }

  if (totalCharacters === 0) {
    renderNoOcrState();
  }
}

async function init() {
  elements = {
    chapterPanel: document.querySelector("#chapterPanel"),
    chapterStack: document.querySelector("#chapterStack"),
    wordPanel: document.querySelector("#wordPanel"),
    sentencePanel: document.querySelector("#sentencePanel"),
    pageReviewPanel: document.querySelector("#pageReviewPanel"),
    reviewPanel: document.querySelector("#reviewPanel"),
    reviewImportInput: document.querySelector("#reviewImportInput"),
    debugToggle: document.querySelector("#debugToggle"),
    hoverTooltip: document.querySelector("#hoverTooltip"),
  };

  for (const [key, value] of Object.entries(elements)) {
    if (!value) {
      throw new Error(`Missing reader element: ${key}`);
    }
  }

  elements.reviewImportInput.addEventListener("change", (event) => {
    handleReviewImport(event.target.files?.[0] ?? null);
    event.target.value = "";
  });

  elements.debugToggle.addEventListener("change", (event) => {
    state.showDebugPolygons = event.target.checked;
    rerenderChapterPreservingScroll();
    refreshPanelsFromSelection();
    renderPageReviewPanel();
    renderInteractionState();
  });
  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const clickedHotspot = target?.closest(".hotspot");
    const clickedToggle = target?.closest(".debug-corner-toggle");
    const clickedPageReview = target?.closest("#pageReviewPanel");
    const clickedReview = target?.closest(".review-panel");
    if (!clickedHotspot && !clickedToggle && !clickedPageReview && !clickedReview) {
      clearInteractionState();
    }
  });

  renderEmptyPanels();
  renderEmptyPageReviewPanel();
  await bootstrapChapterData();
  renderChapterPanel();
  renderReviewPanel();
  renderChapter();
  renderInteractionState();
}

init().catch((error) => {
  console.error(error);
  document.body.innerHTML = `<pre>${error.message}</pre>`;
});
