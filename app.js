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
let currentMindmapCode = "";

// --- Database Logic (IndexedDB for "Digital Repositories") ---
const DB_NAME = 'SmartRecorderRepo';
const DB_VERSION = 2;
let db;

// --- Initialize Mermaid ---
mermaid.initialize({
    startOnLoad: false,
    theme: 'dark',
    securityLevel: 'loose',
    fontFamily: 'Outfit, sans-serif',
    themeVariables: {
        primaryColor: '#8B5CF6',
        primaryTextColor: '#fff',
        primaryBorderColor: '#8B5CF6',
        lineColor: '#475569',
        secondaryColor: '#3B82F6',
        tertiaryColor: '#1F2937'
    }
});

function initDB() {
    return new Promise((resolve, reject) => {
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
        request.onerror = (e) => reject(e.target.error);
        request.onblocked = () => reject(new Error("Database blocked"));
    });
}

async function saveSessionToRepo(sessionData) {
    const tx = db.transaction('sessions', 'readwrite');
    const store = tx.objectStore('sessions');
    return new Promise((resolve, reject) => {
        const req = store.put(sessionData); // put works as insert AND update depending on primary key
        req.onsuccess = () => resolve(req.result); // Returns the record ID
        req.onerror = () => reject(req.error);
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

        // High-Fidelity Recording Setup (128kbps Opus)
        const options = {
            audioBitsPerSecond: 128000,
            mimeType: 'audio/webm;codecs=opus'
        };

        try {
            mediaRecorder = new MediaRecorder(stream, options);
        } catch (e) {
            console.warn("High fidelity not supported, falling back to default.");
            mediaRecorder = new MediaRecorder(stream);
        }

        audioChunks = [];

        mediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) {
                audioChunks.push(e.data);
                const size = audioChunks.reduce((acc, c) => acc + c.size, 0);
                const mb = (size / (1024 * 1024)).toFixed(1);
                elements.currentSizeLabel.innerText = `${mb} MB`;
                if (mb > 24) stopFocus();
            }
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
    return new Promise((resolve) => {
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
            mediaRecorder.onstop = () => {
                stopTimer();
                uiFinished();
                resolve();
            };
            mediaRecorder.stop();
            mediaRecorder.stream.getTracks().forEach(track => track.stop());
        } else {
            resolve();
        }
    });
}

