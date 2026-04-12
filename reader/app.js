const manifestUrl =
  "../data/processed/chapters/renjian-bailijin/chapter-001.json";

const state = {
  manifest: null,
  pageIndex: 0,
  annotations: new Map(),
  activeCharacterId: null,
};

const elements = {
  pageImage: document.querySelector("#pageImage"),
  overlay: document.querySelector("#overlay"),
  prevPage: document.querySelector("#prevPage"),
  nextPage: document.querySelector("#nextPage"),
  pageLabel: document.querySelector("#pageLabel"),
  wordPanel: document.querySelector("#wordPanel"),
  sentencePanel: document.querySelector("#sentencePanel"),
};

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

function getCurrentPage() {
  return state.manifest.pages[state.pageIndex];
}

function imagePath(relativePath) {
  return `../${relativePath}`;
}

async function loadPage(index) {
  state.pageIndex = index;
  state.activeCharacterId = null;
  renderEmptyPanels();

  const page = getCurrentPage();
  elements.pageLabel.textContent = `Page ${index + 1} / ${state.manifest.pageCount}`;
  elements.prevPage.disabled = index === 0;
  elements.nextPage.disabled = index === state.manifest.pageCount - 1;

  if (!state.annotations.has(page.id)) {
    const annotation =
      (await loadJson(imagePath(page.annotation))) ?? {
        sourceImage: page.image,
        characters: [],
        words: [],
        sentences: [],
      };
    state.annotations.set(page.id, annotation);
  }

  elements.pageImage.src = imagePath(page.image);
  await elements.pageImage.decode();
  renderOverlay();
}

function renderOverlay() {
  const page = getCurrentPage();
  const annotation = state.annotations.get(page.id);
  elements.overlay.innerHTML = "";

  const wordById = new Map(annotation.words.map((word) => [word.id, word]));
  const sentenceById = new Map(
    annotation.sentences.map((sentence) => [sentence.id, sentence]),
  );

  if (annotation.characters.length === 0) {
    elements.wordPanel.innerHTML = `<h2>Word</h2><p class="empty">No OCR annotations yet for this page.</p>`;
    elements.sentencePanel.innerHTML = `<h2>Sentence</h2><p class="empty">Sentence annotations will appear here after OCR succeeds.</p>`;
  }

  for (const character of annotation.characters) {
    const hotspot = document.createElement("button");
    hotspot.className = "hotspot";
    hotspot.type = "button";
    hotspot.style.left = `${character.box.x * 100}%`;
    hotspot.style.top = `${(1 - character.box.y - character.box.height) * 100}%`;
    hotspot.style.width = `${character.box.width * 100}%`;
    hotspot.style.height = `${character.box.height * 100}%`;
    hotspot.title = character.text;
    hotspot.dataset.characterId = character.id;

    hotspot.addEventListener("mouseenter", () => {
      const word = wordById.get(character.wordId);
      if (!word) {
        return;
      }
      elements.wordPanel.innerHTML = panelMarkup("Word", [
        { label: "Chinese", value: word.text },
        { label: "Pinyin", value: word.pinyin },
        { label: "English", value: word.translation ?? "Pending" },
      ]);
    });

    hotspot.addEventListener("click", () => {
      state.activeCharacterId = character.id;
      const sentence = sentenceById.get(character.sentenceId);
      if (!sentence) {
        return;
      }
      elements.sentencePanel.innerHTML = panelMarkup("Sentence", [
        { label: "Chinese", value: sentence.text },
        { label: "Pinyin", value: sentence.pinyin },
        { label: "English", value: sentence.translation ?? "Pending" },
      ]);
      renderActiveCharacter();
    });

    if (state.activeCharacterId === character.id) {
      hotspot.classList.add("active");
    }

    elements.overlay.appendChild(hotspot);
  }
}

function renderActiveCharacter() {
  for (const hotspot of elements.overlay.querySelectorAll(".hotspot")) {
    hotspot.classList.toggle("active", hotspot.dataset.characterId === state.activeCharacterId);
  }
}

async function init() {
  state.manifest = await loadJson(manifestUrl);
  elements.prevPage.addEventListener("click", () => loadPage(state.pageIndex - 1));
  elements.nextPage.addEventListener("click", () => loadPage(state.pageIndex + 1));
  await loadPage(0);
}

init().catch((error) => {
  console.error(error);
  document.body.innerHTML = `<pre>${error.message}</pre>`;
});
