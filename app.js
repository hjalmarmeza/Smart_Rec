// VoxMind AI - Inteligencia Auditiva de Élite
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js')
            .then(reg => console.log('VoxMind AI: Modo Offline Activo'))
            .catch(err => console.log('SW Error:', err));
    });
}

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
let currentSessionType = 'reunion'; // Default: reunión

// ===== SESSION TYPE SELECTOR =====

// Config per type: what sections to show and what AI should return
const SESSION_TYPE_CONFIG = {
    reunion: {
        label: 'Reunión',
        showActionItems: true,
        showDecisiones: true,
        showConceptos: false,
        summaryFocus: 'Resumen de reunión con debate, acuerdos y posturas de cada participante.',
        aiFields: `"action_items": ["Tarea o compromiso detectado - Responsable"],
                                  "decisiones": ["Decisión concreta tomada"],`
    },
    entrevista: {
        label: 'Entrevista',
        showActionItems: true,
        showDecisiones: true,
        showConceptos: false,
        summaryFocus: 'Resumen de entrevista: hallazgos, perfil del entrevistado y conclusiones.',
        aiFields: `"action_items": ["Puntos clave o próximos pasos del entrevistado"],
                                  "decisiones": ["Conclusión o acuerdo alcanzado"],`
    },
    clase: {
        label: 'Clase',
        showActionItems: false,
        showDecisiones: false,
        showConceptos: true,
        summaryFocus: 'Resumen académico enfocado en conceptos, teorías y puntos de aprendizaje clave.',
        aiFields: `"conceptos_clave": ["Término: definición breve"],
                                  "action_items": [],
                                  "decisiones": [],`
    },
    dictado: {
        label: 'Dictado',
        showActionItems: false,
        showDecisiones: false,
        showConceptos: false,
        summaryFocus: 'Transcripción limpia y formateada del texto dictado. Sin análisis adicional.',
        aiFields: `"action_items": [],
                                  "decisiones": [],`
    },
    personal: {
        label: 'Personal',
        showActionItems: false,
        showDecisiones: false,
        showConceptos: false,
        summaryFocus: 'Ideas organizadas como notas personales estructuradas y coherentes.',
        aiFields: `"action_items": [],
                                  "decisiones": [],`
    }
};

window.setSessionType = (type, btn) => {
    currentSessionType = type;
    // Update button styles
    document.querySelectorAll('.session-type-btn').forEach(b => {
        b.classList.remove('border-violet-500/50', 'bg-violet-500/20', 'text-violet-400');
        b.classList.add('border-white/10', 'text-slate-500');
    });
    btn.classList.remove('border-white/10', 'text-slate-500');
    btn.classList.add('border-violet-500/50', 'bg-violet-500/20', 'text-violet-400');

    // Show/hide result sections based on type
    const cfg = SESSION_TYPE_CONFIG[type] || SESSION_TYPE_CONFIG['reunion'];
    const actionContainer = document.getElementById('actionItemsContainer');
    const decContainer = document.getElementById('decisionesContainer');
    const conceptosContainer = document.getElementById('conceptosContainer');
    if (actionContainer) actionContainer.classList.toggle('hidden', !cfg.showActionItems);
    if (decContainer) decContainer.classList.toggle('hidden', !cfg.showDecisiones);
    if (conceptosContainer) conceptosContainer.classList.toggle('hidden', !cfg.showConceptos);
};

function getSessionTypePrompt(type) {
    const cfg = SESSION_TYPE_CONFIG[type] || SESSION_TYPE_CONFIG['reunion'];
    return `
Enfoque del resumen: ${cfg.summaryFocus}
Campos adicionales requeridos en el JSON:
${cfg.aiFields}`;
}



// ===== TIMESTAMP TRANSCRIPT RENDERER =====
function renderTimestampedTranscript(text) {
    if (!text) return '<span class="text-slate-500">Sin transcripción.</span>';

    const speakerColors = [
        'from-violet-500 to-blue-500',
        'from-emerald-500 to-teal-500',
        'from-amber-500 to-orange-500',
        'from-rose-500 to-pink-500',
        'from-cyan-500 to-blue-500',
        'from-fuchsia-500 to-violet-500',
    ];

    const lines = text.split('\n').filter(l => l.trim());
    return lines.map(line => {
        // Match [MM:SS] optionally followed by [Voz N]: text
        const m = line.match(/^\[(\d{2}:\d{2})\](?:\s*\[?Voz\s*(\d+)\]?)?:?\s*(.*)/i);
        if (m) {
            const time = m[1];
            const speakerNum = m[2] ? parseInt(m[2]) - 1 : null;
            const content = m[3] || '';
            const colorClass = speakerNum !== null ? speakerColors[speakerNum % speakerColors.length] : 'from-slate-500 to-slate-600';
            const speakerBadge = speakerNum !== null
                ? `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[9px] font-black text-white bg-gradient-to-r ${colorClass} mr-2">Voz ${speakerNum + 1}</span>`
                : '';
            return `<div class="flex items-start gap-2 mb-4 group">
                <span class="flex-shrink-0 mt-0.5 px-2 py-0.5 rounded-lg text-[9px] font-black text-violet-300 cursor-default select-none"
                    style="background: rgba(139,92,246,0.12); border: 1px solid rgba(139,92,246,0.2);">${time}</span>
                <p class="text-slate-300 text-xs leading-relaxed">${speakerBadge}${content}</p>
            </div>`;
        }
        // Plain line (no timestamp)
        return `<p class="text-slate-400 text-xs leading-relaxed mb-3">${line}</p>`;
    }).join('');
}

