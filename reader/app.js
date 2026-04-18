const manifestUrl =
  "../data/processed/chapters/renjian-bailijin/chapter-001.json";

const state = {
  manifest: null,
  annotations: new Map(),
  rawAnnotations: new Map(),
  deletedSentenceIdsByPage: new Map(),
  enrichment: null,
  hoveredWordKey: null,
  activeSentenceKey: null,
  selectedDebugPageId: null,
  showDebugPolygons: false,
};

let elements;
let hoverIntentTimer = null;
const PUNCTUATION_ONLY_RE = /^[\s.,!?;:'"()[\]{}\-_/\\|`~@#$%^&*+=<>，。！？、；：‘’“”《》〈〉「」『』（）【】…·—]+$/;

async function loadJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    return null;
  }
  return response.json();
}

function panelMarkup(title, fields) {
  return `
    <h2>${title}</h2>
    ${fields
      .filter(({ value }) => value !== null && value !== undefined && value !== "")
      .map(
        ({ label, value }) => `
          <p><span class="label">${label}</span>${value ?? "Pending"}</p>
        `
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

function filteredAnnotationForPage(pageId) {
  const rawAnnotation = state.rawAnnotations.get(pageId);
  if (!rawAnnotation) {
    return null;
  }

  const deletedSentenceIds = state.deletedSentenceIdsByPage.get(pageId) ?? new Set();
  if (deletedSentenceIds.size === 0) {
    return {
      ...rawAnnotation,
      characters: rawAnnotation.characters.map((character) => ({ ...character })),
      words: rawAnnotation.words.map((word) => ({ ...word })),
      sentences: rawAnnotation.sentences.map((sentence) => ({ ...sentence })),
    };
  }

  const keptSentences = rawAnnotation.sentences
    .filter((sentence) => !deletedSentenceIds.has(sentence.id))
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

  const annotation = state.annotations.get(state.selectedDebugPageId);
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
            return `
              <div class="page-review-item ${isActive ? "active" : ""}" data-sentence-id="${sentence.id}">
                <button
                  class="page-review-delete"
                  type="button"
                  data-delete-sentence-id="${sentence.id}"
                  aria-label="Delete sentence ${index + 1}"
                  title="Delete sentence"
                >🗑</button>
                <button
                  class="page-review-body"
                  type="button"
                  data-select-sentence-id="${sentence.id}"
                >
                  <p class="page-review-index">Sentence ${index + 1}</p>
                  <p class="page-review-text">${sentenceDisplayText(sentence, index)}</p>
                </button>
              </div>
            `;
          })
          .join("")}
      </div>
    `
    : `<p class="empty">No OCR sentences remain on this page.</p>`;

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

  const page = pageEntry(state.selectedDebugPageId);
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
  state.deletedSentenceIdsByPage.delete(state.selectedDebugPageId);
  rebuildAnnotation(state.selectedDebugPageId);
  rerenderChapterPreservingScroll();
  refreshPanelsFromSelection();
  renderPageReviewPanel();
  renderInteractionState();
}

function selectSentenceFromReviewPanel(pageId, sentenceId) {
  const annotation = state.annotations.get(pageId);
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

  const charactersById = new Map(
    annotation.characters.map((character) => [character.id, character]),
  );
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

async function deleteSentenceFromPage(pageId, sentenceId) {
  const annotation = state.annotations.get(pageId);
  const sentence = annotation?.sentences.find((candidate) => candidate.id === sentenceId);
  if (!sentence) {
    return;
  }

  const confirmed = window.confirm(`Delete "${sentenceDisplayText(sentence, 0)}" from ${pageId}?`);
  if (!confirmed) {
    return;
  }

  const page = pageEntry(pageId);
  if (!page) {
    return;
  }

  const response = await fetch("/api/delete-sentence", {
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
      window.alert("Delete API is unavailable. Restart the reader with `python3 scripts/serve_reader.py`.");
    } else {
      window.alert(`Failed to delete the sentence from disk (${response.status}). ${responseText}`);
    }
    return;
  }

  const updatedAnnotation = await response.json();
  state.rawAnnotations.set(pageId, updatedAnnotation);
  state.deletedSentenceIdsByPage.delete(pageId);

  if (sentenceKey(pageId, sentenceId) === state.activeSentenceKey) {
    state.activeSentenceKey = null;
  }

  rebuildAnnotation(pageId);
  rerenderChapterPreservingScroll();
  refreshPanelsFromSelection();
  renderPageReviewPanel();
  renderInteractionState();
}

async function loadEnrichment() {
  const enrichmentPath = enrichmentPathForManifest(state.manifest);
  if (!enrichmentPath) {
    state.enrichment = null;
    return;
  }

  state.enrichment = await loadJson(enrichmentPath);
}

async function loadAnnotations() {
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

function renderChapterPanel() {
  elements.chapterPanel.innerHTML = panelMarkup("Chapter", [
    { label: "Series", value: state.manifest.series },
    { label: "Chapter", value: state.manifest.chapter },
    { label: "Segments", value: String(state.manifest.pageCount) },
  ]);
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
    for (const [pageId, annotation] of state.annotations.entries()) {
      const sentenceId = keyId(state.activeSentenceKey);
      const sentence = annotation.sentences.find((candidate) => candidate.id === sentenceId);
      if (!sentence || sentenceKey(pageId, sentence.id) !== state.activeSentenceKey) {
        continue;
      }

      const charactersById = new Map(
        annotation.characters.map((character) => [character.id, character]),
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

  elements.sentencePanel.innerHTML = `<h2>Sentence</h2><p class="empty">Click a character hotspot.</p>`;
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
  header.innerHTML = `
    <p class="page-title">Segment ${index + 1}</p>
    <span class="page-meta">${page.id}</span>
  `;

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
    debugToggle: document.querySelector("#debugToggle"),
    hoverTooltip: document.querySelector("#hoverTooltip"),
  };

  for (const [key, value] of Object.entries(elements)) {
    if (!value) {
      throw new Error(`Missing reader element: ${key}`);
    }
  }

  state.manifest = await loadJson(manifestUrl);
  elements.debugToggle.addEventListener("change", (event) => {
    state.showDebugPolygons = event.target.checked;
    rerenderChapterPreservingScroll();
    refreshPanelsFromSelection();
    renderPageReviewPanel();
    renderInteractionState();
  });
  document.addEventListener("click", (event) => {
    const clickedHotspot = event.target.closest(".hotspot");
    const clickedToggle = event.target.closest(".debug-corner-toggle");
    const clickedReviewPanel = event.target.closest("#pageReviewPanel");
    if (!clickedHotspot && !clickedToggle && !clickedReviewPanel) {
      clearInteractionState();
    }
  });
  renderEmptyPanels();
  renderEmptyPageReviewPanel();
  renderChapterPanel();
  await loadEnrichment();
  await loadAnnotations();
  renderChapter();
  renderInteractionState();
}

init().catch((error) => {
  console.error(error);
  document.body.innerHTML = `<pre>${error.message}</pre>`;
});
