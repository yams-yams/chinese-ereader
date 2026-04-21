const chaptersApiUrl = "/api/chapters";

const PUNCTUATION_ONLY_RE = /^[\s.,!?;:'"()[\]{}\-_/\\|`~@#$%^&*+=<>，。！？、；：‘’“”《》〈〉「」『』（）【】…·—]+$/;

const state = {
  chapterIndex: [],
  readModel: null,
  annotations: new Map(),
  hoveredWordKey: null,
  activeSentenceKey: null,
};

let elements;
let hoverIntentTimer = null;

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
  return state.readModel?.title ?? `${state.readModel?.series ?? ""} / ${state.readModel?.chapter ?? ""}`.trim();
}

function segmentEntries() {
  return state.readModel?.segments ?? [];
}

function currentChapterChoice() {
  return state.chapterIndex.find(
    (entry) => entry.series === state.readModel?.series && entry.chapter === state.readModel?.chapter,
  ) ?? null;
}

function updateChapterUrl(series, chapter) {
  const url = new URL(window.location.href);
  url.searchParams.set("series", series);
  url.searchParams.set("chapter", chapter);
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

function buildAnnotationMapFromReadModel(model) {
  const sentencesBySegment = groupBySegment(model?.sentences ?? []);
  const wordsBySegment = groupBySegment(model?.words ?? []);
  const charactersBySegment = groupBySegment(model?.characters ?? []);
  const annotations = new Map();

  for (const segment of model?.segments ?? []) {
    const activeSentences = (sentencesBySegment.get(segment.id) ?? [])
      .filter((sentence) => (sentence.status ?? "active") !== "deleted")
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
  const notes = state.readModel?.chapterNotes ?? [];
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
  }
}

function renderInteractionState() {
  updateFocusOverlays();

  for (const focus of elements.chapterStack.querySelectorAll(".word-focus")) {
    focus.classList.toggle("visible", focus.dataset.wordKey === state.hoveredWordKey);
  }

  for (const focus of elements.chapterStack.querySelectorAll(".sentence-focus")) {
    focus.classList.toggle("visible", focus.dataset.sentenceKey === state.activeSentenceKey);
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
  renderInteractionState();
}

function renderChapterPanel() {
  const chapterOptions = state.chapterIndex.length > 0
    ? state.chapterIndex
      .map((chapter) => {
        const value = `${chapter.series}::${chapter.chapter}`;
        const selected = chapter.series === state.readModel.series && chapter.chapter === state.readModel.chapter;
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
    <p><span class="label">Series</span>${escapeHtml(state.readModel.series)}</p>
    <p><span class="label">Chapter</span>${escapeHtml(state.readModel.chapter)}</p>
  `;

  const chapterSelect = elements.chapterPanel.querySelector("#chapterSelect");
  if (chapterSelect) {
    chapterSelect.addEventListener("change", async (event) => {
      const [series, chapter] = String(event.target.value).split("::");
      if (!series || !chapter) {
        return;
      }
      await loadReadChapterFromApi(series, chapter);
      renderNotesPanel();
      renderChapterPanel();
      renderChapter();
      refreshPanelsFromSelection();
      renderInteractionState();
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

    hotspot.addEventListener("click", () => {
      const sentence = sentencesById.get(character.sentenceId);
      state.hoveredWordKey = wordKey(segment.id, character.wordId);
      state.activeSentenceKey = sentenceKey(segment.id, character.sentenceId);
      hideHoverTooltip();
      if (hoverIntentTimer) {
        clearTimeout(hoverIntentTimer);
        hoverIntentTimer = null;
      }
      updateWordPanel(currentWord);
      updateSentencePanel(sentence);
      renderInteractionState();
    });

    overlay.appendChild(hotspot);
  }

  canvas.append(image, overlay);
  frame.append(canvas);
  return frame;
}

function renderNoReadState() {
  elements.wordPanel.innerHTML = `<h2>Word</h2><p class="empty">No learner-ready word data is loaded for this chapter.</p>`;
  elements.sentencePanel.innerHTML = `<h2>Sentence</h2><p class="empty">Sentence details will appear here when a read model is available.</p>`;
}

function renderChapter() {
  elements.chapterStack.innerHTML = "";

  let totalCharacters = 0;
  for (const segment of segmentEntries()) {
    const annotation = state.annotations.get(segment.id);
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
}

function setReadModel(model) {
  state.readModel = model;
  state.annotations = buildAnnotationMapFromReadModel(model);
  state.hoveredWordKey = null;
  state.activeSentenceKey = null;
  hideHoverTooltip();
}

async function loadReadChapterFromApi(series, chapter) {
  const readModel = await loadJson(`/api/chapters/${series}/${chapter}/read`);
  if (!readModel) {
    throw new Error(`Could not load read data for ${series} / ${chapter}.`);
  }

  setReadModel(readModel);
  updateChapterUrl(series, chapter);
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
  const selectedChapter = chapters.find(
    (entry) => entry.series === requestedSeries && entry.chapter === requestedChapter && entry.hasReadModel,
  ) ?? chapters.find((entry) => entry.hasReadModel) ?? null;

  if (!selectedChapter) {
    throw new Error("No chapter with a persisted read model is currently available.");
  }

  await loadReadChapterFromApi(selectedChapter.series, selectedChapter.chapter);
}

async function init() {
  elements = {
    chapterPanel: document.querySelector("#chapterPanel"),
    wordPanel: document.querySelector("#wordPanel"),
    sentencePanel: document.querySelector("#sentencePanel"),
    notesToggle: document.querySelector("#notesToggle"),
    notesPanel: document.querySelector("#notesPanel"),
    notesBody: document.querySelector("#notesPanel .notes-body"),
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

  renderEmptyPanels();
  renderEmptyNotesPanel();
  setNotesExpanded(false);
  await bootstrapChapterData();
  renderChapterPanel();
  renderChapter();
  renderInteractionState();

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