// --- Database Logic (IndexedDB for "Digital Repositories\") ---
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

    // CRITICAL: Clear search input on startup so browser autocomplete doesn't filter out repos
    if (elements.searchInput) elements.searchInput.value = '';
    if (elements.projectFilter) elements.projectFilter.value = 'all';

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

        // Ultra-Compressed Recording Setup (16kbps Opus) - Perfect for Voice & AI Transcripts
        const options = {
            audioBitsPerSecond: 16000,
            mimeType: 'audio/webm;codecs=opus'
        };

        try {
            mediaRecorder = new MediaRecorder(stream, options);
        } catch (e) {
            console.warn("Opus compression not supported, falling back to default.", e);
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
            console.log("Deepgram raw response:", JSON.stringify(dgData?.results?.channels?.[0]?.alternatives?.[0]));

            const utterances = dgData?.results?.utterances;
            const fullTranscript = dgData?.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";

            console.log("Full transcript length:", fullTranscript.length, "| Utterances:", utterances?.length);

            if (utterances && utterances.length > 0) {
                const utterancesText = utterances.map(u => u.transcript).join(' ');
                if (utterancesText.length < fullTranscript.length * 0.8) {
                    console.warn("Utterances too short, using full channel transcript.");
                    transcriptionText = fullTranscript;
                } else {
                    // Build transcript with [MM:SS] timestamps per utterance
                    transcriptionText = utterances.map(u => {
                        const secs = Math.floor(u.start || 0);
                        const mm = String(Math.floor(secs / 60)).padStart(2, '0');
                        const ss = String(secs % 60).padStart(2, '0');
                        const speaker = u.speaker !== undefined ? `[Voz ${u.speaker + 1}]` : '';
                        return `[${mm}:${ss}]${speaker ? ' ' + speaker : ''}: ${u.transcript}`;
                    }).join('\n\n');
                }
            } else {
                transcriptionText = fullTranscript;
            }
        } else {
            const errBody = await dgRes.text().catch(() => '');
            console.error("Deepgram error response:", dgRes.status, errBody);
            throw new Error(`Deepgram error ${dgRes.status}: ${errBody.substring(0, 200)}`);
        }
    } catch (err) {
        updateProgress(0, "Error en Transcripción.");
        elements.aiSummary.innerHTML = `<div class="text-red-400 text-xs p-4 bg-red-500/10 rounded-xl border border-red-500/20"><b>Error de Transcripción:</b><br>${err.message}<br><br><span class="text-slate-400">Verifica tu Deepgram API Key en Ajustes ⚙️</span></div>`;
        return;
    }

    // CRITICAL: Do not proceed if transcription is empty — would cause AI hallucination
    if (!transcriptionText || transcriptionText.trim().length < 10) {
        updateProgress(0, "Transcripción vacía.");
        elements.aiTranscript.innerText = "(Sin contenido detectado)";
        elements.aiSummary.innerHTML = `
            <div class="text-amber-400 text-xs p-4 bg-amber-500/10 rounded-xl border border-amber-500/20">
                <b>⚠️ Sin transcripción detectada</b><br><br>
                Posibles causas:<br>
                • El audio grabado no tenía voz audible<br>
                • La grabación fue muy corta (menos de 2 segundos)<br>
                • Problema con el micrófono o la fuente de audio<br>
                • La clave de Deepgram no tiene créditos suficientes<br><br>
                <span class="text-slate-400">Intenta grabar de nuevo hablando claramente.</span>
            </div>`;
        return;
    }

    elements.aiTranscript.innerHTML = renderTimestampedTranscript(transcriptionText);




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
                                TIPO DE SESIÓN: ${currentSessionType.toUpperCase()}.
                                OBJETIVO: Destilar conocimiento profundo y exhaustivo de la transcripción.
                                Misión: El usuario necesita un resumen ejecutivo ALTAMENTE DETALLADO. No escatimes en información, elabora conclusiones profundas.
                                ${getSessionTypePrompt(currentSessionType)}
                                
                                GENERAR RESPUESTA EN JSON PURO (sin markdown):
                                {
                                  "titulo": "Título Ejecutivo Potente",
                                  "resumen": "Texto extenso en párrafos ricos. 1. Contexto. 2. Debate y argumentos. 3. Datos duros (fechas, cifras, nombres). 4. Próximos pasos.",
                                  "action_items": ["Tarea 1 - Responsable", "Tarea 2"],
                                  "decisiones": ["Decisión 1", "Decisión 2"],
                                  "mindmap": "Código Mermaid tipo 'mindmap'. PROHIBIDO usar flechas o corchetes. Solo texto indented.",
                                  "slides": [
                                    {"title": "Portada: Título impactante", "content": "Subtítulo y contexto general. Incluye emojis.", "type": "cover"},
                                    {"title": "Contexto y Situación", "content": "• Punto clave 1\n• Punto clave 2\n• Punto clave 3\n• Punto clave 4", "type": "bullets"},
                                    {"title": "Datos y Métricas", "content": "METRICS: Etiqueta1:Valor1|Etiqueta2:Valor2|Etiqueta3:Valor3|Etiqueta4:Valor4", "type": "metrics"},
                                    {"title": "Análisis Comparativo", "content": "Descripc breve\nItem A [████████░░ 80%]\nItem B [█████░░░░░ 50%]\nItem C [███░░░░░░░ 30%]", "type": "analysis"},
                                    {"title": "Puntos Debatidos", "content": "• Argumento principal con detalle\n• Contrapunto relevante\n• Postura de cada parte\n• Punto sin resolver", "type": "bullets"},
                                    {"title": "Decisiones y Acuerdos", "content": "• Acuerdo 1 tomado\n• Acuerdo 2 tomado\n• Pendiente a resolver", "type": "decisions"},
                                    {"title": "Próximos Pasos", "content": "METRICS: Prioridad Alta:Item 1|Fecha Límite:DD/MM|Responsable:Nombre|Estado:Pendiente", "type": "metrics"},
                                    {"title": "Conclusión Final", "content": "Síntesis memorable y potente de lo más importante de la sesión.", "type": "conclusion"}
                                  ],
                                  "infografia": {"sentimiento": "Optimista/Crítico", "relevancia": "0-100", "palabras_clave": ["Insight1"]}
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

        // Render Action Items
        const actionItems = chatData.action_items || [];
        const aiContainer = document.getElementById('actionItemsContainer');
        const aiList = document.getElementById('actionItemsList');
        if (actionItems.length > 0 && aiContainer && aiList) {
            aiList.innerHTML = actionItems.map((item, i) =>
                `<div class="flex items-start gap-2 p-2 bg-emerald-500/5 rounded-xl border border-emerald-500/10">
                    <span class="text-emerald-500 font-black text-xs mt-0.5">${i + 1}.</span>
                    <span>${item}</span>
                </div>`
            ).join('');
            aiContainer.classList.remove('hidden');
        } else if (aiContainer) {
            aiContainer.classList.add('hidden');
        }

        // Render Decisiones
        const decisiones = chatData.decisiones || [];
        const decContainer = document.getElementById('decisionesContainer');
        const decList = document.getElementById('decisionesList');
        if (decisiones.length > 0 && decContainer && decList) {
            decList.innerHTML = decisiones.map(d =>
                `<div class="flex items-start gap-2 p-2 bg-blue-500/5 rounded-xl border border-blue-500/10">
                    <span class="material-symbols-rounded text-blue-400 text-xs mt-0.5">check_circle</span>
                    <span>${d}</span>
                </div>`
            ).join('');
            decContainer.classList.remove('hidden');
        } else if (decContainer) {
            decContainer.classList.add('hidden');
        }

        // Render Conceptos Clave (Clase mode)
        const conceptos = chatData.conceptos_clave || [];
        const conContainer = document.getElementById('conceptosContainer');
        const conList = document.getElementById('conceptosList');
        if (conceptos.length > 0 && conContainer && conList) {
            conList.innerHTML = conceptos.map(c =>
                `<div class="flex items-start gap-2 p-2 bg-amber-500/5 rounded-xl border border-amber-500/10">
                    <span class="material-symbols-rounded text-amber-400 text-xs mt-0.5">bookmark</span>
                    <span>${c}</span>
                </div>`
            ).join('');
            conContainer.classList.remove('hidden');
        } else if (conContainer) {
            conContainer.classList.add('hidden');
        }

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
            audioBlob: audioBlob,
            mindmap: currentMindmapCode,
            slides: currentSlides,
            infografia: infografia || null
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
    try {
        const sessions = await getHistoryFromRepo();
        const query = (elements.searchInput.value || '').trim().toLowerCase();
        let currentSelectValue = elements.projectFilter.value;

        // Ultimate safety string conversion
        const safeString = (val) => {
            if (val === null || val === undefined) return "";
            if (typeof val === 'object') return JSON.stringify(val);
            return String(val);
        };

        // Bulletproof encoding for DOM injection (supports Ñ, Ó, Emojis, any length)
        const encodeDBString = (str) => btoa(encodeURIComponent(str));
        const decodeDBString = (str) => decodeURIComponent(atob(str));

        // Get unique project names ensuring no blank or corrupt data
        const uniqueProjects = [...new Set(sessions.map(s => safeString(s.name)))].filter(x => x.trim() !== "");

        // 1. Rebuild DOM options tracking previous encoded value
        let optionsHTML = '<option value="all">TODOS</option>';
        uniqueProjects.forEach(p => {
            const safeB64 = encodeDBString(p);
            const displayP = p.replace(/</g, '&lt;').replace(/>/g, '&gt;').toUpperCase();
            optionsHTML += `<option value="${safeB64}">${displayP}</option>`;
        });

        // 2. Prevent DOM tearing using strict variable caching instead of reading mutable innerHTML back
        if (window._cachedOptionsHTML !== optionsHTML) {
            window._cachedOptionsHTML = optionsHTML;
            elements.projectFilter.innerHTML = optionsHTML;
            // Best effort to restore previous selection
            if (currentSelectValue && currentSelectValue !== 'all') {
                try {
                    decodeDBString(currentSelectValue);
                    elements.projectFilter.value = currentSelectValue;
                } catch (e) {
                    elements.projectFilter.value = 'all';
                }
            }
        }

        // 3. Read exact active filter state purely from base64
        const activeDomValue = elements.projectFilter.value;
        const activeProjectDecode = activeDomValue === 'all' ? 'all' : decodeDBString(activeDomValue);

        // 4. Run Filter Core
        const filtered = sessions.filter(s => {
            const nameStr = safeString(s.name || "").trim().toLowerCase();
            const sumStr = safeString(s.summary || "").toLowerCase();
            const transStr = safeString(s.transcript || "").toLowerCase();

            const textBase = (sumStr + " " + transStr + " " + nameStr);
            const matchesQuery = !query || textBase.includes(query);

            const activeProjectStr = (activeProjectDecode || "").trim().toLowerCase();
            const matchesProject = (activeProjectStr === 'all' || nameStr === activeProjectStr);

            return matchesQuery && matchesProject;
        });

        // 5. Render
        if (filtered.length === 0) {
            elements.historyList.innerHTML = '<p class="text-xs text-slate-600 text-center uppercase tracking-widest mt-10">Repo vacío o Nada Coincide con el Filtro Seleccionado</p>';
            return;
        }

        elements.historyList.innerHTML = filtered.map(s => `
            <div onclick="openSessionViewer('${s.id}')" class="glass-card p-4 rounded-xl border border-white/5 hover:border-emerald-500/30 hover:bg-white/5 transition-all cursor-pointer group relative">
                <div class="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-all text-[8px] tracking-widest bg-emerald-500/10 text-emerald-400 px-2 py-1 rounded-full border border-emerald-500/20 uppercase font-black">
                    Ver Registro
                </div>
                <div class="flex justify-between items-center mb-2">
                    <span class="text-[9px] font-black text-violet-400 uppercase">${safeString(s.name)}</span>
                    <span class="text-[8px] text-slate-500">${s.date}</span>
                </div>
                <p class="text-[10px] text-slate-300 line-clamp-2 mb-3">${safeString(s.summary)}</p>
                <div class="flex items-center justify-between" onclick="event.stopPropagation()">
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

    } catch (criticalError) {
        elements.historyList.innerHTML = `<div class="p-6 bg-red-900/30 border border-red-500/50 rounded-xl text-xs text-red-200">
            <b>Error Fatal Renderizando:</b><br/>${criticalError.message}<br/>${criticalError.stack}
        </div>`;
    }

    // After rendering history, fetch the current local browser disk space consumption
    if (typeof updateStorageMeter === 'function') {
        updateStorageMeter();
    }
}

// ===== SESSION VIEWER MODAL (New, reliable approach) =====
let _viewerCurrentSession = null;

window.openSessionViewer = async (id) => {
    const modal = document.getElementById('sessionViewerModal');
    if (!modal) return;

    // Show modal immediately with loading state
    modal.classList.remove('hidden');
    document.getElementById('viewerSessionName').innerText = 'Cargando...';
    document.getElementById('viewerSessionDate').innerText = '';
    document.getElementById('viewerSummary').innerHTML = '<p class="text-slate-500 animate-pulse">Cargando resumen...</p>';
    document.getElementById('viewerTranscript').innerText = 'Cargando transcripción...';

    try {
        const tx = db.transaction('sessions', 'readonly');
        const s = await new Promise((resolve, reject) => {
            const req = tx.objectStore('sessions').get(parseInt(id));
            req.onsuccess = e => resolve(e.target.result);
            req.onerror = e => reject(e.target.error);
        });

        if (!s) {
            document.getElementById('viewerSummary').innerHTML = '<p class="text-red-400">Error: No se encontró el registro.</p>';
            return;
        }

        _viewerCurrentSession = s;

        document.getElementById('viewerSessionName').innerText = s.name || 'Sin título';
        document.getElementById('viewerSessionDate').innerText = s.date || '';

        // Render summary
        if (s.summary) {
            const lines = typeof s.summary === 'string' ? s.summary.split('\n') : [String(s.summary)];
            document.getElementById('viewerSummary').innerHTML = lines.map(p => `<p class="mb-2">${p}</p>`).join('');
        } else {
            document.getElementById('viewerSummary').innerHTML = '<p class="text-slate-500">Sin resumen disponible.</p>';
        }

        // Render transcript
        document.getElementById('viewerTranscript').innerHTML = renderTimestampedTranscript(s.transcript || '');

    } catch (err) {
        document.getElementById('viewerSummary').innerHTML = `<p class="text-red-400">Error al cargar: ${err.message}</p>`;
    }
};

// ===== VIEWER: Generate Mindmap from saved session =====
window.generateViewerMindmap = async () => {
    const s = _viewerCurrentSession;
    if (!s) return alert('Abre un registro primero.');

    const transcript = s.transcript || s.summary || '';
    if (!transcript || transcript.length < 20) return alert('Este registro no tiene suficiente contenido para generar un mapa mental.');

    const apiKey = localStorage.getItem('sf_api_key_v2');
    const baseUrl = localStorage.getItem('sf_base_url') || 'https://api.siliconflow.com/v1';
    if (!apiKey) return alert('Configura tu API Key en Ajustes ⚙️');

    const progress = document.getElementById('viewerProgress');
    const progressBar = document.getElementById('viewerProgressBar');
    const progressLabel = document.getElementById('viewerProgressLabel');
    const mmSection = document.getElementById('viewerMindmapSection');
    const mmContainer = document.getElementById('viewerMindmapContainer');

    progress.classList.remove('hidden');
    progressBar.style.width = '20%';
    progressLabel.innerText = 'Generando Mapa Mental con IA...';
    mmSection.classList.add('hidden');

    try {
        progressBar.style.width = '60%';
        const res = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'deepseek-ai/DeepSeek-V3',
                messages: [
                    {
                        role: 'system',
                        content: 'Genera ÚNICAMENTE código Mermaid de tipo mindmap. REGLA FATAL: PROHIBIDO usar flechas (-->), corchetes ([ ]) o paréntesis. Solo texto plano con indentación. Responde SOLO el código mermaid, sin markdown ni explicaciones.'
                    },
                    { role: 'user', content: `Genera un mindmap detallado de este contenido:\n\n${transcript.substring(0, 4000)}` }
                ]
            })
        });

        progressBar.style.width = '90%';
        if (!res.ok) throw new Error(`Error de API: ${res.status}`);
        const data = await res.json();
        let mermaidCode = data.choices[0].message.content.trim();

        // Set global and use the existing openMindmap() which has all the scrubbing logic
        currentMindmapCode = mermaidCode;

        progressBar.style.width = '100%';
        progressLabel.innerText = '¡Mapa listo! Abriendo...';
        setTimeout(() => {
            progress.classList.add('hidden');
            closeSessionViewer();
            openMindmap();
        }, 400);

    } catch (err) {
        progressLabel.innerText = 'Error: ' + err.message;
        progressBar.style.width = '0%';
        setTimeout(() => progress.classList.add('hidden'), 3000);
    }
};

// ===== VIEWER: Generate Slides from saved session =====
window.generateViewerSlides = async () => {
    const s = _viewerCurrentSession;
    if (!s) return alert('Abre un registro primero.');

    const transcript = s.transcript || s.summary || '';
    if (!transcript || transcript.length < 20) return alert('Este registro no tiene suficiente contenido para generar diapositivas.');

    const apiKey = localStorage.getItem('sf_api_key_v2');
    const baseUrl = localStorage.getItem('sf_base_url') || 'https://api.siliconflow.com/v1';
    if (!apiKey) return alert('Configura tu API Key en Ajustes ⚙️');

    const progress = document.getElementById('viewerProgress');
    const progressBar = document.getElementById('viewerProgressBar');
    const progressLabel = document.getElementById('viewerProgressLabel');

    progress.classList.remove('hidden');
    progressBar.style.width = '20%';
    progressLabel.innerText = 'Generando Presentación con IA...';

    try {
        progressBar.style.width = '60%';
        const res = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'deepseek-ai/DeepSeek-V3',
                messages: [
                    {
                        role: 'system',
                        content: `Genera una presentación en JSON con MÍNIMO 8 diapositivas basada en el contenido dado. 
                        JSON debe ser: {"slides": [{"title": "...", "content": "...", "type": "cover|bullets|metrics|analysis|decisions|conclusion"}]}
                        Para tipo "metrics": content = "METRICS: Label1:Valor1|Label2:Valor2|Label3:Valor3|Label4:Valor4"
                        Para tipo "analysis": content incluye barras "Item [████░░ 70%]"
                        Para tipo "bullets": content con líneas "• Punto"
                        Responde SOLO JSON puro, sin markdown.`
                    },
                    { role: 'user', content: `Título: ${s.name}\n\nContenido:\n${transcript.substring(0, 5000)}` }
                ],
                response_format: { type: 'json_object' }
            })
        });

        progressBar.style.width = '90%';
        if (!res.ok) throw new Error(`Error de API: ${res.status}`);
        const data = await res.json();

        // Safe JSON parse: API may return string or already-parsed object
        let rawContent = data.choices[0].message.content;
        let parsed;
        if (typeof rawContent === 'string') {
            const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
            parsed = JSON.parse(jsonMatch ? jsonMatch[0] : rawContent);
        } else {
            parsed = rawContent; // already an object
        }

        if (!parsed.slides || !Array.isArray(parsed.slides) || parsed.slides.length === 0) {
            throw new Error('La IA no generó diapositivas válidas. Intenta de nuevo.');
        }

        currentSlides = parsed.slides;
        activeSlideIndex = 0;
        progressBar.style.width = '100%';
        progressLabel.innerText = `¡${parsed.slides.length} diapositivas listas!`;
        setTimeout(() => {
            progress.classList.add('hidden');
            closeSessionViewer();
            openSlides();
        }, 600);

    } catch (err) {
        progressLabel.innerText = 'Error: ' + err.message;
        progressBar.style.width = '0%';
        setTimeout(() => progress.classList.add('hidden'), 3000);
    }
};

window.closeSessionViewer = () => {
    const modal = document.getElementById('sessionViewerModal');
    if (modal) modal.classList.add('hidden');
    _viewerCurrentSession = null;
    _viewerChatHistory = [];
};

// ===== CHAT CON LA GRABACIÓN =====
let _viewerChatHistory = [];

window.sendViewerChat = async () => {
    const s = _viewerCurrentSession;
    if (!s) return;
    const input = document.getElementById('viewerChatInput');
    const question = (input?.value || '').trim();
    if (!question) return;

    const apiKey = localStorage.getItem('sf_api_key_v2');
    const baseUrl = localStorage.getItem('sf_base_url') || 'https://api.siliconflow.com/v1';
    if (!apiKey) return alert('Configura tu API Key en Ajustes ⚙️');

    const transcript = s.transcript || '';
    const chatBox = document.getElementById('viewerChatBox');
    input.value = '';
    input.disabled = true;

    // Render user message
    _viewerChatHistory.push({ role: 'user', content: question });
    renderChatHistory();

    // Typing indicator
    const typingId = 'typing_' + Date.now();
    chatBox.insertAdjacentHTML('beforeend', `
        <div id="${typingId}" class="flex items-center gap-2 mt-3">
            <div class="w-7 h-7 rounded-xl flex items-center justify-center flex-shrink-0" style="background: linear-gradient(135deg,rgba(139,92,246,0.3),rgba(59,130,246,0.3))">
                <span class="material-symbols-rounded text-xs text-violet-400">smart_toy</span>
            </div>
            <div class="px-3 py-2 rounded-2xl text-xs text-slate-400" style="background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.06);">
                <span class="animate-pulse">Pensando...</span>
            </div>
        </div>`);
    chatBox.scrollTop = chatBox.scrollHeight;

    try {
        const messages = [
            {
                role: 'system',
                content: `Eres un asistente que ayuda a analizar grabaciones. Solo responde basándote en el contenido de la transcripción proporcionada. Si la información no está en la transcripción, dilo claramente. Responde en el mismo idioma de la pregunta. Sé conciso y directo.\n\nTRANSCRIPCIÓN:\n${transcript.substring(0, 6000)}`
            },
            ..._viewerChatHistory
        ];

        const res = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'deepseek-ai/DeepSeek-V3', messages })
        });

        if (!res.ok) throw new Error(`Error ${res.status}`);
        const data = await res.json();
        const answer = data.choices[0].message.content.trim();
        _viewerChatHistory.push({ role: 'assistant', content: answer });

    } catch (err) {
        _viewerChatHistory.push({ role: 'assistant', content: `❌ Error: ${err.message}` });
    } finally {
        document.getElementById(typingId)?.remove();
        input.disabled = false;
        input.focus();
        renderChatHistory();
    }
};

function renderChatHistory() {
    const chatBox = document.getElementById('viewerChatBox');
    if (!chatBox) return;

    // Only re-render messages (keep typing indicator if present)
    const messages = _viewerChatHistory.map(msg => {
        const isUser = msg.role === 'user';
        return isUser
            ? `<div class="flex justify-end mb-3">
                <div class="max-w-[85%] px-3 py-2 rounded-2xl rounded-tr-sm text-xs text-white leading-relaxed" style="background: linear-gradient(135deg,rgba(139,92,246,0.4),rgba(59,130,246,0.3)); border:1px solid rgba(139,92,246,0.3);">
                    ${msg.content}
                </div>
               </div>`
            : `<div class="flex items-start gap-2 mb-3">
                <div class="w-7 h-7 rounded-xl flex items-center justify-center flex-shrink-0 mt-0.5" style="background: linear-gradient(135deg,rgba(139,92,246,0.2),rgba(59,130,246,0.2)); border:1px solid rgba(139,92,246,0.2)">
                    <span class="material-symbols-rounded text-xs text-violet-400">smart_toy</span>
                </div>
                <div class="max-w-[85%] px-3 py-2 rounded-2xl rounded-tl-sm text-xs text-slate-200 leading-relaxed" style="background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08);">
                    ${msg.content.replace(/\n/g, '<br>')}
                </div>
               </div>`;
    }).join('');

    chatBox.innerHTML = messages || '<p class="text-slate-600 text-[10px] text-center uppercase tracking-widest mt-4">Haz una pregunta sobre esta grabación</p>';
    chatBox.scrollTop = chatBox.scrollHeight;
}

window.clearViewerChat = () => {
    _viewerChatHistory = [];
    renderChatHistory();
};

window.viewerChatKeypress = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendViewerChat();
    }
};



window.exportViewerPDF = () => {
    const s = _viewerCurrentSession;
    if (!s) return alert('No hay sesión cargada.');

    const win = window.open('', '_blank');
    if (!win) return alert('Activa las ventanas emergentes en tu navegador para exportar.');

    win.document.write(`
        <html><head><title>${s.name}</title>
        <style>
            body { font-family: Arial, sans-serif; max-width: 800px; margin: 40px auto; color: #1a1a2e; line-height: 1.7; }
            h1 { color: #6d28d9; font-size: 22px; margin-bottom: 4px; }
            .date { color: #888; font-size: 12px; margin-bottom: 30px; }
            h2 { color: #444; font-size: 14px; border-bottom: 2px solid #e5e7eb; padding-bottom: 8px; margin-top: 30px; }
            p { font-size: 13px; margin-bottom: 12px; }
            .transcript { background: #f9fafb; border-left: 3px solid #6d28d9; padding: 16px; font-size: 12px; white-space: pre-wrap; }
        </style></head><body>
        <h1>${s.name || 'Sin título'}</h1>
        <p class="date">${s.date || ''} — Generado por VoxMind AI</p>
        <h2>📝 RESUMEN EJECUTIVO</h2>
        ${s.summary ? s.summary.split('\n').map(p => `<p>${p}</p>`).join('') : '<p>Sin resumen.</p>'}
        <h2>🎙️ TRANSCRIPCIÓN</h2>
        <div class="transcript">${s.transcript || 'Sin transcripción.'}</div>
        <p style="text-align:center; font-size:10px; color:#aaa; margin-top:40px;">Registro analizado con tecnología VoxMind AI</p>
        </body></html>
    `);
    win.document.close();
    setTimeout(() => win.print(), 500);
};



async function updateStorageMeter() {
    if (navigator.storage && navigator.storage.estimate) {
        try {
            const estimate = await navigator.storage.estimate();
            const usedMB = (estimate.usage / (1024 * 1024)).toFixed(1);
            const totalMB = (estimate.quota / (1024 * 1024)).toFixed(1);
            let percent = (estimate.usage / estimate.quota) * 100;
            if (percent > 100) percent = 100;

            const meter = document.getElementById('storageMeter');
            const bar = document.getElementById('storageBar');
            const text = document.getElementById('storageText');

            if (meter && bar && text) {
                meter.classList.remove('hidden');
                bar.style.width = `${percent}%`;

                // Color Warning Logic
                bar.className = 'h-full transition-all rounded-full ' +
                    (percent > 90 ? 'bg-red-500' : percent > 70 ? 'bg-amber-400' : 'bg-emerald-400');
                text.className = 'text-[9px] font-black tracking-widest uppercase ml-2 ' +
                    (percent > 90 ? 'text-red-500' : percent > 70 ? 'text-amber-400' : 'text-emerald-400');

                let usedDisplay = `${usedMB} MB`;
                if (usedMB >= 1024) usedDisplay = `${(usedMB / 1024).toFixed(2)} GB`;

                let totalDisplay = `${totalMB} MB`;
                if (totalMB >= 1024) totalDisplay = `${(totalMB / 1024).toFixed(0)} GB`; // Truncate cleanly for GB quota

                text.innerText = `USADO: ${usedDisplay} / TOTAL: ${totalDisplay} (${percent.toFixed(1)}%)`;
            }
        } catch (e) {
            console.warn("Storage API not supported or failed", e);
        }
    }
}

window.openSessionById = async (id) => {
    try {
        // Reset filters so history doesn't show empty after opening
        if (elements.searchInput) elements.searchInput.value = '';
        if (elements.projectFilter) elements.projectFilter.value = 'all';
        window._cachedOptionsHTML = null; // Force filter dropdown to refresh

        const tx = db.transaction('sessions', 'readonly');
        const s = await new Promise((r, reject) => {
            const req = tx.objectStore('sessions').get(parseInt(id));
            req.onsuccess = e => r(e.target.result);
            req.onerror = e => reject(e.target.error);
        });

        if (!s) return;

        // Populate top GUI
        elements.sessionName.value = s.name || '';
        elements.aiTranscript.innerText = s.transcript || 'Sin transcripción.';

        // Build summary correctly depending on object type or single string
        if (s.summary) {
            let parsedSum = "";
            let summaryTextLines = typeof s.summary === 'string' ? s.summary.split('\n') : [s.summary];
            parsedSum = summaryTextLines.map(p => `<p class="mb-3">${p}</p>`).join('');
            elements.aiSummary.innerHTML = parsedSum;
        } else {
            elements.aiSummary.innerHTML = '<p class="text-slate-500">Resumen perdido.</p>';
        }

        // Restore complex datasets (may be null/undefined on older pre-v16.3 records)
        currentSlides = s.slides || [];
        currentMindmapCode = s.mindmap || "";

        if (currentMindmapCode) document.getElementById('mindmapToggle').classList.remove('hidden');
        else document.getElementById('mindmapToggle').classList.add('hidden');

        if (s.infografia) renderInfographic(s.infografia);
        else {
            const c = document.getElementById('infographicContainer');
            if (c) c.classList.add('hidden');
        }

        // Ensure all UI components for results are visible
        elements.resultArea.classList.remove('hidden');
        elements.progressContainer.classList.remove('hidden');
        elements.status.innerText = "Repositorio Cargado En Panel Superior";
        elements.progressBar.style.width = '100%';

        // Smooth scroll and visual feedback
        setTimeout(() => {
            window.scrollTo({ top: 0, left: 0, behavior: 'smooth' });
            // Add a ring effect to highligth the loaded content
            elements.resultArea.classList.add('ring-4', 'ring-emerald-500', 'ring-opacity-50', 'rounded-3xl');
            setTimeout(() => {
                elements.resultArea.classList.remove('ring-4', 'ring-emerald-500', 'ring-opacity-50');
            }, 2000);
        }, 100);

    } catch (err) {
        alert("Fallo al abrir archivo de bóveda: " + err.message);
    }
};

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
    const delReq = store.delete(parseInt(id));

    delReq.onsuccess = () => {
        if (typeof updateStorageMeter === 'function') setTimeout(() => updateStorageMeter(), 200);
    };

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
            if (typeof updateStorageMeter === 'function') setTimeout(() => updateStorageMeter(), 200);
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
    const type = slide.type || 'default';
    const isFirst = activeSlideIndex === 0;
    const isLast = activeSlideIndex === currentSlides.length - 1;

    const palettes = [
        { from: 'from-violet-600', to: 'to-blue-600', accent: 'text-violet-300' },
        { from: 'from-blue-600', to: 'to-cyan-500', accent: 'text-blue-300' },
        { from: 'from-emerald-600', to: 'to-teal-500', accent: 'text-emerald-300' },
        { from: 'from-amber-500', to: 'to-orange-600', accent: 'text-amber-300' },
        { from: 'from-rose-600', to: 'to-pink-600', accent: 'text-rose-300' },
        { from: 'from-indigo-600', to: 'to-purple-600', accent: 'text-indigo-300' },
        { from: 'from-cyan-500', to: 'to-blue-600', accent: 'text-cyan-300' },
        { from: 'from-fuchsia-600', to: 'to-violet-600', accent: 'text-fuchsia-300' },
    ];
    const pal = palettes[activeSlideIndex % palettes.length];

    let bodyHTML = '';
    const metricsMatch = slide.content && slide.content.match(/METRICS:\s*(.+)/);

    if (metricsMatch) {
        const pairs = metricsMatch[1].split('|').map(p => p.trim());
        bodyHTML = `<div class="grid grid-cols-2 gap-4 w-full max-w-2xl mx-auto mt-6">
            ${pairs.map(p => {
            const [label, val] = p.split(':').map(x => x?.trim() || '');
            return `<div class="bg-white/5 border border-white/10 rounded-3xl p-5 text-center">
                    <div class="text-3xl sm:text-5xl font-black text-white mb-2">${val || '—'}</div>
                    <div class="text-[10px] uppercase tracking-widest ${pal.accent}">${label}</div>
                </div>`;
        }).join('')}
        </div>`;
    } else if (slide.content && (slide.content.includes('•') || /^\s*-\s/m.test(slide.content))) {
        const lines = slide.content.split('\n').filter(l => l.trim());
        bodyHTML = `<ul class="text-left space-y-4 max-w-3xl mx-auto mt-6 w-full">
            ${lines.map(line => {
            const clean = line.replace(/^[•\-]\s*/, '').trim();
            const isBullet = /^[•\-]/.test(line.trim());
            return isBullet
                ? `<li class="flex items-start gap-3 text-slate-200 text-lg sm:text-xl leading-snug">
                        <span class="mt-2 w-2 h-2 rounded-full flex-shrink-0 bg-gradient-to-r ${pal.from} ${pal.to}"></span>
                        <span>${clean}</span></li>`
                : `<li class="text-slate-400 text-sm pl-5 italic">${clean}</li>`;
        }).join('')}
        </ul>`;
    } else if (slide.content && slide.content.includes('█')) {
        const lines = slide.content.split('\n').filter(l => l.trim());
        bodyHTML = `<div class="space-y-4 text-left max-w-2xl mx-auto mt-6 w-full">
            ${lines.map(line => {
            const barMatch = line.match(/^(.+?)\s*\[([█░▓▒\s]+)(\d+%)\]/);
            if (barMatch) {
                const label = barMatch[1].trim();
                const pct = parseInt(barMatch[3]);
                return `<div>
                        <div class="flex justify-between text-sm text-slate-300 mb-2">
                            <span>${label}</span>
                            <span class="${pal.accent} font-black">${barMatch[3]}</span>
                        </div>
                        <div class="h-3 bg-white/10 rounded-full overflow-hidden">
                            <div class="h-full bg-gradient-to-r ${pal.from} ${pal.to} rounded-full" style="width:${pct}%"></div>
                        </div></div>`;
            }
            return `<p class="text-slate-400 text-sm">${line}</p>`;
        }).join('')}
        </div>`;
    } else if (type === 'cover' || isFirst) {
        bodyHTML = `
            <p class="text-slate-300 text-xl sm:text-2xl leading-relaxed max-w-2xl mx-auto font-light mt-4">${slide.content}</p>
            <div class="mt-10 flex justify-center gap-2">
                ${Array.from({ length: currentSlides.length }, (_, i) =>
            `<div class="transition-all duration-300 rounded-full ${i === 0 ? `w-6 h-2 bg-gradient-to-r ${pal.from} ${pal.to}` : 'w-2 h-2 bg-white/20'}"></div>`).join('')}
            </div>`;
    } else if (type === 'conclusion' || isLast) {
        bodyHTML = `<div class="max-w-2xl mx-auto mt-6">
            <div class="text-5xl mb-6">💡</div>
            <p class="text-white text-xl sm:text-2xl leading-relaxed font-light">${slide.content}</p>
        </div>`;
    } else {
        const paras = (slide.content || '').split('\n').filter(p => p.trim());
        bodyHTML = `<div class="text-slate-300 text-base sm:text-lg leading-relaxed max-w-3xl mx-auto space-y-4 text-left mt-6">
            ${paras.map(p => `<p>${p}</p>`).join('')}
        </div>`;
    }

    const dots = Array.from({ length: currentSlides.length }, (_, i) =>
        `<div class="transition-all duration-300 rounded-full ${i === activeSlideIndex
            ? `w-6 h-2 bg-gradient-to-r ${pal.from} ${pal.to}`
            : 'w-2 h-2 bg-white/20'}"></div>`
    ).join('');

    content.innerHTML = `
        <div class="w-full max-w-5xl mx-auto flex flex-col items-center text-center px-4 sm:px-10">
            <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full mb-5 bg-white/5 border border-white/10">
                <div class="w-1.5 h-1.5 rounded-full bg-gradient-to-r ${pal.from} ${pal.to}"></div>
                <span class="text-[9px] font-black uppercase tracking-[0.3em] ${pal.accent}">
                    ${isFirst ? 'Portada' : isLast ? 'Conclusión' : 'Diapositiva ' + (activeSlideIndex + 1)}
                </span>
            </div>
            <h2 class="text-white text-3xl sm:text-5xl md:text-6xl font-black mb-4 leading-tight bg-gradient-to-r ${pal.from} ${pal.to} bg-clip-text text-transparent">
                ${slide.title}
            </h2>
            ${bodyHTML}
            <div class="flex justify-center items-center gap-2 mt-10">${dots}</div>
        </div>
    `;
    counter.innerText = `${activeSlideIndex + 1} / ${currentSlides.length}`;
}


window.nextSlide = () => {
    if (activeSlideIndex < currentSlides.length - 1) { activeSlideIndex++; renderSlide(); }
    else closeSlides();
};

window.prevSlide = () => { if (activeSlideIndex > 0) { activeSlideIndex--; renderSlide(); } };

// ===== EMAIL GENERATOR =====
window.generateEmail = async () => {
    const apiKey = localStorage.getItem('sf_api_key_v2');
    const baseUrl = localStorage.getItem('sf_base_url') || 'https://api.siliconflow.com/v1';
    if (!apiKey) return alert('Configura tu API Key antes de generar el email.');

    const summary = elements.aiSummary.innerText;
    const sessionTitle = elements.sessionName.value || 'Sesión';
    if (!summary || summary === 'Redactando...') return alert('Primero analiza una sesión.');

    const emailContainer = document.getElementById('emailContainer');
    const emailContent = document.getElementById('emailContent');
    emailContent.innerText = '✍️ Generando email...';
    emailContainer.classList.remove('hidden');

    try {
        const res = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'deepseek-ai/DeepSeek-V3',
                messages: [
                    {
                        role: 'system',
                        content: `Eres un asistente de comunicación ejecutiva. Genera un email profesional y formal en español basado en el resumen de una sesión. 
                        El email debe tener: Asunto, Saludo formal, Cuerpo con los puntos clave, Cierre profesional y firma genérica. 
                        Responde SOLO con el texto del email, sin comentarios adicionales.`
                    },
                    {
                        role: 'user',
                        content: `Tema de la sesión: ${sessionTitle}\n\nResumen:\n${summary}`
                    }
                ]
            })
        });

        if (res.ok) {
            const data = await res.json();
            const email = data.choices[0].message.content;
            emailContent.innerText = email;
        } else {
            emailContent.innerText = 'Error al generar el email. Intenta de nuevo.';
        }
    } catch (err) {
        emailContent.innerText = 'Error de conexión: ' + err.message;
    }
};

window.copyEmail = () => {
    const emailContent = document.getElementById('emailContent');
    if (emailContent) {
        navigator.clipboard.writeText(emailContent.innerText)
            .then(() => alert('Email copiado al portapapeles.'))
            .catch(() => alert('No se pudo copiar. Selecciona el texto manualmente.'));
    }
};

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
        // Enhance raw transcript with UI color bubbles for speakers dynamically
        const styledTranscript = transcript.replace(/\[((Voz|Sujeto)\s+\d+)\]:/g, '<div class="speaker-tag">$1</div>');

        const win = window.open('', '_blank');
        win.document.write(`
            <html>
                <head>
                    <title>${title}</title>
                    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;700;900&display=swap" rel="stylesheet">
                    <style>
                        @page { size: A4; margin: 20mm; }
                        @media print { html, body { width: 100%; height: 100%; margin: 0; padding: 0; } }
                        body { 
                            font-family: 'Inter', sans-serif; 
                            line-height: 1.6; 
                            color: #1e293b; 
                            background: #ffffff;
                            margin: 0;
                            padding: 0;
                        }
                        .header-brand {
                            text-align: right; font-size: 8pt; color: #94a3b8; text-transform: uppercase; font-weight: 700; letter-spacing: 2px;
                            border-bottom: 2px solid #f1f5f9; padding-bottom: 10px; margin-bottom: 40px;
                        }
                        h1 { color: #0f172a; font-size: 24pt; font-weight: 900; letter-spacing: -1px; margin-bottom: 5px; line-height: 1.2; }
                        .date { color: #64748b; font-size: 10pt; font-weight: 700; margin-bottom: 40px; }
                        h2 { 
                            color: #6366f1; font-size: 14pt; padding-bottom: 8px; border-bottom: 2px solid #e0e7ff; 
                            margin-top: 50px; text-transform: uppercase; letter-spacing: 1px;
                        }
                        .box { 
                            background: #f8fafc; padding: 25px; border-left: 5px solid #6366f1; border-radius: 4px 8px 8px 4px;
                            box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05);
                        }
                        .content { white-space: pre-wrap; font-size: 10pt; color: #334155; }
                        .speaker-tag {
                            display: inline-block; background: #e0e7ff; color: #4f46e5; padding: 2px 8px; 
                            border-radius: 4px; font-weight: 800; font-size: 8pt; text-transform: uppercase;
                            margin-top: 15px; margin-bottom: 2px;
                        }
                        .footer { margin-top: 50px; text-align: center; font-size: 8pt; color: #cbd5e1; border-top: 1px solid #f1f5f9; padding-top: 20px; }
                    </style>
                </head>
                <body>
                    <div class="header-brand">VoxMind AI / Reporte de Inteligencia Auditiva</div>
                    <h1>${title}</h1>
                    <div class="date">${date}</div>
                    
                    <h2>Resumen Ejecutivo</h2>
                    <div class="box"><div class="content">${sessionResumen}</div></div>
                    
                    <h2>Transcripción Oficial</h2>
                    <div class="content" style="padding: 10px 0;">${styledTranscript}</div>

                    <div class="footer">Documento generado por IA a través de VoxMind AI.</div>
                </body>
            </html>
        `);
        win.document.close();
        setTimeout(() => win.print(), 800);
    }
};

