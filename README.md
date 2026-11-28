# TechVision AI Agent

Agent automatisé en **Node.js** qui lit l'actualité technologique sur **plusieurs sites**, demande à **Google Gemini** de choisir un article et de rédiger une publication en français, puis la publie **avec l'image de l'article** sur la page Facebook TechVision.

Tout tourne gratuitement sur **GitHub Actions**, deux fois par jour, sans serveur à gérer.

---

## Nouveautés de la version 2

- **11 sources** au lieu de 2 (anglophones, francophones et africaine)
- **Images** : chaque publication part avec la photo de l'article
- **Anti-doublons** : l'agent se souvient des articles déjà traités
- **Variété** : les sources sont alternées et Gemini évite de reprendre la même source plusieurs fois de suite
- Lecture des flux **RSS et Atom**
- Lien et nom de la source **toujours exacts** (ajoutés par le programme, pas par l'IA)
- Réponse de Gemini en **JSON structuré** et validée

---

## Sommaire

1. [Fonctionnement](#fonctionnement)
2. [Sources d'information](#sources-dinformation)
3. [Gestion des images](#gestion-des-images)
4. [Structure du projet](#structure-du-projet)
5. [Configuration](#configuration)
6. [Utilisation locale](#utilisation-locale)
7. [Automatisation avec GitHub Actions](#automatisation-avec-github-actions)
8. [Règles éditoriales de l'IA](#règles-éditoriales-de-lia)
9. [Gestion des erreurs](#gestion-des-erreurs)
10. [Sécurité](#sécurité)
11. [Dépannage](#dépannage)
12. [Personnalisation](#personnalisation)

---

## Fonctionnement

| Étape | Action |
|-------|--------|
| 1 | Lecture des flux de toutes les sources, en parallèle |
| 2 | Filtrage : articles trop anciens (plus de 72 h), déjà publiés ou en double |
| 3 | Gemini choisit **un seul** article et rédige la publication |
| 4 | Recherche de l'image de l'article |
| 5 | Enregistrement dans `publication.md` |
| 6 | Publication sur Facebook, **uniquement si** `FACEBOOK_AUTO_PUBLISH=true` |
| 7 | Mise à jour de `data/history.json` |

```
Flux RSS/Atom ──► Filtrage ──► Gemini ──► Image ──► Facebook (photo + texte)
                     ▲                                   │
                     └────────── data/history.json ◄─────┘
```

### Mode brouillon (par défaut)

Si `FACEBOOK_AUTO_PUBLISH` n'est pas égal à `true`, **rien n'est publié** : le texte et l'image restent dans `publication.md` et `publication-image.*` (artefact GitHub Actions). Idéal pour relire avant d'automatiser.

### Publication bloquée

Si les informations d'un article sont trop minces ou contradictoires, Gemini peut refuser de rédiger. L'agent écrit alors `PUBLICATION BLOQUÉE` dans `publication.md` et **n'envoie rien** sur Facebook.

### Format d'une publication

```
Titre accrocheur mais fidèle

Corps de la publication (2 à 4 phrases)

Question aux lecteurs

#Hashtag1 #Hashtag2 #Hashtag3

Source : Nom du site — https://lien-de-l-article
```

---

## Sources d'information

| Source | Langue |
|--------|--------|
| BBC Technology | Anglais |
| The Verge | Anglais |
| TechCrunch | Anglais |
| Ars Technica | Anglais |
| Wired | Anglais |
| Engadget | Anglais |
| MIT Technology Review | Anglais |
| Numerama | Français |
| Korben | Français |
| Frandroid | Français |
| TechCabal | Anglais (Afrique) |

Si un site est inaccessible ou change son flux, l'agent l'ignore et continue avec les autres. Il ne s'arrête que si **aucune** source ne répond.

Les articles en anglais sont traduits et résumés en français par Gemini.

---

## Gestion des images

Pour chaque article choisi, l'agent cherche l'image dans cet ordre :

1. l'image principale de la **page de l'article** (`og:image`, généralement en haute résolution) ;
2. l'image fournie par le **flux RSS** (`media:content`, miniature, pièce jointe ou balise `img`).

L'image est téléchargée puis envoyée directement à Facebook (route `/photos`), ce qui évite les blocages anti-hotlink.

**Conditions d'acceptation :** format JPEG, PNG ou GIF, entre 5 Ko et 8 Mo.

**Si aucune image n'est exploitable**, la publication est envoyée sur `/feed` avec le lien de l'article : Facebook affiche alors son propre aperçu du lien.

---

## Structure du projet

```
techvision-ai-agent/
├── .github/
│   └── workflows/
│       └── agent.yml       # Planification et exécution automatique
├── data/
│   └── history.json        # Articles déjà traités (mis à jour automatiquement)
├── index.js                # Code principal de l'agent
├── package.json
├── .gitignore
└── README.md
```

Le projet n'a **aucune dépendance npm** : il utilise uniquement les fonctions intégrées de Node.js 22 (`fetch`, `FormData`, `node:fs`).

---

## Configuration

L'agent se configure par **variables d'environnement**.

| Variable | Obligatoire | Description | Valeur par défaut |
|----------|:-----------:|-------------|-------------------|
| `GEMINI_API_KEY` | Oui | Clé API Google Gemini | — |
| `GEMINI_MODEL` | Non | Modèle principal | `gemini-3.1-flash-lite` |
| `GEMINI_FALLBACK_MODEL` | Non | Modèle de secours | `gemini-3.5-flash-lite` |
| `MAX_ARTICLE_AGE_HOURS` | Non | Âge maximal d'un article, en heures | `72` |
| `FACEBOOK_AUTO_PUBLISH` | Non | `true` pour publier réellement | désactivé |
| `FB_PAGE_ID` | Si publication | Identifiant de la page Facebook | — |
| `FB_PAGE_ACCESS_TOKEN` | Si publication | Jeton d'accès de la page | — |

### Constantes dans `index.js`

| Constante | Valeur | Rôle |
|-----------|--------|------|
| `MAX_NEWS_PER_SOURCE` | 6 | Articles retenus par source |
| `MAX_NEWS_TOTAL` | 60 | Articles envoyés à Gemini |
| `MAX_DESCRIPTION_CHARS` | 350 | Longueur de la description transmise |
| `MIN_IMAGE_BYTES` / `MAX_IMAGE_BYTES` | 5 Ko / 8 Mo | Taille d'image acceptée |
| `HISTORY_LIMIT` | 200 | Nombre d'articles gardés dans l'historique |
| `FACEBOOK_API_VERSION` | `v27.0` | Version de l'API Graph |

---

## Utilisation locale

```bash
git clone https://github.com/jacquesndjaleb-sys/techvision-ai-agent.git
cd techvision-ai-agent
```

**Brouillon (Linux, macOS, Termux) :**

```bash
export GEMINI_API_KEY="votre_cle_gemini"
node index.js
```

**Brouillon (Windows PowerShell) :**

```powershell
$env:GEMINI_API_KEY="votre_cle_gemini"
node index.js
```

**Publication réelle :**

```bash
export GEMINI_API_KEY="votre_cle_gemini"
export FACEBOOK_AUTO_PUBLISH="true"
export FB_PAGE_ID="votre_id_de_page"
export FB_PAGE_ACCESS_TOKEN="votre_jeton_de_page"
node index.js
```

> Testez plusieurs fois en mode brouillon avant d'activer la publication.

---

## Automatisation avec GitHub Actions

Le workflow `.github/workflows/agent.yml` s'exécute :

- **deux fois par jour**, à `08:00 UTC` et `16:00 UTC`, soit **09h00 et 17h00 à Kinshasa** (UTC+1) ;
- **manuellement** depuis l'onglet *Actions* → *Run workflow*.

### Secrets à ajouter

**Settings → Secrets and variables → Actions → New repository secret**

| Secret | Contenu |
|--------|---------|
| `GEMINI_API_KEY` | Clé API Gemini |
| `FACEBOOK_AUTO_PUBLISH` | `true` pour publier, sinon brouillon |
| `FB_PAGE_ID` | Identifiant de la page |
| `FB_PAGE_ACCESS_TOKEN` | Jeton d'accès de la page |

### Historique automatique

Après chaque exécution réussie, le workflow enregistre `data/history.json` dans le dépôt (commit automatique). C'est ce qui évite de republier le même article. Le workflow a donc besoin de la permission `contents: write`, déjà déclarée dans le fichier.

> Si votre dépôt impose une protection de branche stricte, autorisez les commits du robot GitHub Actions, ou l'historique ne pourra pas être sauvegardé.

### Résultats de chaque exécution

- Le **résumé de l'exécution** (onglet *Actions*) affiche le statut, l'image retenue et le texte final.
- L'artefact `publication-techvision` (conservé 7 jours) contient `publication.md` et l'image.

---

## Règles éditoriales de l'IA

Gemini doit respecter un journalisme prudent :

- utiliser **uniquement** le titre et la description de l'article choisi ;
- ne jamais inventer de date, chiffre, citation, nom ou conséquence ;
- ne pas fusionner plusieurs actualités ;
- respecter le degré de certitude de la source (une accusation n'est pas un fait) ;
- refuser de rédiger si les informations sont insuffisantes ;
- préférer, à qualité égale, un article avec image et une source différente des dernières publications.

Paramètres : `temperature = 0.35`, sortie JSON imposée par un schéma.

---

## Gestion des erreurs

- **Sources RSS** : une source en panne est ignorée.
- **Gemini** : 2 tentatives par modèle (attente de 5 s puis 10 s), puis bascule vers le modèle de secours. Une réponse JSON invalide est aussi retentée.
- **Erreurs définitives** (clé invalide, par exemple) : arrêt immédiat.
- **Image** : si le téléchargement ou l'envoi échoue, la publication part sans image, avec l'aperçu du lien.
- **Facebook** : message d'erreur explicite si la configuration est incomplète.
- En cas d'échec, le programme se termine avec le code `1` et l'exécution est marquée comme échouée dans GitHub Actions.
- Si tous les articles récents ont déjà été publiés, l'agent s'arrête **sans erreur**.

---

## Sécurité

- Ne **jamais** écrire de clé ou de jeton dans le code ni dans un commit.
- Utilisez toujours les **secrets GitHub**.
- Limitez le jeton Facebook au strict nécessaire et renouvelez-le s'il est exposé.
- Les images appartiennent à leurs sites d'origine : la source est toujours citée dans la publication. Gardez le mode brouillon activé si vous souhaitez vérifier les droits d'usage.

---

## Dépannage

| Message | Cause probable | Solution |
|---------|----------------|----------|
| `La clé GEMINI_API_KEY est absente` | Variable non définie | Ajouter la clé dans l'environnement ou les secrets |
| `Aucune actualité n'a pu être récupérée` | Flux inaccessibles ou réseau coupé | Vérifier la connexion et les URL |
| `Aucune nouvelle actualité à publier` | Tout a déjà été traité | Normal ; réessayer plus tard |
| `Tous les modèles Gemini sont temporairement indisponibles` | Surcharge ou quota | Réessayer, vérifier le quota et les noms de modèles |
| `Configuration Facebook incomplète` | `FB_PAGE_ID` ou jeton manquant | Ajouter les deux secrets |
| `Envoi de l'image impossible` | Jeton sans permission photo ou image refusée | Vérifier les permissions de la page |
| `Publication Facebook désactivée` | `FACEBOOK_AUTO_PUBLISH` différent de `true` | Mode brouillon normal |
| Le commit de l'historique échoue | Protection de branche ou permissions | Autoriser `github-actions` à pousser |

---

## Personnalisation

- **Ajouter une source** : ajoutez `{ name, url }` dans le tableau `SOURCES` de `index.js`.
- **Changer l'heure** : modifiez les lignes `cron` dans `agent.yml` (heure UTC).
- **Changer le ton ou le format** : modifiez la fonction `buildPrompt` et `buildPost`.
- **Changer d'âge maximal des articles** : variable `MAX_ARTICLE_AGE_HOURS`.
- **Changer de modèle** : `GEMINI_MODEL` et `GEMINI_FALLBACK_MODEL` dans le workflow.

---

## Licence

Projet personnel. Ajoutez un fichier `LICENSE` si vous souhaitez le partager publiquement.
