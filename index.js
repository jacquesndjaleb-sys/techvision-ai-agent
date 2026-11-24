const fs = require("fs");

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";

const SOURCES = [
"https://feeds.bbci.co.uk/news/technology/rss.xml",
"https://www.theverge.com/rss/index.xml"
];

// Fonction pour nettoyer le texte récupéré dans les flux RSS
function cleanText(text) {
return text
.replace(/<![CDATA[([\s\S]?)]]>/g, "$1")
.replace(/<[^>]>/g, "")
.replace(/&/g, "&")
.replace(/"/g, '"')
.replace(/'/g, "'")
.replace(/</g, "<")
.replace(/>/g, ">")
.trim();
}

// Récupération des actualités
async function getNews(url) {
try {
console.log("Lecture de la source : ${url}");

const response = await fetch(url, {
  headers: {
    "User-Agent": "TechVisionAIAgent/1.0"
  },
  signal: AbortSignal.timeout(20000)
});

if (!response.ok) {
  throw new Error(`Erreur HTTP ${response.status}`);
}

const xml = await response.text();

const items = [
  ...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)
];

const news = items.slice(0, 10).map(match => {
  const item = match[1];

  const extract = tag => {
    const result = item.match(
      new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i")
    );

    return result ? cleanText(result[1]) : "";
  };

  return {
    title: extract("title"),
    link: extract("link"),
    description: extract("description"),
    date: extract("pubDate")
  };
}).filter(item => item.title && item.link);

console.log(`${news.length} actualités récupérées depuis cette source.`);

return news;

} catch (error) {
console.error("Source inaccessible :", url);
console.error("Détail :", error.message);

return [];

}
}

// Génération de la publication avec Gemini
async function generatePublication(news) {
const maxAttempts = 3;

for (let attempt = 1; attempt <= maxAttempts; attempt++) {
try {
console.log("Tentative Gemini ${attempt}/${maxAttempts}...");

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": API_KEY
      },

      body: JSON.stringify({
        contents: [{
          parts: [{
            text: `

Tu es le rédacteur en chef d'une page Facebook spécialisée dans la technologie, l'informatique, l'intelligence artificielle et les innovations numériques.

Voici les actualités disponibles :
${JSON.stringify(news, null, 2)}

MISSION :

1. Analyse les actualités disponibles.
2. Choisis le sujet le plus intéressant, pertinent et récent.
3. Évite les sujets trop banals.
4. Utilise uniquement les informations fournies.
5. Ne fabrique aucune information.
6. Rédige en français naturel et facile à comprendre.
7. Commence par un titre accrocheur.
8. Explique l'information de manière claire et concise.
9. Utilise un ton journalistique, moderne et naturel.
10. Ajoute une question intéressante pour encourager les commentaires.
11. Ajoute quelques hashtags pertinents.
12. Mentionne la source et son lien.

FORMAT DE LA PUBLICATION :

Un titre accrocheur.

Un texte court, intéressant et informatif.

Une question destinée aux lecteurs.

Les hashtags.

La source avec son lien.

IMPORTANT :
Retourne uniquement la publication finale.
Ne présente pas tes explications sur la manière dont tu as choisi le sujet.
N'utilise pas un ton artificiel.
`
}]
}]
}),

      signal: AbortSignal.timeout(60000)
    }
  );

  const data = await response.json();

  if (!response.ok) {
    const error = new Error(
      data.error?.message || `Erreur HTTP ${response.status}`
    );

    error.status = response.status;
    throw error;
  }

  const publication = data.candidates?.[0]?.content?.parts
    ?.map(part => part.text || "")
    .join("\n")
    || "";

  if (!publication.trim()) {
    throw new Error("Gemini n'a généré aucune publication.");
  }

  console.log("Publication générée avec succès !");

  return publication.trim();

} catch (error) {
  console.error(`Échec de la tentative ${attempt} : ${error.message}`);

  const retryable =
    error.status === 429 ||
    error.status === 503 ||
    (error.status >= 500 && error.status <= 599) ||
    error.name === "TimeoutError" ||
    error.name === "AbortError";

  if (!retryable || attempt === maxAttempts) {
    throw error;
  }

  const delay = attempt * 5000;

  console.log(
    `Gemini indisponible. Nouvelle tentative dans ${delay / 1000} secondes...`
  );

  await new Promise(resolve => setTimeout(resolve, delay));
}

}

throw new Error("Toutes les tentatives Gemini ont échoué.");
}

// Programme principal
async function main() {
console.log("======================================");
console.log("TECHVISION AI AGENT");
console.log("Démarrage du système...");
console.log("======================================");

if (!API_KEY) {
throw new Error("La clé GEMINI_API_KEY est absente.");
}

// Récupération des actualités
console.log("\nÉtape 1 : Recherche des actualités...");

const results = await Promise.all(
SOURCES.map(getNews)
);

const news = results.flat();

if (news.length === 0) {
throw new Error("Aucune actualité n'a pu être récupérée.");
}

console.log("\nTotal : ${news.length} actualités récupérées.");

// Génération par l'intelligence artificielle
console.log("\nÉtape 2 : Analyse et rédaction par Gemini...");

const publication = await generatePublication(news);

if (!publication) {
throw new Error("La publication générée est vide.");
}

// Enregistrement du résultat
console.log("\nÉtape 3 : Enregistrement de la publication...");

fs.writeFileSync(
"publication.md",
publication + "\n",
"utf8"
);

// Affichage final
console.log("\n======================================");
console.log("PUBLICATION PRÉPARÉE");
console.log("======================================\n");

console.log(publication);

console.log("\n======================================");
console.log("SUCCÈS !");
console.log("Publication enregistrée dans publication.md");
console.log("======================================");
}

// Lancement du programme
main().catch(error => {
console.error("\n======================================");
console.error("ÉCHEC DE TECHVISION AI AGENT");
console.error("======================================");
console.error(error.message);

process.exitCode = 1;
});
