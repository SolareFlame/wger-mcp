# wger-mcp

Serveur MCP distant (TypeScript) qui relie claude.ai (connecteur personnalisé) à une
instance [wger](https://github.com/wger-project/wger) auto-hébergée.

Multi-utilisateur et sans état : chaque utilisateur met **sa** clé API wger dans l'URL du
connecteur, `https://mcp-gym.solare.dev/<clé>/mcp`. Le serveur ne stocke rien.

**Version wger testée : 2.8.0-dev.5** (`/api/v2/version/`, image `wger/server:latest`,
vérifiée le 2026-11-16). Le schéma OpenAPI de cette instance est versionné dans
[`wger-schema.json`](wger-schema.json).

## Outils

| Outil | Rôle | Endpoints wger |
|---|---|---|
| `search_exercises` | Recherche par nom dans une langue (`language`, défaut `DEFAULT_LANGUAGE`) | `GET /exerciseinfo/?name__search=&language__code=` |
| `list_routines` | Routines de l'utilisateur (hors templates) | `GET /routine/?is_template=false` |
| `get_routine` | Jours → slots (superset si plusieurs entrées) → exercices avec séries/reps/charge/RIR/repos : valeur de base, max (fourchette), progression | `GET /routine/{id}/structure/` |
| `log_sets` | Enregistre des séries (kg) d'un exercice | `POST /workoutlog/` |
| `get_history` | Séries par jour puis par exercice, avec e1RM par série | `GET /workoutlog/?exercise=&date__gte=&date__lt=&ordering=-date` |
| `get_e1rm` | Meilleur e1RM et e1RM le plus récent sur N jours, et TM | `GET /workoutlog/` |
| `compute_loads` | Charges par % d'un TM ou d'un 1RM (calcul pur) | aucun |
| `create_routine` | Crée une routine simple : jours, exercices, séries × reps, charge et RIR optionnels | `POST routine/ day/ slot/ slot-entry/ *-config/` |

Calculs (`src/domain/strength.ts`) :
- e1RM = Epley ajusté RIR, `w × (1 + (reps + rir) / 30)` ; `null` si `reps + rir > 12`.
  RIR absent = 0. Seules les séries en kg ou lb (lb converties) et comptées en répétitions sont retenues.
- TM = 90 % du e1RM, arrondi au 2,5 kg le plus proche (ratio et pas paramétrables).

## Architecture

```
src/
  index.ts             démarrage : config, écoute, arrêt propre
  app.ts               Express + StreamableHTTPServerTransport STATELESS
                       (1 McpServer par requête, POST /:apiKey/mcp uniquement)
  config.ts            variables d'environnement (validées avec zod)
  auth/credentials.ts  SEUL module qui sait d'où vient l'auth (clé dans l'URL, 40 hex)
  wger/client.ts       HTTP typé : Authorization: Token, timeout, pagination, erreurs typées
  wger/api.ts          ressources wger : endpoints, filtres, schémas de réponse (zod)
  wger/mapping.ts      conversion des payloads wger vers le domaine (WorkoutLog → SetResult…)
  domain/types.ts      types métier, sans aucun nom de champ wger
  domain/strength.ts   maths pures : e1RM, TM, charges par %
  tools/index.ts       outils MCP (schémas d'entrée, orchestration)
  tools/format.ts      présentation JSON compacte pour le modèle
```

Invariants :
- **Sans état** : aucune session MCP, aucun cache inter-requêtes, aucune donnée stockée.
- **Auth isolée** : le reste du code ne voit qu'un `WgerCredentials` opaque. Passer à OAuth
  revient à modifier `credentials.ts`.
- **Clé invalide ⇒ 404**, impossible à distinguer d'un chemin inconnu. `GET` et `DELETE`
  avec une clé valide ⇒ 405.
- **Aucun log ne contient l'URL ni la clé** : on ne logue que le template de route
  (`POST /:apiKey/mcp 200 31ms`). Un test unitaire le vérifie.
- **Noms de champs wger confinés à `src/wger/`** : `api.ts` pour les requêtes et schémas,
  `mapping.ts` pour la lecture. Les réponses sont validées par zod : si l'API change,
  l'erreur est explicite au lieu d'un `undefined` silencieux.

## Compatibilité wger 2.8 : champs vérifiés

Vérifiés sur le schéma ET par des appels réels :

| Ressource | Constat |
|---|---|
| `workoutlog` | `id` et `session` sont des **UUID** (chaînes). `exercise` (entier) = id de `/exerciseinfo/`. `date` est un **date-time**. `repetitions`, `weight`, `rir` sont des décimaux sérialisés en chaînes (`"100.00"`, `"2.0"`). `routine` est nullable. |
| unités | `weight_unit` vaut 1 (kg) par défaut et `repetitions_unit` 1 (Repetitions). Aucun n'est requis, mais le serveur les envoie explicitement. IDs : poids 1 kg, 2 lb, 3 Body Weight, 4 Plates, 5 km/h, 6 mph ; reps 1 Repetitions, 2 Until Failure, 3 Seconds, 4 Minutes, 5 Miles, 6 Kilometers, 7 Max Reps, 8 Meters. |
| précision | weight / repetitions : 2 décimales ; rir : 1 décimale et < 10. Au-delà, wger répond 400 : le serveur arrondit avant l'envoi. |
| séance auto | Sans `session`, wger rattache le log à la séance du jour (créée si besoin). Avec `session` mais sans `date`, la date du log est « maintenant », pas celle de la séance. |
| `workoutsession` | `id` est un UUID. Champs `datetime_start` / `datetime_end` (plus de `date`). `routine` et `day` existent et sont nullables. `impression` vaut `"1"`, `"2"` ou `"3"`. |
| recherche | **`/exercise/search/` n'existe plus (404).** On utilise `/exerciseinfo/?name__search=…&language__code=fr`, qui ne cherche que dans les traductions de cette langue (codes séparés par des virgules acceptés). `translations[]` contient toutes les langues : le nom est choisi via l'id de langue, via `/language/`. |
| routines | Modèle `routine → day → slot → slot-entry → {sets,repetitions,weight,rir,rest}-config` (+ `max-*`). `/routine/{id}/structure/` renvoie l'arbre complet en un appel. Supprimer une routine supprime aussi tout son arbre. |
| filtres `/workoutlog/` | `exercise`, `exercise__in`, `date__gte/gt/lt/lte`, `date__date`, `session`, `routine`, `ordering` (`-date`, `-weight`…). **Piège** : `date__lte=2026-11-15` vaut le 15/11 à 00:00 et exclut cette journée. Le serveur utilise `date__lt=<lendemain>`. Un `ordering` inconnu est ignoré silencieusement, un `exercise` inexistant renvoie 400. |
| pagination | `{count, next, previous, results}`. Le client parcourt `limit`/`offset` et ignore `next` : wger construit ce lien à partir du Host (URL interne ≠ URL publique). |
| suppressions | Supprimer une séance supprime aussi ses logs. Supprimer un log laisse la séance. |

## `create_routine`

Le schéma permet une création propre, mais pas atomique : wger n'a pas d'endpoint
transactionnel. L'outil enchaîne donc `routine → day → slot → slot-entry → configs`, et en
cas d'échec il supprime la routine, ce qui efface tout son arbre (vérifié). L'appel réussit
entièrement ou ne laisse rien.

- Jours dans l'ordre du cycle. Un jour peut être `rest: true`, sans exercice.
- Par exercice : `sets`, `reps`, `weight` (kg) optionnel, `rir` optionnel, en itération 1.
- `fit_in_week` vaut `true` par défaut : chaque cycle est complété par des jours de repos
  pour durer exactement 7 jours, à partir de `start` (vérifié via `date-sequence-display`).
  Pour lun/mer/ven : `start` un lundi et jours `[A, repos, B, repos, C]`.
- Limites wger : nom de routine ≤ 25 caractères, nom de jour ≤ 20, `end ≥ start`.
- Hors périmètre volontaire : fourchettes (`max-*-config`), progression (itérations > 1),
  supersets, temps de repos. Ils sont lisibles via `get_routine` mais pas créables ici.

## Configuration

| Variable | Défaut | Rôle |
|---|---|---|
| `WGER_BASE_URL` | requis | Racine wger vue du serveur, sans `/api/v2` (ex. `http://wger-nginx-1`) |
| `PORT` | `8000` | Port HTTP |
| `WGER_TIMEOUT_MS` | `10000` | Timeout de chaque appel wger |
| `DEFAULT_LANGUAGE` | `en` | Langue des noms d'exercices si l'appel n'en précise pas (ex. `fr`) |

## Déploiement

```yaml
# docker-compose.yml (extrait)
services:
  wger-mcp:
    build: .
    restart: unless-stopped
    environment:
      WGER_BASE_URL: http://wger-nginx-1
      DEFAULT_LANGUAGE: fr
    networks: [figutab_default]
networks:
  figutab_default:
    external: true
```

```caddyfile
mcp-gym.solare.dev {
	reverse_proxy wger-mcp:8000
}
```

Connecteur claude.ai : `https://mcp-gym.solare.dev/<clé API wger>/mcp`. La clé se trouve
dans wger, sous Paramètres → Clé API.

L'image tourne en utilisateur `node`, avec un `HEALTHCHECK` sur `GET /healthz` qui
n'appelle pas wger.

Derrière Cloudflare (proxy), le domaine doit rester à un seul niveau de sous-domaine
(`mcp-gym.solare.dev`, pas `mcp.gym.solare.dev`) : le certificat gratuit Cloudflare ne
couvre que `*.solare.dev`.

La clé est dans l'URL : ne pas activer les access logs Caddy pour ce site (Caddy n'en écrit
pas sans directive `log`), ou alors masquer le chemin.

## Développement

Node ≥ 22.18. Les tests s'exécutent directement en TypeScript (type stripping natif) avec
`node:test`, sans dépendance de test.

```bash
npm ci
npm run build    # tsc → dist/
npm test         # typecheck + tests unitaires (aucun réseau)
```

Test de bout en bout contre une vraie instance, ignoré par défaut. Il crée une séance
dédiée, un log et une routine, puis les supprime même en cas d'échec :

```bash
WGER_E2E_BASE_URL=https://gym.solare.dev WGER_API_KEY=<clé de test> npm run test:e2e
```

Derrière un proxy HTTP, ajouter `NODE_USE_ENV_PROXY=1` (le `fetch` de Node ignore
`HTTPS_PROXY` sans cette variable).