window.exportMindmapPDF = () => {
    const svgElement = document.querySelector('#mermaidDiagram svg');
    if (!svgElement) return alert("El mapa aún no ha sido dibujado.");

    // Extraer el esquema visual y renderizarlo nativamente en una ventana de impresión
    const win = window.open('', '_blank');
    const svgData = new XMLSerializer().serializeToString(svgElement);
    win.document.write(`
        <html><head><title>Mapa Mental - VoxMind AI</title></head>
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
            <div style="page-break-after: always; min-height: 100vh; display: flex; flex-direction: column; justify-content: flex-start; padding: 12mm; background: #ffffff; position: relative;">
                <!-- Header -->
                <div style="display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid #f1f5f9; padding-bottom: 10px; margin-bottom: 30px;">
                    <h1 style="font-size: 26pt; font-weight: 900; color: #0f172a; margin: 0; letter-spacing: -1px; width: 80%;">${s.title}</h1>
                    <div style="font-size: 8pt; font-weight: 800; color: #8b5cf6; text-transform: uppercase; background: #f3f4f6; padding: 4px 10px; border-radius: 20px;">Pag. ${index + 1} / ${currentSlides.length}</div>
                </div>
                
                <!-- Content Box -->
                <div style="font-size: 13pt; line-height: 1.7; color: #334155; white-space: pre-wrap; font-weight: 400; flex-grow: 1; text-align: justify; text-justify: inter-word;">${s.content}</div>
                
                <!-- Footer -->
                <div style="margin-top: auto; border-top: 1px solid #f8fafc; padding-top: 15px; display: flex; justify-content: space-between; align-items: center;">
                    <span style="font-size: 8pt; font-weight: bold; color: #cbd5e1; letter-spacing: 1px;">VOXMIND AI</span>
                    <span style="font-size: 8pt; color: #94a3b8;">${coverDate}</span>
                </div>
            </div>
        `;
    }).join('');

    const win = window.open('', '_blank');
    win.document.write(`
        <html><head>
            <title>${title}</title>
            <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;700;900&display=swap" rel="stylesheet">
            <style>
                @page { size: A4 landscape; margin: 0; }
                @media print { html, body { width: 100%; height: 100%; margin: 0; padding: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
                body { margin: 0; padding: 0; font-family: 'Inter', sans-serif; box-sizing: border-box; }
            </style>
        </head>
        <body>
            <!-- Cover Page -->
            <div style="page-break-after: always; display: flex; flex-direction: column; justify-content: center; align-items: center; min-height: 100vh; background: #0f172a; color: white; text-align: center; padding: 40px; border: 15px solid #8b5cf6; box-sizing: border-box;">
                <h1 style="font-size: 45pt; font-weight: 900; margin-bottom: 25px; color: #ffffff; line-height: 1.1;">${title}</h1>
                <div style="width: 100px; height: 4px; background: #8b5cf6; margin-bottom: 30px;"></div>
                <p style="font-size: 12pt; letter-spacing: 4px; color: #94a3b8; text-transform: uppercase;">Presentación Generada por Inteligencia Artificial</p>
                <div style="position: absolute; bottom: 40px; font-size: 10pt; color: #475569; font-weight: 700;">${coverDate}</div>
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

    // Calculate Speaker Stats from transcript tags [Voz N]
    const transcript = elements.aiTranscript.innerText || '';
    const speakerMatches = transcript.match(/\[Voz\s+(\d+)\]/g) || [];
    const speakerStats = {};
    let totalMentions = speakerMatches.length;

    speakerMatches.forEach(tag => {
        const num = tag.match(/\d+/)[0];
        speakerStats[num] = (speakerStats[num] || 0) + 1;
    });

    const colors = [
        'from-violet-500 to-blue-500',
        'from-emerald-500 to-teal-500',
        'from-amber-500 to-orange-500',
        'from-rose-500 to-pink-500',
    ];

    let speakerHTML = '';
    if (totalMentions > 0) {
        speakerHTML = `
            <div class="w-full mt-6 pt-6 border-t border-white/5">
                <p class="text-[9px] font-black text-slate-500 uppercase tracking-[0.2em] mb-4 text-center">Participación por Voz</p>
                <div class="space-y-4">
                    ${Object.entries(speakerStats).map(([num, count], i) => {
            const pct = Math.round((count / totalMentions) * 100);
            const colorClass = colors[i % colors.length];
            return `
                            <div>
                                <div class="flex justify-between text-[10px] font-bold text-slate-400 mb-1.5 px-1">
                                    <span>Voz ${num}</span>
                                    <span class="text-white">${pct}%</span>
                                </div>
                                <div class="h-2 bg-white/5 rounded-full overflow-hidden border border-white/5">
                                    <div class="h-full bg-gradient-to-r ${colorClass} rounded-full transition-all duration-1000" style="width: ${pct}%"></div>
                                </div>
                            </div>
                        `;
        }).join('')}
                </div>
            </div>
        `;
    }

    content.innerHTML = `
        <div class="flex flex-wrap justify-center gap-3 w-full">
            <div class="glass p-3 px-6 rounded-2xl border border-white/5 text-center min-w-[120px]">
                <span class="text-[8px] text-slate-500 uppercase block mb-1">Sentimiento</span>
                <span class="text-xs font-bold text-white uppercase">${data.sentimiento}</span>
            </div>
            <div class="glass p-3 px-6 rounded-2xl border border-white/5 text-center min-w-[120px]">
                <span class="text-[8px] text-slate-500 uppercase block mb-1">Relevancia</span>
                <span class="text-xs font-bold text-blue-400">${data.relevancia}%</span>
            </div>
        </div>
        <div class="glass p-3 px-6 rounded-2xl border border-white/5 text-center w-full mt-3">
            <span class="text-[8px] text-slate-500 uppercase block mb-1">Conceptos Clave</span>
            <div class="flex flex-wrap justify-center gap-2 mt-1">
                ${(data.palabras_clave || []).map(w => `<span class="px-3 py-1 bg-violet-500/10 rounded-full text-[10px] text-slate-200 border border-white/10 uppercase font-black">${w}</span>`).join('')}
            </div>
        </div>
        ${speakerHTML}
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

        // Scrub illegal characters that crash the Mermaid.js 'mindmap' parser
        code = code.replace(/-->/g, '');
        code = code.replace(/[\[\]]/g, '');
        code = code.replace(/\(/g, '').replace(/\)/g, ''); // Mermaid mindmaps hate un-escaped parenthesis

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

    elements.cancelBtn.onclick = () => {
        if (!confirm("¿Descartar grabación y borrar datos actuales de la pantalla?")) return;

        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
            mediaRecorder.stop();
        }
        audioChunks = [];
        elements.sessionName.value = "";
        elements.aiSummary.innerHTML = "";
        elements.aiTranscript.innerText = "Esperando grabación...";
        elements.status.innerText = "Descartado. Listo.";

        uiFinished();
        updateProgress(0, "Listo para nueva sesión");
        localStorage.removeItem('sr_draft_audio');

        // Hide toggles
        document.getElementById('mindmapToggle').classList.add('hidden');
        const infoCont = document.getElementById('infographicContainer');
        if (infoCont) infoCont.classList.add('hidden');
    };

    elements.downloadBtn.onclick = () => {
        exportNote('pdf');
    };

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
