// Smart Recorder - Repositories, Auto-Recovery & Spanglish Support
let mediaRecorder;
let audioChunks = [];
let startTime, timerInterval;
let accumulatedTime = 0;
let audioContext, analyser, dataArray, animationId;
let wakeLock = null;
let currentSource = 'mic';
let currentSlides = [];
let activeSlideIndex = 0;
let panZoomInstance = null;

// --- Database Logic (IndexedDB for "Digital Repositories") ---
const DB_NAME = 'SmartRecorderRepo';
const DB_VERSION = 2;
let db;

// --- Initialize Mermaid ---
mermaid.initialize({
    startOnLoad: false,
    theme: 'dark',
    securityLevel: 'loose',
    fontFamily: 'Outfit, sans-serif'
});

function initDB() {
    return new Promise((resolve) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains('sessions')) {
                db.createObjectStore('sessions', { keyPath: 'id', autoIncrement: true });
            }
        };
        request.onsuccess = (e) => {
            db = e.target.result;
            resolve(db);
        };
    });
}

async function saveSessionToRepo(sessionData) {
    const tx = db.transaction('sessions', 'readwrite');
    const store = tx.objectStore('sessions');
    return new Promise(r => {
        const req = store.put(sessionData);
        req.onsuccess = () => r(req.result);
    });
}

async function getHistoryFromRepo() {
    const tx = db.transaction('sessions', 'readonly');
    const store = tx.objectStore('sessions');
    return new Promise(r => {
        const req = store.getAll();
        req.onsuccess = () => r(req.result.sort((a, b) => b.id - a.id));
    });
}

// --- UI & Elements ---
let elements = {};

function populateElements() {
    elements = {
        recordBtn: document.getElementById('recordBtn'),
        recordIcon: document.getElementById('recordIcon'),
        recordRing: document.getElementById('recordRing'),
        timerDisplay: document.getElementById('timerDisplay'),
        status: document.getElementById('recordingStatus'),
        controls: document.getElementById('recordingControls'),
        cancelBtn: document.getElementById('cancelBtn'),
        saveBtn: document.getElementById('saveBtn'),
        downloadBtn: document.getElementById('downloadBtn'),
        pauseBtn: document.getElementById('pauseBtn'),
        pauseIcon: document.getElementById('pauseIcon'),
        resultArea: document.getElementById('resultArea'),
        aiSummary: document.getElementById('aiSummary'),
        aiTranscript: document.getElementById('aiTranscript'),
        sessionName: document.getElementById('sessionName'),
        progressBar: document.getElementById('progressBar'),
        progressContainer: document.getElementById('analysisProgress'),
        historyList: document.getElementById('historyList'),
        settingsBtn: document.getElementById('settingsBtn'),
        settingsModal: document.getElementById('settingsModal'),
        sfKeyInput: document.getElementById('sfKey'),
        deepgramKeyInput: document.getElementById('deepgramKey'),
        serverSelect: document.getElementById('serverSelect'),
        sourceMic: document.getElementById('sourceMic'),
        sourceSystem: document.getElementById('sourceSystem'),
        currentSizeLabel: document.getElementById('currentSize'),
        fileSizeInfo: document.getElementById('fileSizeInfo'),
        searchInput: document.getElementById('searchInput'),
        projectFilter: document.getElementById('projectFilter')
    };
}

// --- Initialization ---
document.addEventListener('DOMContentLoaded', async () => {
    populateElements();
    await initDB();
    loadKey();
    initEventListeners();
    renderHistory();

    // Recovery Check
    const draft = localStorage.getItem('sr_draft_audio');
    if (draft) {
        const blob = await fetch(draft).then(r => r.blob()).catch(() => null);
        if (blob) {
            audioChunks = [blob];
            uiFinished();
        }
    }
});

// --- Recording Engine ---
async function startFocus() {
    try {
        const stream = (currentSource === 'mic')
            ? await navigator.mediaDevices.getUserMedia({ audio: true })
            : await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });

        mediaRecorder = new MediaRecorder(stream);
        audioChunks = [];

        mediaRecorder.ondataavailable = (e) => {
            audioChunks.push(e.data);
            const size = audioChunks.reduce((acc, c) => acc + c.size, 0);
            const mb = (size / (1024 * 1024)).toFixed(1);
            elements.currentSizeLabel.innerText = `${mb} MB`;
            if (mb > 24) stopFocus(); // Auto-stop at 25MB safety
        };

        mediaRecorder.start(1000);
        startTime = Date.now();
        accumulatedTime = 0;
        startTimer();
        uiRecording();
    } catch (err) {
        alert(err.message);
    }
}

