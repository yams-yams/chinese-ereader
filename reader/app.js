const manifestUrl =
  "../data/processed/chapters/renjian-bailijin/chapter-001.json";

const state = {
  manifest: null,
  annotations: new Map(),
  activeCharacterKey: null,
};

let elements;

async function loadJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    return null;
  }
  return response.json();
}

function panelMarkup(title, fields) {
  return `
    <h2>${title}</h2>
    ${fields
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

function imagePath(relativePath) {
  return `../${relativePath}`;
}

async function loadAnnotations() {
  const annotationPromises = state.manifest.pages.map(async (page) => {
    const annotation =
      (await loadJson(imagePath(page.annotation))) ?? {
        sourceImage: page.image,
        characters: [],
        words: [],
        sentences: [],
      };
    state.annotations.set(page.id, annotation);
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

function renderNoOcrState() {
  elements.wordPanel.innerHTML = `<h2>Word</h2><p class="empty">No OCR annotations are loaded yet for this chapter.</p>`;
  elements.sentencePanel.innerHTML = `<h2>Sentence</h2><p class="empty">Sentence annotations will appear here after OCR succeeds.</p>`;
}

function characterKey(pageId, characterId) {
  return `${pageId}:${characterId}`;
}

function renderActiveCharacter() {
  for (const hotspot of elements.chapterStack.querySelectorAll(".hotspot")) {
    hotspot.classList.toggle("active", hotspot.dataset.characterKey === state.activeCharacterKey);
  }
}

function updateWordPanel(word) {
  if (!word) {
    return;
  }
  elements.wordPanel.innerHTML = panelMarkup("Word", [
    { label: "Chinese", value: word.text },
    { label: "Pinyin", value: word.pinyin },
    { label: "English", value: word.translation ?? "Pending" },
  ]);
}

function updateSentencePanel(sentence) {
  if (!sentence) {
    return;
  }
  elements.sentencePanel.innerHTML = panelMarkup("Sentence", [
    { label: "Chinese", value: sentence.text },
    { label: "Pinyin", value: sentence.pinyin },
    { label: "English", value: sentence.translation ?? "Pending" },
  ]);
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

  const frame = document.createElement("section");
  frame.className = "page-frame";

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

  for (const character of annotation.characters) {
    const hotspot = document.createElement("button");
    hotspot.className = "hotspot";
    hotspot.type = "button";
    hotspot.style.left = `${character.box.x * 100}%`;
    hotspot.style.top = `${(1 - character.box.y - character.box.height) * 100}%`;
    hotspot.style.width = `${character.box.width * 100}%`;
    hotspot.style.height = `${character.box.height * 100}%`;
    hotspot.title = character.text;
    hotspot.dataset.characterKey = characterKey(page.id, character.id);

    hotspot.addEventListener("mouseenter", () => {
      updateWordPanel(wordById.get(character.wordId));
    });

    hotspot.addEventListener("click", () => {
      state.activeCharacterKey = characterKey(page.id, character.id);
      updateSentencePanel(sentenceById.get(character.sentenceId));
      renderActiveCharacter();
    });

    if (state.activeCharacterKey === characterKey(page.id, character.id)) {
      hotspot.classList.add("active");
    }

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
  };

  for (const [key, value] of Object.entries(elements)) {
    if (!value) {
      throw new Error(`Missing reader element: ${key}`);
    }
  }

  state.manifest = await loadJson(manifestUrl);
  renderEmptyPanels();
  renderChapterPanel();
  await loadAnnotations();
  renderChapter();
}

init().catch((error) => {
  console.error(error);
  document.body.innerHTML = `<pre>${error.message}</pre>`;
});
