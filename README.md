# discord-canary-scraper (dépôt de test)

Datamining du client Discord Canary : builds, expériences, strings, routes, rollouts Apex / utilisateurs, quêtes, boutique, blog, versions mobiles, veille X. Les nouveautés sont postées sur Discord via webhooks.

## Structure

| Dossier | Rôle |
|---|---|
| `src/` | Scripts principaux (`index.js` = scrape Canary, `quests.js`, `apex_rollouts.js`, `user_rollouts.js`, `shop.js`, `blog_tracker.js`, `mobile_*.js`, `x_*.js`) |
| `src/lib/` | Bibliothèque partagée (téléchargement, extraction, notify, dédup webhooks, état atomique…) |
| `test/` | Tests unitaires (`node --test`) |
| `data/` | État persistant commité par les workflows |
| `builds/` | Archive des derniers builds (manifest + bundle web), limitée par `ARCHIVE_KEEP_BUILDS` |
| `docs/` | Site GitHub Pages (expériences, boutique, statut) |
| `media/` | Avatar du bot (`datamining-avatar.png`, utilisé par les webhooks) |
| `scripts/` | `check.js` (syntaxe), `trigger_host.py` / `canary_trigger.py` (déclencheurs externes), `sync_advaith.py` |
| `cogs/` | Cog discord.py équivalent au déclencheur |

## Commandes

```bash
npm ci
npm run verify     # check + lint + tests
npm run check      # syntaxe de tous les .js
npm run lint       # ESLint
npm test           # tests unitaires (n'écrivent jamais dans data/)
npm start          # scrape Canary
```

## Workflows GitHub Actions

| Workflow | Fréquence | Script |
|---|---|---|
| `ci.yml` | push / PR | check + lint + tests (Node 20 & 22), actionlint, Python |
| `scrape.yml` | */5 min + dispatch `trigger-scraping` | `src/index.js` |
| `quests.yml` | */5 min | `src/quests.js` |
| `apex-rollouts.yml` | */20 min | `src/apex_rollouts.js` |
| `user-rollouts.yml` | :10/:30/:50 | `src/user_rollouts.js` |
| `mobile-versions.yml`, `shop.yml`, `blog-tracker.yml`, `x-news.yml`, `x-watch.yml` | planifiés | scripts correspondants |
| `pages.yml` | push sur `docs/` ou données | déploiement Pages |

## Secrets / variables

Secrets : `DISCORD_WEBHOOK_URL` (obligatoire), `APEX_WEBHOOK_URL`, `ROLLOUT_WEBHOOK_URL`, `QUEST_WEBHOOK_URL`, `DISCORD_TOKEN`, `DISCORD_USER_TOKEN(S)`, `DISCORD_USER_TOKEN_1..5`, `ORBIT_BOT_NAME`, `EMOJI_*`, `MOBILE_DATAMINE_REPO`.

Variable optionnelle : `ORBIT_AVATAR_URL`. Par défaut, l'avatar est `media/datamining-avatar.png` servi par jsDelivr, ce qui ne fonctionne que si le dépôt est public. Sur un dépôt privé, définir `ORBIT_AVATAR_URL` vers une image PNG/JPG publique (Discord n'accepte pas le SVG).

## Déclencheur rapide (optionnel)

Le cron GitHub a souvent du retard. `scripts/trigger_host.py` vérifie le `BUILD_NUMBER` Canary et ne déclenche Actions que si le build change :

```bash
export GITHUB_TOKEN=...            # PAT classic : repo + workflow (jamais dans le code)
export GITHUB_REPO=kmljkjj/discord-canary-scraper-test
export INTERVAL=50
python3 scripts/trigger_host.py
```

## Changements par rapport au dépôt d'origine

- Suppression d'environ 70 workflows ponctuels (`patch-*`, `heal-*`, `restore-*`, `fix-*`…). Ils modifiaient et poussaient directement le code source (`src/index.js`, `src/quests.js`…), ce qui a déjà corrompu des fichiers.
- Suppression des morceaux base64 et fichiers temporaires (`tmp/`, `patches/`, `scripts/*_parts`, `.github/payloads`, `data/.payload`, chunks en cache dans `assets/`).
- `apex-rollouts.yml` réparé : YAML invalide depuis le 19/09, donc le workflow ne tournait plus.
- `user-rollouts.yml` reconstruit : le fichier ne contenait que `PLACEHOLDER` depuis le 21/09. Il est décalé de 10 min par rapport à Apex pour limiter les 429.
- `scrape.yml` : les archives étaient ajoutées depuis `data/builds/`, alors que le code écrit dans `builds/`. Elles n'étaient donc plus commitées depuis le 15/09. Les anciens builds sont maintenant élagués (8 gardés).
- Tests : `webhook_dedupe` et `notify_partial_batch` supprimaient le vrai `data/notify_dedupe.json`, ce qui provoquait des doubles notifications. Ils utilisent maintenant un dossier temporaire.
- Avatar : l'URL par défaut pointait vers un `.jpg` inexistant (404) ou un `.svg` que Discord refuse. Ajout de `media/datamining-avatar.png`.
- `index.js` : limite `MAX_NOTIFY_RT` réellement appliquée aux routes ajoutées, et suppression du code mort.
- `pages.yml` : le déploiement ne plante plus si Pages n'est pas activé, et il ne tourne que quand `docs/` ou les données publiées changent.
- `mobile-versions.yml` : l'étape « client files » tourne même si l'étape versions échoue.
- Ajout de la CI, d'ESLint, de `scripts/check.js` (tous les fichiers au lieu d'une liste manuelle incomplète), de `npm test` (tous les tests au lieu de 3 sur 7) et de nouveaux tests (`archive_chunks`, `atomic`).
