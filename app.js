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
        if (confirm("Se detectó una grabación no guardada. ¿Deseas recuperarla?")) {
            // Logic to recover would go here, for now just clear
        }
        localStorage.removeItem('sr_draft_audio');
    }
});

// --- Accidental Close Prevention ---
window.onbeforeunload = (e) => {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        const msg = "Tienes una grabación en curso. Si sales ahora, se perderá.";
        e.returnValue = msg;
        return msg;
    }
};

// --- Recording Control ---
async function startFocus() {
    // Basic setup remains similar but adds project context
    try {
        let stream;
        if (currentSource === 'mic') {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } else {
            const screenStream = await navigator.mediaDevices.getDisplayMedia({
                video: { displaySurface: "browser" },
                audio: { echoCancellation: false }
            });
            if (screenStream.getAudioTracks().length === 0) throw new Error("No compartiste audio.");
            const audioTrack = screenStream.getAudioTracks()[0];
            stream = new MediaStream([audioTrack]);
            screenStream.getVideoTracks().forEach(t => t.stop());
        }

        audioChunks = [];
        mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });

        mediaRecorder.ondataavailable = (e) => {
            audioChunks.push(e.data);
            const totalSize = audioChunks.reduce((acc, chunk) => acc + chunk.size, 0);
            const mb = (totalSize / (1024 * 1024)).toFixed(1);
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
    const modelsToTry = [
        'FunAudioLLM/SenseVoiceSmall',
        'TeleAI/TeleSpeechASR',
        'openai/whisper-large-v3'
    ];

    let transcriptionText = "";
    let success = false;

    // --- TRANSCRIPTION: DEEPGRAM (The only one that works on GitHub Pages - No CORS issues) ---
    const dgKey = localStorage.getItem('deepgram_api_key');
    if (!dgKey) {
        updateProgress(0, "Falta Deepgram API Key.");
        elements.aiSummary.innerHTML = `
            <div class="text-emerald-400 text-xs text-center border border-emerald-500/30 p-4 rounded-xl glass">
                <p class="font-black mb-2 uppercase tracking-tighter">Motor de Voz no configurado</p>
                <p class="text-white mb-4">Abre "Ajustes" ⚙️ y pon tu Deepgram Key. Es la única que funciona en la nube.</p>
                <a href="https://console.deepgram.com/signup" target="_blank" class="bg-emerald-500 text-black px-4 py-2 rounded-lg font-bold text-[10px] inline-block">OBTENER CLAVE GRATIS</a>
            </div>`;
        return;
    }

    try {
        updateProgress(40, "Transcribiendo con Deepgram...");
        const dgRes = await fetch(`https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&language=es`, {
            method: 'POST',
            headers: {
                'Authorization': `Token ${dgKey}`,
                'Content-Type': audioBlob.type
            },
            body: audioBlob
        });

        if (dgRes.ok) {
            const dgData = await dgRes.json();
            transcriptionText = dgData.results.channels[0].alternatives[0].transcript;
            if (transcriptionText.trim()) success = true;
        } else {
            throw new Error("Deepgram rechazó la petición. Revisa tu saldo o API Key.");
        }
    } catch (err) {
        console.error("Fallo con Deepgram:", err);
        updateProgress(0, "Error en Transcripción.");
        elements.aiSummary.innerText = `Error: ${err.message}`;
        return;
    }

    elements.aiTranscript.innerText = transcriptionText;

    try {
        const chatModels = [
            "deepseek-ai/DeepSeek-V3",
            "Qwen/Qwen2.5-72B-Instruct",
            "Qwen/Qwen2.5-7B-Instruct"
        ];

        let chatData = null;
        let chatError = null;

        for (const modelId of chatModels) {
            try {
                updateProgress(75, `Analizando con motor: ${modelId.split('/')[1]}...`);
                const chatRes = await fetch(`${baseUrl}/chat/completions`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model: modelId,
                        messages: [
                            {
                                role: "system",
                                content: `Eres un analista experto en sesiones técnicas y bilingües. 
                                GENERAR RESPUESTA EN FORMATO JSON PURO.
                                
                                ESTRUCTURA DEL JSON:
                                {
                                  "titulo": "Título corto e impactante (máx 5 palabras)",
                                  "resumen": "Resumen ejecutivo en Español con Idea Central, Puntos Clave y Tareas.",
                                  "mindmap": "Código Mermaid de tipo mindmap. Empieza con 'mindmap' en la primera línea. Sé visual y jerárquico.",
                                  "slides": [
                                    {"title": "💡 Idea Central", "content": "Texto impactante"},
                                    {"title": "✨ Novedades y Hallazgos", "content": "Lo más nuevo o relevante detectado"},
                                    {"title": "🚀 Puntos de Acción", "content": "Pasos a seguir"},
                                    {"title": "🎯 Conclusión", "content": "Mensaje final de cierre"}
                                  ],
                                  "infografia": {
                                    "sentimiento": "Positivo/Neutral/Negativo",
                                    "relevancia": "0-100",
                                    "palabras_clave": ["A", "B", "C"],
                                    "duracion_estimada": "X min"
                                  }
                                }`
                            },
                            { role: "user", content: transcriptionText }
                        ],
                        response_format: { type: "json_object" }
                    })
                });

                if (chatRes.ok) {
                    const rawData = await chatRes.json();
                    chatData = JSON.parse(rawData.choices[0].message.content);
                    if (chatData.resumen) break;
                } else {
                    const err = await chatRes.json().catch(() => ({}));
                    console.warn(`Motor chat ${modelId} falló:`, err.message || chatRes.status);
                    chatError = err.message || chatRes.status;
                }
            } catch (e) {
                console.error(`Error de red con ${modelId}:`, e);
                chatError = e.message;
            }
        }

        if (!chatData) {
            throw new Error(chatError || "No se pudo conectar con los motores de análisis.");
        }

        const { titulo, resumen, mindmap, slides, infografia } = chatData;

        // Update UI
        if (titulo) elements.sessionName.value = titulo;
        elements.aiSummary.innerText = resumen;

        // Render Mindmap
        if (mindmap) {
            const container = document.getElementById('mindmapContainer');
            const diagEl = document.getElementById('mermaidDiagram');
            container.classList.remove('hidden');
            diagEl.innerHTML = mindmap;
            diagEl.removeAttribute('data-processed');
            await mermaid.run({ nodes: [diagEl] });
            document.getElementById('mindmapToggle').classList.remove('hidden');

            // Enable Zoom
            setTimeout(() => {
                const svg = diagEl.querySelector('svg');
                if (svg) {
                    svg.style.width = "100%";
                    svg.style.height = "100%";
                    if (panZoomInstance) panZoomInstance.destroy();
                    panZoomInstance = svgPanZoom(svg, {
                        zoomEnabled: true,
                        controlIconsEnabled: false,
                        fit: true,
                        center: true
                    });
                }
            }, 500);
        }

        // Render Infographic
        if (chatData.infografia) {
            renderInfographic(chatData.infografia);
        }

        // Store Slides
        if (chatData.slides) {
            currentSlides = chatData.slides;
        }

        updateProgress(100, "¡Análisis completo!");

        // Save to IndexedDB Repository
        await saveSessionToRepo({
            name: elements.sessionName.value || 'Sesión sin nombre',
            date: new Date().toLocaleString(),
            summary: resumen, // FIXED: was 'summary'
            transcript: transcriptionText,
            audioBlob: audioBlob // We save the actual audio in the browser DB!
        });

        renderHistory();

    } catch (err) {
        elements.aiSummary.innerText = `Error: ${err.message}. Puedes reintentar sin grabar de nuevo.`;
        updateProgress(0, "Error en ejecución.");
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

    // --- Update Project Filter Dropdown ---
    const uniqueProjects = [...new Set(sessions.map(s => s.name))];
    const currentFilterVal = elements.projectFilter.value;
    elements.projectFilter.innerHTML = '<option value="all">TODOS</option>' +
        uniqueProjects.map(p => `<option value="${p}" ${p === currentFilterVal ? 'selected' : ''}>${p.toUpperCase()}</option>`).join('');

    // --- Filter logic ---
    const filtered = sessions.filter(s => {
        const matchesSearch = s.summary.toLowerCase().includes(query) || s.transcript.toLowerCase().includes(query) || s.name.toLowerCase().includes(query);
        const matchesProject = project === 'all' || s.name === project;
        return matchesSearch && matchesProject;
    });

    if (filtered.length === 0) {
        elements.historyList.innerHTML = '<p class="text-center text-xs text-slate-600">No se encontraron resultados</p>';
        return;
    }

    elements.historyList.innerHTML = filtered.map(s => `
        <div class="glass-card p-4 rounded-2xl border border-white-5 hover:border-violet-500-20 transition-all group">
            <div class="flex justify-between items-center mb-2">
                <span class="text-[10px] font-black uppercase text-violet-400">${s.name}</span>
                <span class="text-[9px] text-slate-500">${s.date}</span>
            </div>
            <p class="text-[11px] text-slate-300 line-clamp-2 mb-3">${s.summary.substring(0, 100)}...</p>
            <div class="flex gap-4">
                <button onclick="copyNoteById('${s.id}')" class="text-[9px] font-black text-slate-500 hover:text-white uppercase transition-all">Copiar</button>
                <button onclick="downloadRepoAudio(${s.id})" class="text-[9px] font-black text-blue-400 hover:text-white uppercase transition-all">Audio</button>
            </div>
        </div>
    `).join('');
}