function stopFocus() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
        mediaRecorder.stream.getTracks().forEach(track => track.stop());
        stopTimer();
        uiFinished();
    }
}

// --- Analysis & Progress ---
async function analyzeSession() {
    const apiKey = localStorage.getItem('sf_api_key_v2');
    const baseUrl = localStorage.getItem('sf_base_url') || 'https://api.siliconflow.com/v1';

    if (!apiKey) return elements.settingsModal.classList.remove('hidden');

    elements.resultArea.classList.remove('hidden');
    elements.progressContainer.classList.remove('hidden');
    updateProgress(10, "Iniciando análisis...");

    const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
    let transcriptionText = "";

    // --- TRANSCRIPTION: DEEPGRAM (CORS-Friendly) ---
    const dgKey = localStorage.getItem('deepgram_api_key');
    if (!dgKey) {
        updateProgress(0, "Falta Deepgram API Key.");
        elements.aiSummary.innerHTML = `
            <div class="text-emerald-400 text-xs text-center border border-emerald-500/30 p-4 rounded-xl glass">
                <p class="font-black mb-2 uppercase tracking-tighter">Motor de Voz no configurado</p>
                <p class="text-white">Abre ajustes ⚙️ y pon tu Deepgram Key.</p>
            </div>`;
        return;
    }

    try {
        updateProgress(40, "Transcribiendo con Deepgram...");
        const dgRes = await fetch(`https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&language=es`, {
            method: 'POST',
            headers: { 'Authorization': `Token ${dgKey}`, 'Content-Type': audioBlob.type },
            body: audioBlob
        });
        if (dgRes.ok) {
            const dgData = await dgRes.json();
            transcriptionText = dgData.results.channels[0].alternatives[0].transcript;
        } else {
            throw new Error("Fallo en Deepgram.");
        }
    } catch (err) {
        updateProgress(0, "Error en Transcripción.");
        elements.aiSummary.innerText = `Error: ${err.message}`;
        return;
    }

    elements.aiTranscript.innerText = transcriptionText;

    try {
        const chatModels = ["deepseek-ai/DeepSeek-V3", "Qwen/Qwen2.5-72B-Instruct", "Qwen/Qwen2.5-7B-Instruct"];
        let chatData = null;
        let chatError = null;

        for (const modelId of chatModels) {
            try {
                updateProgress(75, `Analizando: ${modelId.split('/')[1]}...`);
                const chatRes = await fetch(`${baseUrl}/chat/completions`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model: modelId,
                        messages: [
                            {
                                role: "system",
                                content: `Eres un analista experto. GENERAR RESPUESTA EN JSON PURO.
                                {
                                  "titulo": "Título corto",
                                  "resumen": "Resumen ejecutivo en Español con Idea Central, Puntos Clave y Tareas.",
                                  "mindmap": "Código Mermaid de tipo mindmap.",
                                  "slides": [{"title":"Título", "content":"Contenido"}],
                                  "infografia": {"sentimiento": "Positivo", "relevancia": "95", "palabras_clave": ["IA", "Automatización"]}
                                }`
                            },
                            { role: "user", content: transcriptionText }
                        ],
                        response_format: { type: "json_object" }
                    })
                });

                if (chatRes.ok) {
                    const rawData = await chatRes.json();
                    const content = rawData.choices[0].message.content;
                    console.log("IA raw output:", content);

                    // Robust JSON Extract
                    try {
                        const jsonMatch = content.match(/\{[\s\S]*\}/);
                        chatData = JSON.parse(jsonMatch ? jsonMatch[0] : content);
                    } catch (parseErr) {
                        console.error("JSON Parse Error:", parseErr);
                        chatError = "Error al procesar formato JSON de la IA.";
                        continue;
                    }

                    if (chatData && chatData.resumen) break;
                } else {
                    const errRes = await chatRes.json().catch(() => ({}));
                    chatError = errRes.message || chatRes.status;
                }
            } catch (e) { chatError = e.message; }
        }

        if (!chatData) throw new Error(chatError || "Fallo en motor de chat.");

        // UI Updates using destructuring safely
        const { titulo, resumen, mindmap, slides, infografia } = chatData;

        if (titulo) elements.sessionName.value = titulo;

        console.log("Rendering summary data:", resumen);

        // Formatear Resumen (Handle String or Object from IA)
        let summaryHTML = "";
        let summaryForStorage = "";

        if (typeof resumen === 'string') {
            summaryForStorage = resumen;
            summaryHTML = resumen
                .split('\n')
                .filter(p => p.trim())
                .map(p => `<p class="mb-3">${p.trim()}</p>`)
                .join('');
        } else if (resumen && typeof resumen === 'object') {
            // Case where AI structured the summary as an object
            summaryForStorage = Object.entries(resumen).map(([k, v]) => `${k}: ${v}`).join('\n');
            summaryHTML = Object.entries(resumen)
                .map(([k, v]) => `
                    <div class="mb-4">
                        <span class="text-[10px] font-black text-violet-400 uppercase tracking-widest block mb-1">${k.replace(/_/g, ' ')}</span>
                        <p class="text-white">${v}</p>
                    </div>
                `).join('');
        } else {
            summaryHTML = "<p class='text-slate-500'>No se pudo generar el resumen.</p>";
            summaryForStorage = "Sin resumen.";
        }

        elements.aiSummary.innerHTML = summaryHTML;

        // Mindmap (On-demand) - Wrapped in try/catch to prevent blocking
        if (mindmap) {
            try {
                const diagEl = document.getElementById('mermaidDiagram');
                const toggleBtn = document.getElementById('mindmapToggle');
                diagEl.innerHTML = mindmap;
                diagEl.removeAttribute('data-processed');
                await mermaid.run({ nodes: [diagEl] });
                toggleBtn.classList.remove('hidden');

                // Zoom Init
                setTimeout(() => {
                    const svg = diagEl.querySelector('svg');
                    if (svg) {
                        if (panZoomInstance) panZoomInstance.destroy();
                        panZoomInstance = svgPanZoom(svg, { zoomEnabled: true, controlIconsEnabled: false, fit: true, center: true });
                    }
                }, 500);
            } catch (mermaidErr) {
                console.warn("Mermaid render failed, but summary should be visible:", mermaidErr);
            }
        }

        if (infografia) renderInfographic(infografia);
        if (slides) currentSlides = slides;

        updateProgress(100, "¡Listo!");

        // Store Session
        await saveSessionToRepo({
            name: elements.sessionName.value || 'Sesión sin nombre',
            date: new Date().toLocaleString(),
            summary: summaryForStorage,
            transcript: transcriptionText,
            audioBlob: audioBlob
        });

        renderHistory();

    } catch (err) {
        elements.aiSummary.innerText = `Error: ${err.message}. Reintenta.`;
        updateProgress(0, "Error.");
    }
}

