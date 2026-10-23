// public/js/voices.js - Pemilih voice TTS (AIVene) + pratinjau suara asli (via /api/tts/*).
// Classic script (bukan ES module): memakai global showToast (ui.js) & apiFetch (api.js).

let GEMINI_VOICES_CACHE = [];   // diisi dari GET /api/tts/voices (kini voice AIVene)
let _previewAudio = null;        // elemen Audio aktif agar tidak tumpang tindih

/** Render daftar voice ke #voicePicker (radio nama="voiceName" + tombol ▶). */
async function renderVoicePicker() {
    const box = document.getElementById('voicePicker');
    if (!box) return;
    box.innerHTML = '<div class="text-[11px] text-slate-500 py-3 text-center sm:col-span-2">Memuat daftar suara…</div>';

    let voices = GEMINI_VOICES_CACHE;
    if (!voices || !voices.length) {
        try {
            const d = await apiFetch('/api/tts/voices');
            voices = (d && d.voices) || [];
            GEMINI_VOICES_CACHE = voices;
        } catch (e) {
            box.innerHTML = '<div class="text-[11px] text-rose-400 py-3 text-center sm:col-span-2">Gagal memuat daftar suara. Muat ulang halaman.</div>';
            return;
        }
    }

    const icon = (g) => g === 'female'
        ? '<i class="fa-solid fa-venus text-pink-400"></i>'
        : '<i class="fa-solid fa-mars text-sky-400"></i>';

    box.innerHTML = voices.map((v, idx) => `
        <label data-voice="${v.name}" class="voice-opt flex items-center gap-2 p-2 rounded-lg border border-slate-800 bg-slate-950 hover:border-slate-600 cursor-pointer transition">
            <input type="radio" name="voiceName" value="${v.name}" ${idx === 0 ? 'checked' : ''} class="w-4 h-4 shrink-0 accent-indigo-500">
            <div class="w-5 text-center shrink-0">${icon(v.gender)}</div>
            <div class="min-w-0 flex-1">
                <div class="text-xs font-semibold text-white truncate">${v.name}</div>
                <div class="text-[10px] text-slate-400 truncate">${v.trait}</div>
            </div>
            <button type="button" onclick="event.preventDefault();previewVoice('${v.name}', this)" class="px-2 py-1 rounded-md bg-slate-800 hover:bg-slate-700 border border-slate-700 text-[11px] text-slate-200 shrink-0" title="Dengar contoh">
                <i class="fa-solid fa-play text-brand-400"></i>
            </button>
        </label>`).join('');

    // Sorot opsi terpilih
    const paint = () => {
        box.querySelectorAll('label.voice-opt').forEach(l => {
            const r = l.querySelector('input');
            const on = r && r.checked;
            l.classList.toggle('border-brand-500', !!on);
            l.classList.toggle('bg-brand-500/10', !!on);
        });
    };
    box.addEventListener('change', paint);
    paint();
}

/** Ambil voice terpilih: { name, gender }. Default voice pertama di daftar bila belum ada. */
function getSelectedVoice() {
    const el = document.querySelector('input[name="voiceName"]:checked');
    const fallback = (GEMINI_VOICES_CACHE && GEMINI_VOICES_CACHE[0] && GEMINI_VOICES_CACHE[0].name) || 'alloy';
    const name = el ? el.value : fallback;
    const v = (GEMINI_VOICES_CACHE || []).find(x => x.name === name);
    return { name, gender: v ? v.gender : 'unknown' };
}

/**
 * Putar pratinjau suara Gemini TTS asli.
 * @param {string} name  nama voice
 * @param {HTMLElement|null} btn  tombol pemicu (untuk state loading), boleh null
 * @param {string} [text]  teks opsional (default cuplikan); utk "Dengar" adegan
 * @param {string} [emotion]  label emosi adegan (opsional) untuk mengarahkan gaya bicara
 */
async function previewVoice(name, btn, text, emotion) {
    if (btn) btn.disabled = true;
    try {
        const res = await fetch('/api/tts/preview', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ voiceName: name, text: text || undefined, emotion: emotion || undefined }),
        });
        const ct = res.headers.get('Content-Type') || '';
        if (!res.ok || ct.indexOf('audio') === -1) {
            let msg = 'Pratinjau suara gagal';
            try { const d = await res.json(); msg = d.message || msg; } catch (e) { /* non-json */ }
            showToast(msg, 'error');
            return;
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        if (_previewAudio) { try { _previewAudio.pause(); } catch (e) { /* ignore */ } }
        _previewAudio = new Audio(url);
        _previewAudio.onended = () => URL.revokeObjectURL(url);
        await _previewAudio.play();
        showToast('Memutar contoh suara ' + name + '…', 'success');
    } catch (e) {
        showToast('Pratinjau error: ' + (e.message || e), 'error');
    } finally {
        if (btn) btn.disabled = false;
    }
}
