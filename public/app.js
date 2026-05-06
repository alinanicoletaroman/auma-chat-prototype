/* ── State ─────────────────────────────────────────────── */
let conversationHistory = [];

/* ── Vector search via server ──────────────────────────── */
async function search(query, language, type, limit = 6) {
  const res  = await fetch("/api/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, language, type, limit }),
  });

  const text = await res.text();

  if (!res.ok) {
    let msg = "Search failed";
    try { msg = JSON.parse(text).error || msg; } catch {}
    throw new Error(`[${res.status}] ${msg}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Server returned non-JSON (HTTP ${res.status}): ${text.slice(0, 150)}`);
  }
}

/* ── DOM helpers ───────────────────────────────────────── */
function esc(v) {
  return String(v)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const SVG_PDF = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
  <polyline points="14 2 14 8 20 8"/>
  <line x1="16" y1="13" x2="8" y2="13"/>
  <line x1="16" y1="17" x2="8" y2="17"/>
  <polyline points="10 9 9 9 8 9"/>
</svg>`;

const SVG_DL = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
  <polyline points="7 10 12 15 17 10"/>
  <line x1="12" y1="15" x2="12" y2="3"/>
</svg>`;

function normalizeUrl(url) {
  if (!url) return url;
  if (url.startsWith("https://www.")) return url;
  if (url.startsWith("https://")) return "https://www." + url.slice(8);
  if (url.startsWith("http://www.")) return "https://" + url.slice(7);
  if (url.startsWith("http://")) return "https://www." + url.slice(7);
  if (url.startsWith("www.")) return "https://" + url;
  return "https://www." + url;
}

function buildDocCard(doc, index) {
  const url = normalizeUrl(doc.url);
  const fileSize = doc.fileSize
    ? `${Math.round(doc.fileSize / 1024)} KB`
    : "";
  return `
    <div class="doc-card">
      <div class="doc-card-icon">${SVG_PDF}</div>
      <div class="doc-card-body">
        <a class="doc-card-title" href="${esc(url)}" target="_blank" rel="noreferrer" title="${esc(url)}">[${index + 1}] ${esc(doc.title)}</a>
        <div class="doc-card-meta">
          <span class="badge">${esc(doc.language)}</span>
          <span class="badge badge--accent">${esc(doc.documentType)}</span>
          ${doc.product ? `<span>${esc(doc.product)}</span>` : ""}
          ${fileSize ? `<span>${fileSize}</span>` : ""}
        </div>
      </div>
      <a class="doc-card-dl" href="${esc(url)}" target="_blank" rel="noreferrer">
        ${SVG_DL} Öffnen
      </a>
    </div>`;
}

function buildResultsHtml(results) {
  if (!results.length) return "";
  return `<div class="doc-results">${results.map(buildDocCard).join("")}</div>`;
}

function scrollToBottom() {
  const m = document.getElementById("messages");
  m.scrollTop = m.scrollHeight;
}

function appendUserMessage(text) {
  const msg = document.createElement("div");
  msg.className = "message message--user";
  msg.innerHTML = `
    <div class="message-avatar">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
        <circle cx="12" cy="7" r="4"/>
      </svg>
    </div>
    <div class="message-bubble"><p>${esc(text)}</p></div>`;
  document.getElementById("messages").appendChild(msg);
  scrollToBottom();
}

function appendAssistantMessage(innerHtml, results) {
  const msg = document.createElement("div");
  msg.className = "message message--assistant";
  msg.innerHTML = `
    <div class="message-avatar">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="10"/>
        <path d="M12 8v4l3 3"/>
      </svg>
    </div>
    <div class="message-bubble">
      ${innerHtml}
      ${results?.length ? buildResultsHtml(results) : ""}
    </div>`;
  document.getElementById("messages").appendChild(msg);
  scrollToBottom();
  return msg;
}

function appendTypingIndicator() {
  const msg = document.createElement("div");
  msg.className = "message message--assistant";
  msg.id = "typing-msg";
  msg.innerHTML = `
    <div class="message-avatar">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="10"/>
        <path d="M12 8v4l3 3"/>
      </svg>
    </div>
    <div class="message-bubble">
      <div class="typing"><span></span><span></span><span></span></div>
    </div>`;
  document.getElementById("messages").appendChild(msg);
  scrollToBottom();
}

function removeTypingIndicator() {
  document.getElementById("typing-msg")?.remove();
}

/* ── Auto-resize textarea ──────────────────────────────── */
const textarea = document.getElementById("query");
textarea.addEventListener("input", () => {
  textarea.style.height = "auto";
  textarea.style.height = Math.min(textarea.scrollHeight, 120) + "px";
});

textarea.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    handleAsk();
  }
});

/* ── AI-assisted ask ───────────────────────────────────── */
async function handleAsk() {
  const query = textarea.value.trim();
  if (!query) return;

  const manualLang = document.getElementById("languageFilter").value;
  const type       = document.getElementById("typeFilter").value;

  appendUserMessage(query);
  textarea.value = "";
  textarea.style.height = "auto";
  appendTypingIndicator();

  let results;
  try {
    results = await search(query, manualLang, type, 12);
  } catch (err) {
    removeTypingIndicator();
    appendAssistantMessage(`<p class='msg-error'>Search error: ${esc(err.message)}</p>`, []);
    return;
  }

  if (!results.length) {
    removeTypingIndicator();
    appendAssistantMessage(
      "<p>Für Ihre Anfrage wurden keine passenden Dokumente gefunden. Bitte versuchen Sie andere Stichwörter.</p>",
      []
    );
    return;
  }

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question:   query,
        manualLang: manualLang,
        history:    conversationHistory.slice(-6),
        contexts:   results.map(doc => ({
          title:        doc.title,
          url:          doc.url,
          language:     doc.language,
          documentType: doc.documentType,
          product:      doc.product,
          text:         doc.text,
        }))
      })
    });

    removeTypingIndicator();

    if (!response.ok) throw new Error("HTTP " + response.status);

    const data         = await response.json();
    const answer       = data.answer || "Keine Antwort erhalten.";
    const isClarifying = data.clarifying === true;
    const detectedLang = data.detectedLang || manualLang || null;

    conversationHistory.push({ role: "user",      content: query  });
    conversationHistory.push({ role: "assistant",  content: answer });

    if (isClarifying) {
      appendAssistantMessage(`<p>${esc(answer)}</p>`, []);
      return;
    }

    let orderedResults = results;

    if (Array.isArray(data.ranking) && data.ranking.length) {
      const ranked = [];
      for (const n of data.ranking) {
        const doc = results[n - 1];
        if (doc) ranked.push(doc);
      }
      for (const doc of results) {
        if (!ranked.includes(doc)) ranked.push(doc);
      }
      orderedResults = ranked;
    }

    if (detectedLang) {
      const inLang  = orderedResults.filter(d => d.language === detectedLang);
      const outLang = orderedResults.filter(d => d.language !== detectedLang);
      orderedResults = [...inLang, ...outLang];
    }

    orderedResults = orderedResults.slice(0, 6);

    appendAssistantMessage(
      `<div class="ai-answer">${esc(answer)}</div>`,
      orderedResults
    );

  } catch (err) {
    removeTypingIndicator();
    appendAssistantMessage(
      `<p>Gefundene Dokumente (KI-Antwort nicht verfügbar – <code>/api/chat</code> konnte nicht erreicht werden).</p>
       <p class="msg-error">Fehler: ${esc(err.message)}</p>`,
      results.slice(0, 6)
    );
  }
}

/* ── Button bindings ───────────────────────────────────── */
document.getElementById("askBtn").addEventListener("click", handleAsk);