// --- Utils ---
function updateProgress(val, msg) {
    elements.progressBar.style.width = `${val}%`;
    elements.status.innerText = msg;
}

async function renderHistory() {
    const sessions = await getHistoryFromRepo();
    const query = elements.searchInput.value.toLowerCase();
    const project = elements.projectFilter.value;

    const uniqueProjects = [...new Set(sessions.map(s => s.name))];
    elements.projectFilter.innerHTML = '<option value="all">TODOS</option>' +
        uniqueProjects.map(p => `<option value="${p}">${p.toUpperCase()}</option>`).join('');

    const filtered = sessions.filter(s => {
        const text = (s.summary + s.transcript + s.name).toLowerCase();
        return text.includes(query) && (project === 'all' || s.name === project);
    });

    if (filtered.length === 0) {
        elements.historyList.innerHTML = '<p class="text-xs text-slate-600 text-center">Repo vacío</p>';
        return;
    }

    elements.historyList.innerHTML = filtered.map(s => `
        <div class="glass-card p-4 rounded-xl border border-white/5 hover:border-violet-500/20 transition-all">
            <div class="flex justify-between items-center mb-2">
                <span class="text-[9px] font-black text-violet-400 uppercase">${s.name}</span>
                <span class="text-[8px] text-slate-500">${s.date}</span>
            </div>
            <p class="text-[10px] text-slate-300 line-clamp-2 mb-3">${s.summary}</p>
            <div class="flex gap-4">
                <button onclick="copyNoteById('${s.id}')" class="text-[9px] font-black text-slate-500 hover:text-white uppercase transition-all">Copiar</button>
                <button onclick="downloadRepoAudio(${s.id})" class="text-[9px] font-black text-blue-400 hover:text-white uppercase transition-all">Audio</button>
            </div>
        </div>
    `).join('');
}

window.copyNoteById = async (id) => {
    const tx = db.transaction('sessions', 'readonly');
    const s = await new Promise(r => tx.objectStore('sessions').get(parseInt(id)).onsuccess = e => r(e.target.result));
    const text = `PROYECTO: ${s.name}\nFECHA: ${s.date}\n\nRESUMEN:\n${s.summary}\n\nTRANSCRIPCIÓN:\n${s.transcript}`;
    navigator.clipboard.writeText(text);
    alert("Copiado al portapapeles.");
};

