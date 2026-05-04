const path = require("path");
const { pipeline, env } = require("@xenova/transformers");

env.cacheDir = path.join(__dirname, "..", "model-cache");
env.allowRemoteModels = true;

console.log("Downloading embedding model to model-cache/ ...");

pipeline(
  "feature-extraction",
  "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
  { quantized: true }
)
  .then(() => {
    console.log("Model downloaded successfully.");
    process.exit(0);
  })
  .catch(err => {
    console.error("Model download failed:", err.message);
    process.exit(1);
  });
