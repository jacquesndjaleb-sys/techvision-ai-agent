const fs = require("node:fs");

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite";
const MAX_NEWS_PER_SOURCE = 10;
const REQUEST_TIMEOUT_MS = 20000;
const GEMINI_TIMEOUT_MS = 60000;
const FACEBOOK_API_VERSION = "v27.0";

const SOURCES = [
  "https://feeds.bbci.co.uk/news/technology/rss.xml",
  "https://www.theverge.com/rss/index.xml"
];

// Décode les principales entités HTML présentes dans les flux RSS.
function decodeEntities(value) {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

// Nettoie le HTML et les CDATA sans conserver les balises.
function cleanText(value = "") {
  return decodeEntities(
    String(value)
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
  ).trim();
}

// Extrait le contenu d'une balise XML, y compris lorsqu'elle contient une CDATA.
function extractTag(xml, tagName) {
  const escapedTag = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expression = new RegExp(
    `<${escapedTag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escapedTag}\\s*>`,
    "i"
  );
  const match = xml.match(expression);
  return match ? cleanText(match[1]) : "";
}

async function getNews(url) {
  try {
    console.log(`Lecture de la source : ${url}`);

    const response = await fetch(url, {
      headers: { "User-Agent": "TechVisionAIAgent/1.0" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });

    if (!response.ok) {
      throw new Error(`Erreur HTTP ${response.status}`);
    }

    const xml = await response.text();
    const items = [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)];

    const news = items.slice(0, MAX_NEWS_PER_SOURCE).map(({ 1: item }) => ({
      title: extractTag(item, "title"),
      link: extractTag(item, "link"),
      description: extractTag(item, "description") || extractTag(item, "content:encoded"),
      date: extractTag(item, "pubDate")
    })).filter(item => item.title && /^https?:\/\//i.test(item.link));

    console.log(`${news.length} actualités récupérées depuis cette source.`);
    return news;
  } catch (error) {
    console.error(`Source inaccessible (${url}) : ${error.message}`);
    return [];
  }
}

function isRetryable(error) {
  return [408, 429, 500, 502, 503, 504].includes(error.status) ||
    error.name === "TimeoutError" || error.name === "AbortError" ||
    error.name === "TypeError";
}

async function generatePublication(news) {
  const fallbackModel = process.env.GEMINI_FALLBACK_MODEL || "gemini-3.5-flash-lite";
  const models = [...new Set([MODEL, fallbackModel])];
  const attemptsPerModel = 2;
  let lastError;

  for (const model of models) {
    for (let attempt = 1; attempt <= attemptsPerModel; attempt++) {
      try {
        console.log(`Tentative Gemini ${attempt}/${attemptsPerModel} avec le modèle ${model}...`);

        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": API_KEY
            },
            body: JSON.stringify({
              contents: [{
                role: "user",
                parts: [{
                  text: `Tu es le rédacteur en chef d'une page Facebook spécialisée dans la technologie, l'informatique, l'intelligence artificielle et les innovations numériques.

ACTUALITÉS DISPONIBLES :
${JSON.stringify(news, null, 2)}

RÈGLES STRICTES DE FIABILITÉ :
1. Utilise exclusivement les faits explicitement présents dans les titres et descriptions des actualités fournies.
2. N'ajoute jamais de détails issus de ta mémoire, de suppositions ou d'une autre actualité.
3. N'invente aucun événement, date, chiffre, pourcentage, nom, citation, scandale, relation personnelle, accusation, décision politique ou lien de causalité.
4. Ne transforme jamais une hypothèse, une rumeur ou une accusation en fait établi.
5. Ne dis pas qu'une personne a démissionné, été réintégrée ou est impliquée dans une affaire si ces faits ne sont pas explicitement présents dans les données fournies.
6. Choisis une seule actualité et conserve son lien exact. Ne mélange jamais plusieurs articles.
7. Avant de répondre, vérifie que chaque phrase factuelle est justifiée par les données fournies. Supprime toute phrase qui ne l'est pas.
8. Si les informations sont insuffisantes, contradictoires ou invraisemblables, ne rédige pas d'article affirmatif. Retourne exactement : "PUBLICATION BLOQUÉE : informations insuffisantes ou à vérifier auprès de la source."

MISSION :
1. Choisis une actualité intéressante parmi les informations fournies.
2. Résume-la fidèlement, sans extrapolation.
3. Rédige en français naturel, clair et facile à comprendre.
4. Commence par un titre accrocheur mais fidèle aux faits.
5. Explique l'information de manière concise, avec un ton journalistique.
6. Termine par une question pertinente qui ne suppose aucun fait non confirmé.
7. Ajoute quelques hashtags adaptés.
8. Indique uniquement la source et le lien exacts de l'actualité choisie.

FORMAT :
Titre accrocheur

Publication courte et informative

Question aux lecteurs

Hashtags

Source : nom et lien

Retourne uniquement la publication finale, sans expliquer ton raisonnement.`
                }]
              }],
              generationConfig: {
                temperature: 0.7,
                maxOutputTokens: 1200
              }
            }),
            signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS)
          }
        );

        const responseText = await response.text();
        let data;
        try {
          data = JSON.parse(responseText);
        } catch {
          throw new Error(`Réponse Gemini illisible (HTTP ${response.status}).`);
        }

        if (!response.ok) {
          const error = new Error(data.error?.message || `Erreur HTTP ${response.status}`);
          error.status = response.status;
          throw error;
        }

        const publication = data.candidates?.[0]?.content?.parts
          ?.map(part => part.text || "")
          .join("\\n")
          .trim();

        if (!publication) {
          const reason = data.candidates?.[0]?.finishReason;
          throw new Error(`Gemini n'a retourné aucun texte${reason ? ` (raison : ${reason})` : ""}.`);
        }

        console.log(`Publication générée avec succès par ${model} !`);
        return publication;
      } catch (error) {
        lastError = error;
        console.error(`Échec avec ${model}, tentative ${attempt} : ${error.message}`);

        if (!isRetryable(error)) {
          throw error;
        }

        if (attempt < attemptsPerModel) {
          const delay = attempt * 5000;
          console.log(`Service Gemini temporairement indisponible. Nouvelle tentative dans ${delay / 1000} secondes...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        } else if (model !== models[models.length - 1]) {
          console.log(`Le modèle ${model} reste indisponible. Basculement vers le modèle de secours : ${fallbackModel}.`);
        }
      }
    }
  }

  throw new Error(`Tous les modèles Gemini sont temporairement indisponibles. Dernière erreur : ${lastError?.message || "inconnue"}`);
}

async function publishToFacebook(publication) {
  if (process.env.FACEBOOK_AUTO_PUBLISH !== "true") {
    console.log("Publication Facebook désactivée : le contenu reste enregistré en brouillon.");
    return null;
  }

  if (publication.startsWith("PUBLICATION BLOQUÉE :")) {
    console.log("Publication Facebook annulée : les informations doivent être vérifiées.");
    return null;
  }

  const pageId = process.env.FB_PAGE_ID;
  const pageAccessToken = process.env.FB_PAGE_ACCESS_TOKEN;

  if (!pageId || !pageAccessToken) {
    throw new Error("Configuration Facebook incomplète : ajoute FB_PAGE_ID et FB_PAGE_ACCESS_TOKEN dans les secrets GitHub.");
  }

  const body = new URLSearchParams({
    message: publication,
    access_token: pageAccessToken
  });

  const response = await fetch(
    `https://graph.facebook.com/${FACEBOOK_API_VERSION}/${encodeURIComponent(pageId)}/feed`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    }
  );

  const responseText = await response.text();
  let data;

  try {
    data = JSON.parse(responseText);
  } catch {
    throw new Error(`Réponse Facebook illisible (HTTP ${response.status}).`);
  }

  if (!response.ok || data.error) {
    throw new Error(data.error?.message || `Erreur Facebook HTTP ${response.status}.`);
  }

  if (!data.id) {
    throw new Error("Facebook n'a pas confirmé la création de la publication.");
  }

  console.log(`Publication envoyée sur Facebook. Identifiant : ${data.id}`);
  return data.id;
}

async function main() {
  console.log("======================================");
  console.log("TECHVISION AI AGENT");
  console.log("Démarrage du système...");
  console.log("======================================");

  if (!API_KEY) {
    throw new Error("La clé GEMINI_API_KEY est absente. Vérifie les variables d'environnement.");
  }

  console.log("\nÉtape 1 : Recherche des actualités...");
  const results = await Promise.all(SOURCES.map(getNews));
  const uniqueNews = new Map();

  for (const item of results.flat()) {
    if (!uniqueNews.has(item.link)) uniqueNews.set(item.link, item);
  }

  const news = [...uniqueNews.values()];
  if (news.length === 0) {
    throw new Error("Aucune actualité n'a pu être récupérée. Vérifie les flux RSS et la connexion réseau.");
  }

  console.log(`\nTotal : ${news.length} actualités récupérées.`);
  console.log("\nÉtape 2 : Analyse et rédaction par Gemini...");
  const publication = await generatePublication(news);

  console.log("\nÉtape 3 : Enregistrement de la publication...");
  fs.writeFileSync("publication.md", `${publication}\n`, "utf8");

  console.log("\nÉtape 4 : Publication Facebook...");
  await publishToFacebook(publication);

  console.log("\n======================================");
  console.log("PUBLICATION PRÉPARÉE");
  console.log("======================================\n");
  console.log(publication);
  console.log("\n======================================");
  console.log("SUCCÈS ! Publication enregistrée dans publication.md");
  console.log("======================================");
}

main().catch(error => {
  console.error("\n======================================");
  console.error("ÉCHEC DE TECHVISION AI AGENT");
  console.error("======================================");
  console.error(error.message);
  process.exitCode = 1;
});