window.downloadRepoAudio = async (id) => {
    const tx = db.transaction('sessions', 'readonly');
    const s = await new Promise(r => tx.objectStore('sessions').get(id).onsuccess = e => r(e.target.result));
    const url = URL.createObjectURL(s.audioBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${s.name.replace(/\s/g, '_')}.webm`;
    a.click();
};

window.copyNoteById = async (id) => {
    const tx = db.transaction('sessions', 'readonly');
    const s = await new Promise(r => tx.objectStore('sessions').get(parseInt(id)).onsuccess = e => r(e.target.result));
    const text = `PROYECTO: ${s.name}\nFECHA: ${s.date}\n\nRESUMEN:\n${s.summary}\n\nTRANSCRIPCIÓN:\n${s.transcript}`;
    navigator.clipboard.writeText(text);
    alert("Nota completa copiada al portapapeles.");
};

window.openSlides = () => {
    if (!currentSlides || currentSlides.length === 0) return alert("Primero analiza la sesión para generar diapositivas.");
    activeSlideIndex = 0;
    renderSlide();
    const modal = document.getElementById('slidesModal');
    modal.classList.remove('hidden');

    // Try fullscreen but don't fail if blocked or not supported
    try {
        if (document.documentElement.requestFullscreen) {
            document.documentElement.requestFullscreen();
        }
    } catch (e) { console.warn("Fullscreen blocked", e); }
};

window.closeSlides = () => {
    document.getElementById('slidesModal').classList.add('hidden');
    if (document.fullscreenElement) document.exitFullscreen().catch(() => { });
};

function renderSlide() {
    const slide = currentSlides[activeSlideIndex];
    const content = document.getElementById('slideContent');
    const counter = document.getElementById('slideCounter');

    // PowerPoint aesthetic with gradient accents and big typography
    content.classList.remove('animate-fade-in');
    void content.offsetWidth; // Trigger reflow
    content.classList.add('animate-fade-in');

    content.innerHTML = `
        <div class="mb-12 inline-block px-6 py-2 rounded-full border border-violet-500/30 bg-violet-500/5 text-violet-400 text-xs font-black tracking-[0.3em] uppercase">
            Diapositiva ${activeSlideIndex + 1}
        </div>
        <h2 class="text-white text-5xl sm:text-7xl font-black mb-12 uppercase tracking-tight leading-none bg-gradient-to-br from-white to-white/40 bg-clip-text text-transparent italic">
            ${slide.title}
        </h2>
        <div class="text-slate-300 text-xl sm:text-3xl leading-relaxed font-light max-w-3xl mx-auto">
            ${slide.content.split('\n').map(line => `
                <div class="flex items-start justify-center gap-4 mb-4">
                    <span class="text-violet-500 mt-2">•</span>
                    <span>${line.trim()}</span>
                </div>
            `).join('')}
        </div>
    `;
    counter.innerText = `${activeSlideIndex + 1} / ${currentSlides.length}`;
}

window.nextSlide = () => {
    if (activeSlideIndex < currentSlides.length - 1) {
        activeSlideIndex++;
        renderSlide();
    } else {
        closeSlides();
    }
};

window.prevSlide = () => {
    if (activeSlideIndex > 0) {
        activeSlideIndex--;
        renderSlide();
    }
};

window.exportNote = async (format) => {
    const title = elements.sessionName.value || "Sesion_Smart_Recorder";
    const date = new Date().toLocaleString();
    const summary = elements.aiSummary.innerText;
    const transcript = elements.aiTranscript.innerText;

    if (format === 'md') {
        const mdContent = `# ${title}\n*Fecha: ${date}*\n\n## 📝 RESUMEN EJECUTIVO\n${summary}\n\n---\n## 🎙️ TRANSCRIPCIÓN\n${transcript}`;
        const blob = new Blob([mdContent], { type: 'text/markdown' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${title.replace(/\s/g, '_')}.md`;
        a.click();
    } else if (format === 'pdf') {
        const printWindow = window.open('', '_blank');
        printWindow.document.write(`
            <html>
                <head>
                    <title>${title}</title>
                    <style>
                        body { font-family: sans-serif; padding: 40px; line-height: 1.6; color: #333; }
                        h1 { color: #6366f1; border-bottom: 2px solid #6366f1; padding-bottom: 10px; margin-bottom: 5px; }
                        .date { color: #888; font-size: 0.8em; margin-bottom: 30px; }
                        h2 { color: #4f46e5; margin-top: 30px; background: #f3f4f6; padding: 10px; border-radius: 5px; }
                        .content { white-space: pre-wrap; font-size: 11pt; padding: 10px; }
                        .summary-box { border-left: 5px solid #6366f1; background: #f9fafb; margin: 20px 0; }
                    </style>
                </head>
                <body>
                    <h1>${title}</h1>
                    <div class="date">${date}</div>
                    
                    <h2>📝 RESUMEN EJECUTIVO</h2>
                    <div class="summary-box">
                        <div class="content">${summary}</div>
                    </div>
                    
                    <h2>🎙️ TRANSCRIPCIÓN COMPLETA</h2>
                    <div class="content">${transcript}</div>
                </body>
            </html>
        `);
        printWindow.document.close();
        setTimeout(() => {
            printWindow.print();
        }, 500);
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
        <div class="glass p-3 px-6 rounded-2xl border border-white/5 text-center w-full sm:w-auto">
            <span class="text-[8px] text-slate-500 uppercase block mb-1">Conceptos Clave</span>
            <div class="flex flex-wrap justify-center gap-2 mt-1">
                ${(data.palabras_clave || []).map(w => `<span class="px-3 py-1 bg-violet-500/10 rounded-full text-[10px] text-slate-200 border border-white/10 uppercase font-bold">${w}</span>`).join('')}
            </div>
        </div>
    `;
}

window.toggleMindmapUI = () => {
    const container = document.getElementById('mindmapContainer');
    const toggle = document.getElementById('mindmapToggle');
    if (container.classList.contains('hidden')) {
        container.classList.remove('hidden');
        toggle.classList.add('hidden');
        if (panZoomInstance) panZoomInstance.resize().fit().center();
    } else {
        container.classList.add('hidden');
        toggle.classList.remove('hidden');
    }
};

window.resetZoom = () => {
    if (panZoomInstance) panZoomInstance.reset();
};

// UI State Toggles
function uiRecording() {
    elements.recordIcon.innerText = 'stop';
    elements.recordRing.classList.remove('hidden');
    elements.recordRing.classList.add('pulse-ring');
    elements.status.innerText = "Repo activo: Grabando...";
    elements.pauseBtn.classList.remove('hidden');
    document.getElementById('pauseSpacer').classList.remove('hidden');
    elements.fileSizeInfo.classList.remove('hidden');
}

function uiFinished() {
    elements.recordIcon.innerText = 'mic';
    elements.recordRing.classList.add('hidden');
    elements.status.innerText = "Sesión capturada.";
    elements.controls.classList.remove('hidden', 'opacity-0', 'translate-y-4', 'pointer-events-none');
    elements.pauseBtn.classList.add('hidden');
    document.getElementById('pauseSpacer').classList.add('hidden');
}

// Timer Logic
function startTimer() {
    timerInterval = setInterval(() => {
        const elapsed = accumulatedTime + (Date.now() - startTime);
        const s = Math.floor((elapsed / 1000) % 60).toString().padStart(2, '0');
        const m = Math.floor((elapsed / 1000 / 60) % 60).toString().padStart(2, '0');
        elements.timerDisplay.innerText = `${m}:${s}`;
    }, 1000);
}

function stopTimer() { clearInterval(timerInterval); }

// Event Handlers
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

    elements.cancelBtn.onclick = () => {
        if (confirm("¿Limpiar repositorio actual?")) location.reload();
    };

    elements.downloadBtn.onclick = () => {
        const blob = new Blob(audioChunks, { type: 'audio/webm' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `parts.webm`;
        a.click();
    };

    document.getElementById('saveSettings').onclick = () => {
        if (elements.sfKeyInput) localStorage.setItem('sf_api_key_v2', elements.sfKeyInput.value.trim());
        if (elements.deepgramKeyInput) localStorage.setItem('deepgram_api_key', elements.deepgramKeyInput.value.trim());
        if (elements.serverSelect) localStorage.setItem('sf_base_url', elements.serverSelect.value);
        alert("Configuración Guardada.");
        elements.settingsModal.classList.add('hidden');
    };

    elements.settingsBtn.onclick = () => elements.settingsModal.classList.remove('hidden');
    elements.sourceMic.onclick = () => { currentSource = 'mic'; elements.sourceMic.classList.add('bg-white', 'text-black'); elements.sourceSystem.classList.remove('bg-white', 'text-black'); };
    elements.sourceSystem.onclick = () => { currentSource = 'system'; elements.sourceSystem.classList.add('bg-white', 'text-black'); elements.sourceMic.classList.remove('bg-white', 'text-black'); };

    elements.searchInput.oninput = renderHistory;
    elements.projectFilter.onchange = renderHistory;

    // Auto-save on type
    if (elements.sfKeyInput) elements.sfKeyInput.onkeyup = () => localStorage.setItem('sf_api_key_v2', elements.sfKeyInput.value.trim());
    if (elements.deepgramKeyInput) elements.deepgramKeyInput.onkeyup = () => localStorage.setItem('deepgram_api_key', elements.deepgramKeyInput.value.trim());
}

function loadKey() {
    const k = localStorage.getItem('sf_api_key_v2');
    if (k && elements.sfKeyInput) elements.sfKeyInput.value = k;
    const dg = localStorage.getItem('deepgram_api_key');
    if (dg && elements.deepgramKeyInput) elements.deepgramKeyInput.value = dg;
    const s = localStorage.getItem('sf_base_url');
    if (s && elements.serverSelect) elements.serverSelect.value = s;
}

window.toggleVisibility = (id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.type = el.type === 'password' ? 'text' : 'password';
};
