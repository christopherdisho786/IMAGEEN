const MODEL_MAP = {
  fast: "gemini-2.0-flash-exp-image-generation",
  pro: "gemini-2.5-pro-preview-image-generation"
};

const state = {
  running: false,
  stopRequested: false,
  runningTasks: 0,
  completed: 0,
  failed: 0,
  total: 0,
  keys: [],
  activeKeys: new Set(),
  nextKeyIndex: 0,
  jobs: []
};

const el = {
  topics: document.getElementById("topics"),
  imagesPerTopic: document.getElementById("imagesPerTopic"),
  instructions: document.getElementById("instructions"),
  model: document.getElementById("model"),
  apiKeys: document.getElementById("apiKeys"),
  complexity: document.getElementById("complexity"),
  previewToggle: document.getElementById("previewToggle"),
  startBtn: document.getElementById("startBtn"),
  stopBtn: document.getElementById("stopBtn"),
  runningTasks: document.getElementById("runningTasks"),
  completedCount: document.getElementById("completedCount"),
  totalCount: document.getElementById("totalCount"),
  failedCount: document.getElementById("failedCount"),
  retryingLabel: document.getElementById("retryingLabel"),
  activeKeys: document.getElementById("activeKeys"),
  totalKeys: document.getElementById("totalKeys"),
  log: document.getElementById("log"),
  previewSection: document.getElementById("previewSection"),
  previewGrid: document.getElementById("previewGrid")
};

el.startBtn.addEventListener("click", startGeneration);
el.stopBtn.addEventListener("click", () => {
  state.stopRequested = true;
  appendLog("Stop requested. Finishing in-flight tasks...");
});

function parseCsv(input) {
  return input
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function parseKeys(input) {
  const keys = input
    .split("\n")
    .map((k) => k.trim())
    .filter(Boolean)
    .slice(0, 50);

  for (let i = keys.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [keys[i], keys[j]] = [keys[j], keys[i]];
  }
  return keys;
}

function buildJobs(topics, styles, imagesPerTopic) {
  const jobs = [];
  for (const topic of topics) {
    for (const style of styles) {
      for (let i = 0; i < imagesPerTopic; i++) {
        jobs.push({ topic, style, index: i + 1 });
      }
    }
  }
  return jobs;
}

function getNextRoundRobinKey(exclude = new Set()) {
  const total = state.keys.length;
  for (let c = 0; c < total; c++) {
    const idx = state.nextKeyIndex % total;
    state.nextKeyIndex = (state.nextKeyIndex + 1) % total;
    const key = state.keys[idx];
    if (!exclude.has(key)) {
      return key;
    }
  }
  return state.keys[Math.floor(Math.random() * total)];
}

function getRandomFallbackKey(exclude = new Set()) {
  const candidates = state.keys.filter((k) => !exclude.has(k));
  if (!candidates.length) return state.keys[Math.floor(Math.random() * state.keys.length)];
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function appendLog(message) {
  const timestamp = new Date().toISOString().split("T")[1].slice(0, 8);
  el.log.textContent = `[${timestamp}] ${message}\n` + el.log.textContent;
}

function sanitizeWords(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function generateFilename(topic, style) {
  const bank = sanitizeWords(`${topic} ${style}`)
    .split(" ")
    .filter(Boolean);

  const seed = ["modern", "professional", "commercial", "stock", "visual", "design", "concept", "creative", "highquality"];
  const titleWords = [];
  const pool = [...new Set([...bank, ...seed])];

  while (titleWords.length < 6) {
    const candidate = pool[Math.floor(Math.random() * pool.length)] || "visual";
    if (!titleWords.includes(candidate)) titleWords.push(candidate);
  }
  while (titleWords.length < 9 && Math.random() > 0.55) {
    const candidate = pool[Math.floor(Math.random() * pool.length)] || "design";
    if (!titleWords.includes(candidate)) titleWords.push(candidate);
  }

  const title = titleWords.join("-").slice(0, 120);

  const keywordBase = [...new Set([...bank, ...seed, "lighting", "clean", "balanced", "market", "render", "focal", "background", "branding", "corporate", "digital", "trend", "premium"])]
    .map((w) => w.replace(/[^a-z0-9]/g, ""))
    .filter((w) => w.length > 1);

  const keywords = [];
  while (keywords.length < 23) {
    const kw = keywordBase[Math.floor(Math.random() * keywordBase.length)] || "design";
    if (!keywords.includes(kw)) keywords.push(kw);
  }
  while (keywords.length < 25 && Math.random() > 0.4) {
    const kw = keywordBase[Math.floor(Math.random() * keywordBase.length)] || "visual";
    if (!keywords.includes(kw)) keywords.push(kw);
    else break;
  }

  return `${title}.${keywords.slice(0, 25).join(",")}.jpg`;
}

function buildPrompt(topic, style, complexity) {
  return `Create a high-quality image.\n\nTopic: ${topic}\nStyle: ${style}\n\nRequirements:\n- 16:9 composition\n- Professional lighting (not overexposed or dim)\n- Clean composition\n- No cropping, subject fully inside frame\n- Stock marketplace ready\n- Modern, visually appealing\n- Not overly complex\n- High commercial usability\n- Complexity target: ${complexity}\n- Target output resolution: 1920x1080 or 3840x2160\n\nStyle hints:\n- 3D rendered, professional-looking style (when applicable)\n- Balanced colors\n- Clear focal point\n\nEach output must be UNIQUE (not minor variation).`;
}

async function requestImageFromGemini({ apiKey, modelName, prompt }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseModalities: ["IMAGE", "TEXT"]
    }
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 180)}`);
  }

  const data = await res.json();
  const part = data?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  if (!part?.inlineData?.data) {
    throw new Error("No image data returned by model.");
  }

  const mimeType = part.inlineData.mimeType || "image/jpeg";
  return { base64: part.inlineData.data, mimeType };
}

function b64ToBlob(base64, mimeType) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1200);
}

function addPreview(blob, filename) {
  if (el.previewToggle.value !== "on") return;
  const fig = document.createElement("figure");
  const img = document.createElement("img");
  const cap = document.createElement("figcaption");
  const url = URL.createObjectURL(blob);
  img.src = url;
  img.loading = "lazy";
  cap.textContent = filename;
  fig.appendChild(img);
  fig.appendChild(cap);
  el.previewGrid.prepend(fig);
}

function updateStatus() {
  el.runningTasks.textContent = String(state.runningTasks);
  el.completedCount.textContent = String(state.completed);
  el.totalCount.textContent = String(state.total);
  el.failedCount.textContent = String(state.failed);
  el.retryingLabel.textContent = state.running ? "(retrying when possible)" : "";
  el.activeKeys.textContent = String(state.activeKeys.size);
  el.totalKeys.textContent = String(state.keys.length);
}

async function runSingleJob(job) {
  const tried = new Set();
  let lastError = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    const key = attempt === 0 ? getNextRoundRobinKey(tried) : getRandomFallbackKey(tried);
    tried.add(key);

    state.activeKeys.add(key);
    updateStatus();

    try {
      const prompt = buildPrompt(job.topic, job.style, el.complexity.value);
      const { base64, mimeType } = await requestImageFromGemini({
        apiKey: key,
        modelName: MODEL_MAP[el.model.value],
        prompt
      });

      const isPngStyle = /design|icon|vector|ui|logo|illustration/i.test(job.style);
      const targetExt = isPngStyle ? "png" : "jpg";
      const filename = generateFilename(job.topic, job.style).replace(/\.jpg$/, `.${targetExt}`);
      const blob = b64ToBlob(base64, mimeType);

      triggerDownload(blob, filename);
      addPreview(blob, filename);
      appendLog(`✅ Done: ${job.topic} | ${job.style} #${job.index}`);
      return true;
    } catch (err) {
      lastError = err;
      appendLog(`⚠️ Attempt ${attempt + 1} failed (${job.topic} | ${job.style} #${job.index}): ${err.message}`);
    } finally {
      state.activeKeys.delete(key);
      updateStatus();
    }
  }

  appendLog(`❌ Failed permanently: ${job.topic} | ${job.style} #${job.index} (${lastError?.message || "unknown error"})`);
  return false;
}

