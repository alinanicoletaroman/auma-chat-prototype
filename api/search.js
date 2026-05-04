const fs   = require("fs");
const path = require("path");

// @xenova/transformers is ESM-only — must use dynamic import() in a CJS module
let _embedPipe = null;

async function embedQuery(text) {
  if (!_embedPipe) {
    const { pipeline, env } = await import("@xenova/transformers");
    env.cacheDir          = path.join(process.cwd(), "model-cache");
    env.allowRemoteModels = false;
    _embedPipe = await pipeline(
      "feature-extraction",
      "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
      { quantized: true }
    );
  }
  const out = await _embedPipe(text, { pooling: "mean", normalize: true });
  return new Float32Array(out.data);
}

let docsById   = null;
let vectorData = null;

function loadIndex() {
  if (docsById && vectorData) return;

  const cwd         = process.cwd();
  const indexPath   = path.join(cwd, "public", "auma-index.json");
  const vectorsPath = path.join(cwd, "public", "auma-vectors.json");

  try {
    const docs = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
    docsById   = Object.fromEntries(docs.map(d => [d.id, d]));

    const raw  = JSON.parse(fs.readFileSync(vectorsPath, "utf-8"));
    vectorData = raw.map(r => ({ id: r.id, vector: new Float32Array(r.vector) }));
  } catch (e) {
    throw new Error(`Index load failed (cwd=${cwd}): ${e.message}`);
  }
}

function cosineSimilarity(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
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

        if (detectedType && doc.documentType === detectedType) score += 0.40;
      }

      return { id: item.id, score };
    }).sort((a, b) => b.score - a.score);

    const TYPE_ALIASES = {
      "Technische Daten":       ["Technical data","Données techniques","Datos técnicos","Dati tecnici","Technische gegevens","Dane techniczne"],
      "Elektrische Daten":      ["Electrical data","Données électriques","Datos eléctricos","Dati elettrici"],
      "Betriebsanleitung":      ["Operating manual","Manuel d'utilisation","Manual de funcionamiento","Manuale operativo","Bedieningshandleiding","Instrukcja obsługi"],
      "Montageanleitung":       ["Installation manual","Mounting instructions","Manuel de montage","Manual de instalación","Installatie handleiding","Instrukcja montażu"],
      "Schaltplan":             ["Wiring diagram","Schéma de câblage","Diagrama de cableado","Schema elettrico"],
      "Produktzertifikat":      ["Product certificate","Certificate","Certificat","Certificado","Certificato"],
      "Zertifikate":            ["Certificates","Certificats","Certificados","Certificati"],
      "Ersatzteilliste":        ["Spare parts list","Liste de pièces de rechange","Lista de repuestos"],
      "Kurzanleitung":          ["Quick guide","Short instructions","Guide rapide","Guía rápida"],
      "Maßblatt":               ["Dimension sheet","Dimensional drawing","Plan coté","Plano dimensional"],
      "Handbuch":               ["Manual","Handbook","Manuel","Manual","Manuale","Handboek"],
      "Prospekt":               ["Brochure","Folleto","Brochure"],
      "Ausschreibungstext":     ["Tender text","Specification text","Texte d'appel d'offres"],
      "Technische Beschreibung":["Technical description","Description technique","Descripción técnica"],
      "Anfahrtskizze":          ["Route map","Direction map"],
      "Bestellformular":        ["Order form","Bon de commande"],
      "Informationsbrief":      ["Information letter","Lettre d'information"],
      "Merkblatt":              ["Information sheet","Fact sheet","Fiche d'information"],
      "Montagepositionen":      ["Mounting positions","Positions de montage"],
    };

    if (language) results = results.filter(r => docsById[r.id]?.language === language);
    if (type) {
      const aliases = new Set([type, ...(TYPE_ALIASES[type] || [])]);
      results = results.filter(r => aliases.has(docsById[r.id]?.documentType));
    }

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
