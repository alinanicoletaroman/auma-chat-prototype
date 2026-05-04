const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT         = 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const HF_API_TOKEN = process.env.HF_API_TOKEN;

const HF_MODEL = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2";

async function embedQuery(text) {
  if (!HF_API_TOKEN) throw new Error("Missing HF_API_TOKEN. Set it in PowerShell first.");

  const res = await fetch(
    `https://api-inference.huggingface.co/pipeline/feature-extraction/${HF_MODEL}`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${HF_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ inputs: text, options: { wait_for_model: true } }),
    }
  );

  if (!res.ok) {
    const e = await res.json();
    throw new Error(e.error || "HuggingFace embedding error");
  }

  let data = await res.json();
  // HF returns [[...384 floats...]] for a single string — unwrap outer array
  if (Array.isArray(data[0])) data = data[0];

  // Normalize to match stored vectors (built with normalize: true)
  const norm = Math.sqrt(data.reduce((s, v) => s + v * v, 0));
  return new Float32Array(data.map(v => v / norm));
}

const INDEX_PATH   = path.join(__dirname, "public", "auma-index.json");
const VECTORS_PATH = path.join(__dirname, "public", "auma-vectors.json");

let docsById   = {};
let vectorData = [];

function loadVectorIndex() {
  try {
    const docs = JSON.parse(fs.readFileSync(INDEX_PATH, "utf-8"));
    docsById = Object.fromEntries(docs.map(d => [d.id, d]));

    const raw = JSON.parse(fs.readFileSync(VECTORS_PATH, "utf-8"));
    vectorData = raw.map(r => ({ id: r.id, vector: new Float32Array(r.vector) }));

    console.log(`Vector index loaded: ${vectorData.length} documents`);
  } catch (e) {
    console.warn("Vector index not found – run 'node build-embeddings.js' first.", e.message);
  }
}

