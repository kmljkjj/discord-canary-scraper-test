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
| `scripts/` | `check.js` (syntaxe), `commit-state.sh` (commit/push d'état sûr), `summary.js` (résumé Actions), `trigger_host.py` / `canary_trigger.py` (déclencheurs externes), `sync_advaith.py` |
| `.github/actions/setup` | Action composite : Node 22 + cache npm + `npm ci` |
| `cogs/` | Cog discord.py équivalent au déclencheur |

## Commandes

```bash
npm ci
npm run verify     # check + lint + tests
npm run check      # syntaxe de tous les .js
npm run lint       # ESLint
npm test           # tests unitaires (n'écrivent jamais dans data/)
npm run coverage   # tests + couverture
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
| `alerts.yml` | après chaque échec | alerte Discord (si `ALERT_WEBHOOK_URL`), une seule tant que ça reste rouge |

## Secrets / variables

Secrets : `DISCORD_WEBHOOK_URL` (obligatoire), `APEX_WEBHOOK_URL`, `ROLLOUT_WEBHOOK_URL`, `QUEST_WEBHOOK_URL`, `DISCORD_TOKEN`, `DISCORD_USER_TOKEN(S)`, `DISCORD_USER_TOKEN_1..5`, `ORBIT_BOT_NAME`, `EMOJI_*`, `MOBILE_DATAMINE_REPO`.

Secret optionnel : `ALERT_WEBHOOK_URL` (salon d'alertes quand un workflow échoue).

Variables d'environnement utiles : `WEBHOOK_MAX_ATTEMPTS` (5), `WEBHOOK_TIMEOUT_MS` (20000), `ARCHIVE_KEEP_BUILDS` (8), `COMMIT_MAX_ATTEMPTS` (8).

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

### v2.4

- **Webhooks** : nouveau module partagé `src/lib/webhook.js`, utilisé par les 10 scripts qui avaient chacun leur propre copie. Il gère les 429 (`retry_after` JSON + en-têtes), les 5xx, les erreurs réseau et le timeout avec backoff. Il découpe les embeds selon les limites Discord (10 embeds et 6000 caractères par message) et masque le token dans les logs. Avant, 6 scripts sur 10 ne réessayaient jamais après un 429.
- **Extraction des expériences** (`extract.js`) :
  - le label, les variations et le `defaultConfig` ne débordent plus sur l'expérience voisine (5 labels et 4 jeux de variations étaient mal attribués sur le build 621556) ;
  - la forme minifiée `!0` / `!1` est reconnue : 238 `defaultConfig` extraits au lieu de 28 ;
  - le premier bloc `variations` / `treatments` trouvé gagne.
- **Commits d'état** : `scripts/commit-state.sh` remplace les 10 blocs copiés-collés. En cas de conflit, il repart de `origin/main` et ne réapplique que ses propres fichiers. L'ancien `reset --soft` de shop et blog pouvait annuler les commits des autres workflows.
- **Workflows** :
  - action composite `setup` avec cache npm et `npm ci` partout (x-news et x-watch supprimaient `package-lock.json`) ;
  - x-news et x-watch sont dans le même groupe de concurrence, car ils écrivent le même fichier ;
  - résumé du run dans l'onglet Summary ;
  - workflow d'alertes ;
  - Dependabot.
- **CI** : couverture de code sous Node 22 et 72 tests (51 → 72), dont un test d'intégration git de `commit-state.sh` et des tests d'extraction sur un extrait réel du bundle Discord.