async function workerLoop(queue) {
  while (queue.length && !state.stopRequested) {
    const job = queue.shift();
    if (!job) break;

    state.runningTasks++;
    updateStatus();

    const ok = await runSingleJob(job);
    if (ok) state.completed++;
    else state.failed++;

    state.runningTasks--;
    updateStatus();
  }
}

async function startGeneration() {
  if (state.running) return;

  const topics = parseCsv(el.topics.value);
  const styles = parseCsv(el.instructions.value);
  const imagesPerTopic = Number(el.imagesPerTopic.value);
  const keys = parseKeys(el.apiKeys.value);

  if (!topics.length || !styles.length) {
    alert("Please provide at least one topic and one instruction/style.");
    return;
  }
  if (!Number.isInteger(imagesPerTopic) || imagesPerTopic < 1 || imagesPerTopic > 100) {
    alert("Images per topic must be an integer between 1 and 100.");
    return;
  }
  if (!keys.length) {
    alert("Please provide at least one API key.");
    return;
  }

  state.running = true;
  state.stopRequested = false;
  state.keys = keys;
  state.nextKeyIndex = 0;
  state.jobs = buildJobs(topics, styles, imagesPerTopic);
  state.total = state.jobs.length;
  state.completed = 0;
  state.failed = 0;
  state.runningTasks = 0;
  state.activeKeys.clear();
  el.previewGrid.innerHTML = "";

  el.startBtn.disabled = true;
  el.stopBtn.disabled = false;
  updateStatus();

  appendLog(`Starting ${state.total} jobs with ${keys.length} key(s). Model: ${MODEL_MAP[el.model.value]}`);

  const queue = [...state.jobs];
  const workers = Math.min(keys.length, queue.length);
  const promises = [];

  for (let i = 0; i < workers; i++) {
    promises.push(workerLoop(queue));
  }

  await Promise.all(promises);

  state.running = false;
  el.startBtn.disabled = false;
  el.stopBtn.disabled = true;
  updateStatus();

  if (state.stopRequested) appendLog("Stopped by user request.");
  appendLog(`Finished. Completed: ${state.completed}, Failed: ${state.failed}, Total: ${state.total}`);
}
