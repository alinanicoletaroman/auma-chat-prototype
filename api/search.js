const fs   = require("fs");
const path = require("path");

const HF_MODEL = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2";

async function embedQuery(text) {
  const res = await fetch(
    `https://api-inference.huggingface.co/pipeline/feature-extraction/${HF_MODEL}`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.HF_API_TOKEN}`,
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

// Cached between warm Lambda invocations
let docsById   = null;
let vectorData = null;

function loadIndex() {
  if (docsById && vectorData) return;

  const indexPath   = path.join(process.cwd(), "public", "auma-index.json");
  const vectorsPath = path.join(process.cwd(), "public", "auma-vectors.json");

  const docs = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
  docsById   = Object.fromEntries(docs.map(d => [d.id, d]));

  const raw  = JSON.parse(fs.readFileSync(vectorsPath, "utf-8"));
  vectorData = raw.map(r => ({ id: r.id, vector: new Float32Array(r.vector) }));
}

function cosineSimilarity(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

function checkBasicAuth(req, res) {
  const header = req.headers["authorization"] || "";
  if (!header.startsWith("Basic ")) {
    res.setHeader("WWW-Authenticate", 'Basic realm="AUMA Demo"');
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  const decoded  = Buffer.from(header.slice(6), "base64").toString("utf-8");
  const [user, pass] = decoded.split(":");
  if (user !== process.env.BASIC_AUTH_USER || pass !== process.env.BASIC_AUTH_PASS) {
    res.setHeader("WWW-Authenticate", 'Basic realm="AUMA Demo"');
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
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

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Use POST" });
    return;
  }

  if (!checkBasicAuth(req, res)) return;

  try {
    const { query, language, type, limit = 6 } = req.body || {};
    if (!query) { res.status(400).json({ error: "missing query" }); return; }

    loadIndex();

    const queryVec = await embedQuery(query);

    const queryLower  = query.toLowerCase();
    const queryTokens = queryLower.split(/\s+/).filter(t => t.length > 1);

    function wordMatch(field, token) {
      const re = new RegExp(`(?<![\\w])${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w])`, "i");
      return re.test(field);
    }

    // Detect document type intent for score boosting (not hard filtering)
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
        const textL    = (doc.text    || "").toLowerCase();

        for (const token of queryTokens) {
          if (BOOST_STOPWORDS.has(token)) continue;
          if (wordMatch(productL, token)) score += 0.30;
          if (wordMatch(titleL, token))   score += 0.20;
          if (wordMatch(textL, token))    score += 0.05;
        }

        for (const term of SPECIALTY_TERMS) {
          if (titleL.includes(term) && !queryLower.includes(term)) score -= 0.20;
        }

        // Soft boost — matching type floats to top without hard-excluding others
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

    res.status(200).json(docs);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