function cosineSimilarity(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

async function handleSearch(req, res) {
  let body = "";
  req.on("data", chunk => { body += chunk; });
  req.on("end", async () => {
    try {
      const { query, language, type, limit = 6 } = JSON.parse(body || "{}");
      if (!query) { res.writeHead(400); res.end("missing query"); return; }

      if (!vectorData.length) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Vector index not ready. Run: node build-embeddings.js" }));
        return;
      }

      const queryVec = await embedQuery(query);

      const queryLower = query.toLowerCase();
      const queryTokens = queryLower.split(/\s+/).filter(t => t.length > 1);

      function wordMatch(field, token) {
        const re = new RegExp(`(?<![\\w])${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w])`, "i");
        return re.test(field);
      }

      const BOOST_STOPWORDS = new Set([
        "für","for","und","and","oder","or","mit","with","von","from","zur","zum","zu",
        "der","die","das","den","dem","des","ein","eine","einen","einem","einer",
        "the","an","in","of","to","a","is","are","at","on","by","as","per",
        "le","la","les","un","une","des","pour","et","ou","de",
        "ich","sie","wir","ihr","sein","haben","werden","ist","sind","was",
      ]);

      const SPECIALTY_TERMS = [
        "unterwasser", "-uw", " uw ", "stahlwasserbau", "sauerstoff", "oxygen",
        "atex", "ex-schutz", "schlagwetter", "bergbau", "offshore", "subsea",
        "kernkraftwerk", "kernkraft", "nuclear", "radioaktiv",
        "schraubernotbetrieb", "notbetrieb",
      ];

      const DOC_TYPE_INTENTS = [
        { keywords: ["elektrische daten", "elektrischen daten", "elektrische kennwerte", "electrical data"], type: "Elektrische Daten" },
        { keywords: ["technische daten", "technischen daten", "technical data", "données techniques", "datasheet"], type: "Technische Daten" },
        { keywords: ["betriebsanleitung", "operating manual", "manuel", "handbuch"], type: "Betriebsanleitung" },
        { keywords: ["montageanleitung", "installation", "montage"], type: "Montageanleitung" },
        { keywords: ["zertifikat", "zertifikate", "certificate", "certificates", "certificat"], type: "Produktzertifikat" },
        { keywords: ["schaltplan", "schaltbild", "verdrahtung", "wiring diagram", "wiring plan"], type: "Schaltplan" },
        { keywords: ["ersatzteilliste", "ersatzteile", "spare parts", "pièces"], type: "Ersatzteilliste" },
        { keywords: ["kurzanleitung", "quick guide", "quick start"], type: "Kurzanleitung" },
        { keywords: ["maßblatt", "maßbild", "dimension", "dimensional"], type: "Maßblatt" },
      ];

      // Detect document type from query keywords (used as score boost, not hard filter)
      let detectedType = type;
      if (!detectedType) {
        for (const intent of DOC_TYPE_INTENTS) {
          if (intent.keywords.some(kw => queryLower.includes(kw))) {
            detectedType = intent.type;
            break;
          }
        }
      }

      let results = vectorData.map(item => {
        const doc = docsById[item.id];
        let score = cosineSimilarity(queryVec, item.vector);

        if (doc) {
          const titleL   = (doc.title   || "").toLowerCase();
          const productL = (doc.product || "").toLowerCase();

          const textL = (doc.text || "").toLowerCase();
          for (const token of queryTokens) {
            if (BOOST_STOPWORDS.has(token)) continue;
            if (wordMatch(productL, token)) score += 0.30;
            if (wordMatch(titleL, token))   score += 0.20;
            if (wordMatch(textL, token))    score += 0.05;
          }

          for (const term of SPECIALTY_TERMS) {
            const docHasTerm   = titleL.includes(term);
            const queryHasTerm = queryLower.includes(term);
            if (docHasTerm && !queryHasTerm) score -= 0.20;
          }

          // Boost documents whose type matches the detected intent — soft signal, not a hard filter
          if (detectedType && doc.documentType === detectedType) score += 0.40;
        }
        return { id: item.id, score };
      }).sort((a, b) => b.score - a.score);

      // Language is an explicit user selection — keep as hard filter
      if (language) results = results.filter(r => docsById[r.id]?.language === language);

      const docs = results
        .slice(0, limit)
        .map(r => docsById[r.id])
        .filter(Boolean);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(docs));
    } catch (err) {
      console.error(err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
}

const mimeTypes = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json"
};

async function handleChat(req, res) {
  let body = "";

  req.on("data", chunk => {
    body += chunk;
  });

  req.on("end", async () => {
    try {
      if (!GROQ_API_KEY) {
        throw new Error("Missing GROQ_API_KEY. Set it in PowerShell first.");
      }

      const { question = "", contexts = [], history = [] } = JSON.parse(body || "{}");

      const sourceText = contexts
        .map((c, i) =>
          `[${i + 1}] ${c.title}\nTyp: ${c.documentType || "–"}  |  Sprache: ${c.language || "–"}  |  Produkt: ${c.product || "–"}\n${c.text}\nURL: ${c.url}`
        )
        .join("\n\n---\n\n");

      const systemPrompt = `You are a multilingual AUMA document assistant. AUMA manufactures electric actuators and gearboxes for industrial valves.

LANGUAGE RULE (mandatory):
- Detect the language of the user's latest message.
- If the message is in English → reply in English.
- If in German → reply in German.
- If in French → reply in French. Apply the same rule for any other language.
- Mixed languages (e.g. mostly English with one German word): use the dominant language.
- Never switch language mid-conversation unless the user does first.

CLARIFICATION RULE:
- ONLY ask a clarifying question when BOTH conditions are true:
  (a) the user mentions a product/model name, AND
  (b) there is NO indication of document type anywhere in the message or conversation history (no words like certificate, zertifikat, manual, betriebsanleitung, technical data, technische daten, wiring, schaltplan, installation, datasheet, spare parts, quick guide, etc.)
- If the user already named the document type (even loosely, e.g. "product certificates", "operating manual", "wiring diagram"), do NOT ask for clarification – go straight to answering.
- When in doubt, attempt to answer rather than ask.
- In that case: write your question as plain text, and on the last line write exactly: CLARIFYING: true
- Do NOT show RANKED when asking a clarifying question.

ANSWER RULES (when sources are provided and intent is clear):
1. Recommend the most relevant document(s) from the provided sources.
2. Explain briefly (1-2 sentences) why each recommended document matches.
3. Cite source numbers like [1], [2].
4. If none match well, say so honestly.
5. Be concise – max 4-6 sentences total.
6. Never invent content or URLs not in the sources.
7. At the very end, on a new line, output ONLY:
RANKED: [most_relevant_number, second, third, ...]
Example: RANKED: [3,1,5,2,4,6]`;

      const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${GROQ_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          temperature: 0.15,
          max_tokens: 512,
          messages: [
            { role: "system", content: systemPrompt },
            ...history.map(h => ({ role: h.role, content: h.content })),
            { role: "user",   content: `Question: ${question}\n\nAvailable sources:\n${sourceText}` }
          ]
        })
      });

      const data = await response.json();

      console.log("Groq response:");
      console.log(JSON.stringify(data, null, 2));

      if (!response.ok) {
        throw new Error(data.error?.message || "Groq API error");
      }

      const raw =
        data.choices?.[0]?.message?.content ||
        data.choices?.[0]?.text ||
        "No answer returned.";

      const clarifying = /CLARIFYING:\s*true/i.test(raw);
      const rankedMatch = raw.match(/RANKED:\s*(\[[\d,\s]+\])/);
      const ranking = rankedMatch ? JSON.parse(rankedMatch[1]) : null;
      const answer = raw
        .replace(/\nRANKED:\s*\[[\d,\s]+\]\s*$/m, "")
        .replace(/\nCLARIFYING:\s*true\s*$/im, "")
        .trim();

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ answer, ranking, clarifying }));
    } catch (error) {
      console.error(error);

      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message }));
    }
  });
}

function serveFile(req, res) {
  let filePath = req.url === "/" ? "/index.html" : req.url;
  filePath = path.join(__dirname, filePath);

  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const ext = path.extname(filePath);

  res.writeHead(200, {
    "Content-Type": mimeTypes[ext] || "text/plain",
    "Cache-Control": "no-store"
  });

  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer((req, res) => {
  if (req.url === "/api/chat" && req.method === "POST") {
    handleChat(req, res);
  } else if (req.url === "/api/search" && req.method === "POST") {
    handleSearch(req, res);
  } else {
    serveFile(req, res);
  }
});

loadVectorIndex();

server.listen(PORT, () => {
  console.log(`Local app running at http://127.0.0.1:${PORT}`);
});