window.downloadRepoAudio = async (id) => {
    const tx = db.transaction('sessions', 'readonly');
    const s = await new Promise(r => tx.objectStore('sessions').get(parseInt(id)).onsuccess = e => r(e.target.result));
    const url = URL.createObjectURL(s.audioBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${s.name.replace(/\s/g, '_')}.webm`;
    a.click();
};

window.openSlides = () => {
    if (!currentSlides.length) return alert("Analiza una sesión primero.");
    activeSlideIndex = 0;
    renderSlide();
    document.getElementById('slidesModal').classList.remove('hidden');
    try {
        if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen();
    } catch (e) { }
};

window.closeSlides = () => {
    document.getElementById('slidesModal').classList.add('hidden');
    if (document.fullscreenElement) document.exitFullscreen().catch(() => { });
};

function renderSlide() {
    const slide = currentSlides[activeSlideIndex];
    const content = document.getElementById('slideContent');
    const counter = document.getElementById('slideCounter');

    content.innerHTML = `
        <h2 class="text-white text-5xl sm:text-7xl font-black mb-12 uppercase italic bg-gradient-to-r from-white to-slate-500 bg-clip-text text-transparent">
            ${slide.title}
        </h2>
        <div class="text-slate-300 text-xl sm:text-3xl leading-relaxed font-light max-w-3xl mx-auto">
            ${slide.content.split('\n').map(line => `<div class="mb-4">• ${line.trim()}</div>`).join('')}
        </div>
    `;
    counter.innerText = `${activeSlideIndex + 1} / ${currentSlides.length}`;
}

window.nextSlide = () => {
    if (activeSlideIndex < currentSlides.length - 1) { activeSlideIndex++; renderSlide(); }
    else closeSlides();
};

window.prevSlide = () => { if (activeSlideIndex > 0) { activeSlideIndex--; renderSlide(); } };

window.exportNote = async (format) => {
    const title = elements.sessionName.value || "Sesion";
    const date = new Date().toLocaleString();
    const sessionResumen = elements.aiSummary.innerText; // Use different local name to avoid clashes
    const transcript = elements.aiTranscript.innerText;

    if (format === 'md') {
        const mdContent = `# ${title}\n*${date}*\n\n## 📝 RESUMEN\n${sessionResumen}\n\n---\n## 🎙️ TRANSCRIPCIÓN\n${transcript}`;
        const blob = new Blob([mdContent], { type: 'text/markdown' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${title}.md`;
        a.click();
    } else if (format === 'pdf') {
        const win = window.open('', '_blank');
        win.document.write(`
            <html>
                <head><title>${title}</title><style>
                    body { font-family: sans-serif; padding: 40px; line-height: 1.6; }
                    h1 { color: #6366f1; border-bottom: 2px solid #6366f1; }
                    .box { background: #f9fafb; padding: 20px; border-left: 5px solid #6366f1; margin: 20px 0; }
                    .content { white-space: pre-wrap; font-size: 10pt; }
                </style></head>
                <body>
                    <h1>${title}</h1>
                    <p>${date}</p>
                    <h2>📝 RESUMEN EJECUTIVO</h2>
                    <div class="box"><div class="content">${sessionResumen}</div></div>
                    <h2>🎙️ TRANSCRIPCIÓN</h2>
                    <div class="content">${transcript}</div>
                </body>
            </html>
        `);
        win.document.close();
        setTimeout(() => win.print(), 500);
    }
};

function renderInfographic(data) {
    const container = document.getElementById('infographicContainer');
    const content = document.getElementById('infographicContent');
    if (!container || !content) return;
    container.classList.remove('hidden');

    content.innerHTML = `
        <div class="glass p-3 px-6 rounded-2xl border border-white/5 text-center min-w-[120px]">
            <span class="text-[8px] text-slate-500 uppercase block mb-1">Sentimiento</span>
            <span class="text-xs font-bold text-white uppercase">${data.sentimiento}</span>
        </div>
        <div class="glass p-3 px-6 rounded-2xl border border-white/5 text-center min-w-[120px]">
            <span class="text-[8px] text-slate-500 uppercase block mb-1">Relevancia</span>
            <span class="text-xs font-bold text-blue-400">${data.relevancia}%</span>
        </div>
        <div class="glass p-3 px-6 rounded-2xl border border-white/5 text-center w-full">
            <span class="text-[8px] text-slate-500 uppercase block mb-1">Conceptos Clave</span>
            <div class="flex flex-wrap justify-center gap-2 mt-1">
                ${(data.palabras_clave || []).map(w => `<span class="px-3 py-1 bg-violet-500/10 rounded-full text-[10px] text-slate-200 border border-white/10 uppercase font-black">${w}</span>`).join('')}
            </div>
        </div>
    `;
}

window.openMindmap = () => {
    const modal = document.getElementById('mindmapModal');
    modal.classList.remove('hidden');
    setTimeout(() => {
        if (panZoomInstance) {
            panZoomInstance.resize();
            panZoomInstance.fit();
            panZoomInstance.center();
        }
    }, 100);
};

window.closeMindmap = () => {
    document.getElementById('mindmapModal').classList.add('hidden');
};

window.resetZoom = () => { if (panZoomInstance) panZoomInstance.reset(); };

// UI Helpers
function uiRecording() {
    elements.recordIcon.innerText = 'stop';
    elements.recordRing.classList.remove('hidden');
    elements.recordRing.classList.add('pulse-ring');
    elements.status.innerText = "Grabando...";
    elements.pauseBtn.classList.remove('hidden');
}

function uiFinished() {
    elements.recordIcon.innerText = 'mic';
    elements.recordRing.classList.add('hidden');
    elements.status.innerText = "Listo.";
    elements.controls.classList.remove('hidden', 'opacity-0', 'translate-y-4', 'pointer-events-none');
    elements.pauseBtn.classList.add('hidden');
}

function startTimer() {
    timerInterval = setInterval(() => {
        const elapsed = accumulatedTime + (Date.now() - startTime);
        const s = Math.floor((elapsed / 1000) % 60).toString().padStart(2, '0');
        const m = Math.floor((elapsed / 1000 / 60) % 60).toString().padStart(2, '0');
        elements.timerDisplay.innerText = `${m}:${s}`;
    }, 1000);
}

function stopTimer() { clearInterval(timerInterval); }

function initEventListeners() {
    elements.recordBtn.onclick = () => {
        if (!mediaRecorder || mediaRecorder.state === 'inactive') startFocus();
        else stopFocus();
    };

    elements.pauseBtn.onclick = () => {
        if (mediaRecorder.state === 'recording') {
            mediaRecorder.pause();
            accumulatedTime += Date.now() - startTime;
            stopTimer();
            elements.pauseIcon.innerText = 'play_arrow';
        } else {
            mediaRecorder.resume();
            startTime = Date.now();
            startTimer();
            elements.pauseIcon.innerText = 'pause';
        }
    };

    elements.saveBtn.onclick = analyzeSession;

    document.getElementById('saveSettings').onclick = () => {
        localStorage.setItem('sf_api_key_v2', elements.sfKeyInput.value.trim());
        localStorage.setItem('deepgram_api_key', elements.deepgramKeyInput.value.trim());
        localStorage.setItem('sf_base_url', elements.serverSelect.value);
        alert("Configuración Guardada.");
        elements.settingsModal.classList.add('hidden');
    };

    elements.settingsBtn.onclick = () => elements.settingsModal.classList.remove('hidden');
    elements.sourceMic.onclick = () => { currentSource = 'mic'; elements.sourceMic.classList.add('bg-white', 'text-black'); elements.sourceSystem.classList.remove('bg-white', 'text-black'); };
    elements.sourceSystem.onclick = () => { currentSource = 'system'; elements.sourceSystem.classList.add('bg-white', 'text-black'); elements.sourceMic.classList.remove('bg-white', 'text-black'); };

    elements.searchInput.oninput = renderHistory;
    elements.projectFilter.onchange = renderHistory;

    if (elements.sfKeyInput) elements.sfKeyInput.onkeyup = () => localStorage.setItem('sf_api_key_v2', elements.sfKeyInput.value.trim());
    if (elements.deepgramKeyInput) elements.deepgramKeyInput.onkeyup = () => localStorage.setItem('deepgram_api_key', elements.deepgramKeyInput.value.trim());
}

function loadKey() {
    elements.sfKeyInput.value = localStorage.getItem('sf_api_key_v2') || '';
    elements.deepgramKeyInput.value = localStorage.getItem('deepgram_api_key') || '';
    if (localStorage.getItem('sf_base_url')) elements.serverSelect.value = localStorage.getItem('sf_base_url');
}

window.toggleVisibility = (id) => {
    const el = document.getElementById(id);
    el.type = el.type === 'password' ? 'text' : 'password';
};
