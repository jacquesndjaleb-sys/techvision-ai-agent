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

RÈGLES DE FIABILITÉ ET DE VÉRIFICATION :
1. Utilise exclusivement les faits explicitement présents dans le titre et la description de l'article choisi. Les autres articles ne servent pas à compléter celui-ci.
2. N'utilise aucune connaissance extérieure, aucun souvenir, aucune supposition et aucune déduction présentée comme un fait.
3. N'invente jamais de date, chiffre, statistique, citation, nom, fonction, événement, conséquence, cause, accusation ou réaction.
4. Respecte le degré de certitude de la source : une possibilité reste une possibilité, une annonce reste une annonce et une accusation ne devient jamais un fait établi.
5. Si le titre et la description se contredisent, si le sujet est confus ou si les informations sont trop minces pour rédiger sans extrapoler, retourne exactement : "PUBLICATION BLOQUÉE : informations insuffisantes ou à vérifier auprès de la source."
6. Choisis un seul article. Ne fusionne pas plusieurs actualités, même si elles concernent la même entreprise ou personne.
7. La source finale doit correspondre exactement à l'article choisi. Reprends son URL sans la modifier.
8. N'affirme pas avoir vérifié l'article complet : tu disposes uniquement des champs RSS fournis.
9. Avant de finaliser, contrôle chaque phrase factuelle. Si elle n'est pas directement soutenue par le titre ou la description de l'article choisi, supprime-la ou bloque la publication.

RÈGLES DE QUALITÉ ÉDITORIALE :
1. Adopte un ton journalistique neutre, précis, professionnel et accessible au grand public.
2. Le titre doit résumer l'information centrale sans exagération, dramatisation, promesse trompeuse ni formule de type "incroyable", "choc", "révolution" ou "scandale", sauf si ce terme est explicitement justifié par la source.
3. Ne transforme pas un simple lancement, une mise à jour ou une déclaration en "révolution" ou en changement majeur.
4. Commence par l'information essentielle : qui ou quoi est concerné, et ce qui est annoncé ou constaté, uniquement si ces éléments figurent dans la source.
5. Explique pourquoi l'information est pertinente seulement lorsque la source permet de le dire. N'invente pas d'impact sur les utilisateurs, les entreprises ou le marché.
6. Évite les répétitions entre le titre et le corps du texte. Chaque paragraphe doit apporter une information distincte.
7. Privilégie des phrases courtes et naturelles. Évite le remplissage, les généralités et les formulations artificiellement enthousiastes.
8. Ne donne pas de conseil technique, financier ou de sécurité qui ne figure pas dans la source.
9. Termine par une question simple et pertinente, sans orienter la réponse ni présupposer une conséquence.
10. Utilise au maximum 3 à 5 hashtags précis. N'ajoute pas de hashtags sensationnalistes ou sans rapport.

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
                temperature: 0.35,
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