// --- Analysis & Progress ---
async function analyzeSession() {
    // Force stop if still recording
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        await stopFocus();
    }

    const apiKey = localStorage.getItem('sf_api_key_v2');
    const baseUrl = localStorage.getItem('sf_base_url') || 'https://api.siliconflow.com/v1';

    if (!apiKey) return elements.settingsModal.classList.remove('hidden');

    elements.resultArea.classList.remove('hidden');
    elements.progressContainer.classList.remove('hidden');
    updateProgress(10, "Iniciando análisis profesional...");

    const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
    console.log("Audio Final Blob Size:", audioBlob.size, "bytes");

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
        updateProgress(40, "Transcribiendo (Nova-2 Elite + Bilingüe)...");
        // Optimizamos parámetros para evitar el truncado y mejorar el bilingüismo
        const dgParams = new URLSearchParams({
            model: 'nova-2',
            smart_format: 'true',
            detect_language: 'true',
            diarize: 'true',
            punctuate: 'true',
            utterances: 'true'
        });

        const dgRes = await fetch(`https://api.deepgram.com/v1/listen?${dgParams}`, {
            method: 'POST',
            headers: {
                'Authorization': `Token ${dgKey}`,
                'Content-Type': audioBlob.type || 'audio/webm'
            },
            body: audioBlob
        });
        if (dgRes.ok) {
            const dgData = await dgRes.json();

            // HYBRID ENGINE: Combines Utterances (Speakers) with Channel Transcript (Full Text)
            const utterances = dgData.results.utterances;
            const fullTranscript = dgData.results.channels[0].alternatives[0].transcript;

            if (utterances && utterances.length > 0) {
                // If utterances are too short compared to full transcript, use full transcript
                const utterancesText = utterances.map(u => u.transcript).join(' ');
                if (utterancesText.length < fullTranscript.length * 0.8) {
                    console.warn("Utterances too short, using full channel transcript.");
                    transcriptionText = fullTranscript;
                } else {
                    transcriptionText = utterances.map(u => `[Sujeto ${u.speaker}]: ${u.transcript}`).join('\n\n');
                }
            } else {
                transcriptionText = fullTranscript;
            }
        } else {
            throw new Error("Fallo en Deepgram.");
        }
    } catch (err) {
        updateProgress(0, "Error en Transcripción.");
        elements.aiSummary.innerText = `Error: ${err.message}`;
        return;
    }

    elements.aiTranscript.innerText = transcriptionText;

    // --- FAIL-SAFE SAVE (Before AI processing) ---
    // If user's API fails or freezes, the transcription audio won't be lost.
    let currentDbId = null;
    try {
        currentDbId = await saveSessionToRepo({
            name: 'Auditoría en Progreso...',
            date: new Date().toLocaleString(),
            summary: "Generando resumen ejecutivo avanzado...",
            transcript: transcriptionText,
            audioBlob: audioBlob
        });
        renderHistory(); // Show the ghost record
    } catch (dbErr) {
        console.warn("No se pudo pre-guardar la sesión:", dbErr);
    }

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
                                content: `Eres un analista de élite para directivos de alto impacto. 
                                OBJETIVO: Destilar conocimiento profundo y exhaustivo de la transcripción.
                                Misión: El usuario necesita un resumen ejecutivo ALTAMENTE DETALLADO. No escatimes en información, elabora conclusiones profundas.
                                
                                GENERAR RESPUESTA EN JSON PURO:
                                {
                                  "titulo": "Título Ejecutivo Potente",
                                  "resumen": "Genera un texto extenso, organizado en párrafos ricos en detalle. Debes incluir: 1. Contexto Maestro (¿Qué está pasando exactamente y por qué?). 2. Debate y Argumentos (Si hay varios sujetos, detalla meticulosamente los acuerdos, desacuerdos, y posturas de cada uno con ejemplos de lo que dijeron). 3. Datos Duros (Fechas, cifras, nombres, lugares y métricas mencionadas). 4. Próximos Pasos (Resoluciones detalladas, responsables y fechas límite). Evita resúmenes telegráficos; usa una narrativa analítica completa y profesional que exponga todo el peso de la reunión o audio.",
                                  "mindmap": "Código Mermaid de tipo mindmap (Usa colores y jerarquía clara). REGLA CRÍTICA: JAMÁS uses términos como 'Sujeto 0' o 'Sujeto 1'. Deduce su profesión, rol o pon un nombre genérico (Entrevistador, Cliente, Experto).",
                                  "slides": [
                                    {
                                      "title": "Título Slide 1", 
                                      "content": "Párrafos súper extensos y detallados. Incluye tablas Markdown, métricas clave, o mini-gráficos ASCII (e.g. [██████░░ 80%]) y comentarios estratégicos profundos. MÍNIMO 5-8 slides con mucho texto, datos estructurados y valor informativo. NADA de slides cortas de dos líneas."
                                    }
                                  ],
                                  "infografia": {"sentimiento": "Optimista/Crítico", "relevancia": "Score 0-100", "palabras_clave": ["Insight1", "Insight2"]}
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

        // Mindmap (On-demand)
        if (mindmap) {
            currentMindmapCode = mindmap;
            document.getElementById('mindmapToggle').classList.remove('hidden');
        }

        if (infografia) renderInfographic(infografia);
        if (slides) currentSlides = slides;

        updateProgress(100, "¡Listo!");

        // Update Final Session (Merge into existing record if exists, or append new)
        const finalSessionData = {
            name: elements.sessionName.value || 'Sesión Directiva',
            date: new Date().toLocaleString(),
            summary: summaryForStorage,
            transcript: transcriptionText,
            audioBlob: audioBlob
        };

        if (currentDbId !== null) {
            finalSessionData.id = currentDbId; // Put overwrites standard key Path
        }

        await saveSessionToRepo(finalSessionData);

        renderHistory();

        // Clear draft on success
        localStorage.removeItem('sr_draft_audio');

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
    const query = (elements.searchInput.value || '').toLowerCase();
    const currentSelectValue = elements.projectFilter.value;

    // Bullet-proof string extraction for legacy objects or undefined data
    const safeString = (val) => {
        if (!val) return "";
        if (typeof val === 'object') return JSON.stringify(val);
        return String(val);
    };

    const uniqueProjects = [...new Set(sessions.map(s => safeString(s.name)))].filter(x => x);

    // Memory caching to prevent DOM dropdown wipe-outs and URIError crashes
    if (!window._cachedProjects || window._cachedProjects.join('|') !== uniqueProjects.join('|')) {
        let previousActiveProject = 'all';
        if (window._cachedProjects && elements.projectFilter.value !== 'all') {
            const oldIndex = parseInt(elements.projectFilter.value);
            if (!isNaN(oldIndex) && window._cachedProjects[oldIndex]) {
                previousActiveProject = window._cachedProjects[oldIndex];
            }
        }

        window._cachedProjects = uniqueProjects;

        // Rebuild only when actual projects change, use numeric indices avoiding any special character breaks
        elements.projectFilter.innerHTML = '<option value="all">TODOS</option>' +
            uniqueProjects.map((p, index) => {
                return `<option value="${index}">${p.replace(/</g, '&lt;').replace(/>/g, '&gt;').toUpperCase()}</option>`;
            }).join('');

        // Restore active selection gracefully
        if (previousActiveProject !== 'all') {
            const newIndex = uniqueProjects.indexOf(previousActiveProject);
            elements.projectFilter.value = newIndex !== -1 ? newIndex.toString() : 'all';
        } else {
            elements.projectFilter.value = 'all';
        }
    }

    const val = elements.projectFilter.value;
    const activeProject = val === 'all' ? 'all' : (window._cachedProjects[parseInt(val)] || 'all');

    const filtered = sessions.filter(s => {
        const textStr = safeString(s.summary) + " " + safeString(s.transcript) + " " + safeString(s.name);
        const text = textStr.toLowerCase();

        const matchesQuery = !query || text.includes(query);
        const matchesProject = (activeProject === 'all' || safeString(s.name) === activeProject);

        return matchesQuery && matchesProject;
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
            <div class="flex items-center justify-between">
                <div class="flex gap-4">
                    <button onclick="copyNoteById('${s.id}')" class="text-[9px] font-black text-slate-500 hover:text-white uppercase transition-all">Copiar</button>
                    <button onclick="downloadRepoAudio(${s.id})" class="text-[9px] font-black text-blue-400 hover:text-white uppercase transition-all">Audio</button>
                </div>
                <div onclick="deleteSessionById(${s.id}, event)" class="w-6 h-6 flex items-center justify-center text-slate-600 hover:text-red-400 transition-all cursor-pointer" title="Eliminar definitivamente">
                    <span class="material-symbols-rounded text-sm pointer-events-none">delete</span>
                </div>
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
window.deleteSessionById = (id, event) => {
    if (event) {
        event.preventDefault();
        event.stopPropagation();
    }

    if (!confirm("¿Estás seguro de eliminar esta sesión para siempre?")) return false;

    // Remove from DOM immediately to prevent any browser focus or hash jumps
    const cardElement = event.target ? event.target.closest('.glass-card') : null;
    if (cardElement) {
        cardElement.style.display = 'none';
        setTimeout(() => cardElement.remove(), 10);
    }

    // Delete from DB in background
    const tx = db.transaction('sessions', 'readwrite');
    const store = tx.objectStore('sessions');
    store.delete(parseInt(id));

    // Check if empty to show label
    setTimeout(() => {
        const hList = document.getElementById('historyList');
        if (hList && hList.children.length === 0) {
            hList.innerHTML = '<p class="text-xs text-slate-600 text-center">Repo vacío</p>';
        }
    }, 50);

    return false;
};

window.wipeAllSessions = () => {
    if (!confirm("⚠️ CUIDADO: Destruirás TODOS los repositorios permanentemente. ¿Estás seguro?")) return;

    // Attempt DB Delete
    try {
        const tx = db.transaction('sessions', 'readwrite');
        const store = tx.objectStore('sessions');
        const req = store.clear();

        req.onsuccess = () => {
            document.getElementById('historyList').innerHTML = '<p class="text-xs text-slate-600 text-center">Bóveda destruida y vaciada exitosamente.</p>';
            alert("Bóveda limpia.");
        };
        req.onerror = () => {
            alert("Error al intentar limpiar la bóveda del navegador.");
        };
    } catch (e) {
        alert("Fallo crítico en IndexedDB local: " + e.message);
    }
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
        <div class="text-slate-300 text-xl sm:text-3xl leading-relaxed font-light max-w-5xl mx-auto space-y-6 text-left whitespace-pre-wrap">
            ${slide.content}
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

window.exportMindmapPDF = () => {
    const svgElement = document.querySelector('#mermaidDiagram svg');
    if (!svgElement) return alert("El mapa aún no ha sido dibujado.");

    // Extraer el esquema visual y renderizarlo nativamente en una ventana de impresión
    const win = window.open('', '_blank');
    const svgData = new XMLSerializer().serializeToString(svgElement);
    win.document.write(`
        <html><head><title>Mapa Mental - Smart Recorder</title></head>
        <body style="margin: 0; padding: 20px; display: flex; align-items: flex-start; justify-content: flex-start; min-height: 100vh; font-family: sans-serif;">
            <div style="width: 100%;">
                <h1 style="color: #6366f1; border-bottom: 2px solid #6366f1; padding-bottom: 10px; margin-bottom: 20px;">Mapa Conceptual Visual</h1>
                ${svgData}
            </div>
        </body></html>
    `);
    win.document.close();
    setTimeout(() => {
        win.print();
    }, 800);
};

window.exportSlidesPDF = () => {
    if (!currentSlides || currentSlides.length === 0) return alert("No hay diapositivas listas.");
    const title = elements.sessionName.value || "Presentación AI";
    const coverDate = new Date().toLocaleString();

    const pagesHTML = currentSlides.map((s, index) => {
        return `
            <div style="page-break-after: always; min-height: 90vh; display: flex; flex-direction: column; justify-content: center; padding: 40px; background: #fdfdfd; font-family: sans-serif;">
                <h1 style="font-size: 38pt; font-weight: 900; color: #1e1b4b; margin-bottom: 30px; letter-spacing: -1px; border-bottom: 4px solid #8b5cf6; padding-bottom: 10px;">${s.title}</h1>
                <div style="font-size: 16pt; line-height: 1.8; color: #334155; white-space: pre-wrap; font-weight: 300;">${s.content}</div>
                <div style="margin-top: auto; text-align: right; font-size: 10pt; color: #94a3b8; font-weight: bold; border-top: 1px solid #e2e8f0; padding-top: 10px;">
                    Diapositiva ${index + 1} de ${currentSlides.length}
                </div>
            </div>
        `;
    }).join('');

    const win = window.open('', '_blank');
    win.document.write(`
        <html><head><title>${title}</title></head>
        <body style="margin: 0; padding: 0;">
            <!-- Cover Page -->
            <div style="page-break-after: always; display: flex; flex-direction: column; justify-content: center; align-items: center; min-height: 100vh; background: #0f172a; color: white; text-align: center; font-family: sans-serif; padding: 40px;">
                <h1 style="font-size: 50pt; font-weight: 900; margin-bottom: 20px; color: #8b5cf6;">${title}</h1>
                <p style="font-size: 14pt; letter-spacing: 2px; color: #cbd5e1;">GENERADO POR IA / SMART RECORDER</p>
                <p style="font-size: 12pt; color: #94a3b8; margin-top: 50px;">${coverDate}</p>
            </div>
            ${pagesHTML}
        </body></html>
    `);
    win.document.close();
    setTimeout(() => {
        win.print();
    }, 1000);
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

window.openMindmap = async () => {
    if (!currentMindmapCode) return;

    const modal = document.getElementById('mindmapModal');
    const diagEl = document.getElementById('mermaidDiagram');

    modal.classList.remove('hidden');
    diagEl.innerHTML = '<div class="text-violet-400 animate-pulse font-black uppercase tracking-widest">Generando Mapa...</div>';

    try {
        // Strip markdown backticks in case the AI included them
        let code = currentMindmapCode.replace(/```mermaid/gi, '').replace(/```/g, '').trim();

        // Ensure the code has the "mindmap" header if the AI forgot it
        if (!code.toLowerCase().startsWith('mindmap')) {
            code = 'mindmap\n' + code;
        }

        diagEl.innerHTML = code;
        diagEl.removeAttribute('data-processed');

        await mermaid.run({ nodes: [diagEl] });

        setTimeout(() => {
            const svg = diagEl.querySelector('svg');
            if (svg) {
                svg.style.maxWidth = "100%";
                svg.style.height = "100%";
                if (panZoomInstance) panZoomInstance.destroy();
                panZoomInstance = svgPanZoom(svg, {
                    zoomEnabled: true,
                    controlIconsEnabled: false,
                    fit: true,
                    center: true,
                    minZoom: 0.1,
                    maxZoom: 10
                });
            }
        }, 200);
    } catch (err) {
        console.error("Mermaid open error:", err);
        diagEl.innerHTML = `<div class="text-red-400 text-xs p-10">Error al renderizar el mapa: ${err.message}</div>`;
    }
};

window.closeMindmap = () => {
    document.getElementById('mindmapModal').classList.add('hidden');
    if (panZoomInstance) {
        panZoomInstance.destroy();
        panZoomInstance = null;
    }
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
