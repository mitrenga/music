# Stažení alba ve zvoleném formátu – specifikace

Podklad pro implementaci funkce „připravit album ke stažení“. Vychází z diskuse
27. 8. 2026. **Implementováno 27. 8. 2026** – aktuální popis je v README
(sekce *Album download*); tento dokument zůstává jako záznam návrhu. Odchylky
od návrhu: `downloadEvents` (SSE) nebylo přidáno (stačí polling), soubory
v ZIPu nesou tvar `Interpret/Album (rok)/NN - Název.ext`, kvalita je pevná.

## 1. Cíl

Přihlášený uživatel si nechá připravit **jedno** album jako ZIP ve formátu
FLAC / ALAC / AAC / MP3 pro nahrání do externího přehrávače (telefon, autorádio,
hi‑fi přehrávač). Příprava běží na pozadí, stránka ukazuje průběh, hotový ZIP se
nabídne ke stažení. Nová žádost nahradí předchozí připravené album (po dotazu).

Mimo rozsah: CD image (BIN/CUE) – vypuštěno, výběr jednotlivých skladeb, více
alb najednou, historie stažení.

## 2. Formáty

| Volba v UI | Kontejner | ffmpeg | Poznámka |
|---|---|---|---|
| FLAC (originál) | `.flac` | žádná konverze, `copy` | okamžité, jen zabalení |
| ALAC (Apple Lossless) | `.m4a` | `-c:a alac` | iPhone / Apple Music; hi‑res zůstane hi‑res |
| AAC | `.m4a` | `-c:a aac -b:a 256k` | nativní enkodér ffmpeg (libfdk není k dispozici) |
| MP3 | `.mp3` | `-c:a libmp3lame -q:a 0 -id3v2_version 3` | V0 ≈ 245 kb/s; ID3v2.3 kvůli autorádiím |

Kvalita lossy je pevná – **vysoká** (hodnoty výše), bez volby v UI
(rozhodnuto). Parametr `quality` v API se nezavádí.

Společné pro konverzi (`ffmpeg -y -loglevel error -nostdin`):

- `-map_metadata 0` – přenos tagů (title, artist, albumartist, album, track,
  disc, date, genre, composer).
- `-map 0:a:0` – jen audio stream (embedded cover ve FLAC se řeší zvlášť).
- Cover: `cover.jpg` z adresáře alba zmenšený na max 600×600 px / ~200 kB
  (ImageMagick `convert`) a vložený do každého souboru:
  - MP3: `-i cover_small.jpg -map 1:v -c:v copy -metadata:s:v title="Album cover" -metadata:s:v comment="Cover (front)" -disposition:v attached_pic`
  - M4A (ALAC/AAC): stejně, ffmpeg zapíše `covr` atom.
  - FLAC: soubor se kopíruje beze změny (cover má, pokud byl vložen při ripu).
- `cover.jpg` (originál) se navíc přiloží do adresáře alba v ZIPu.
- Tracky se konvertují paralelně, max `min(4, nproc-2)` procesů ffmpeg
  současně (server má 6 jader).

## 3. Pojmenování a struktura ZIPu

```
Interpret - Album (rok) [FLAC].zip
└── Interpret/
    └── Album (rok)/
        ├── 01 - Název skladby.flac
        ├── 02 - Název skladby.flac
        ├── ...
        └── cover.jpg
```

- Vícediskové album: `1-01 - Název.ext` (disc-track) – jedno ploché pořadí,
  správně se řadí abecedně i podle tagů.
- Sanitizace názvů: odstranit `/ \ : * ? " < > |` a řídicí znaky, ořezat tečky
  a mezery na konci, max 120 znaků. Diakritika zůstává (UTF‑8, ZIP flag 0x800).
- Volba **„bez diakritiky“** (checkbox, default vypnuto) – transliterace přes
  `iconv('UTF-8', 'ASCII//TRANSLIT')`; pro FAT32 flashky a stará autorádia.
- ZIP metoda **STORE** (bez komprese) – audio se nekomprimuje, šetří CPU/čas.
- Zdroj názvů: tagy z `.meta.json` (stejně jako přehrávač), fallback název
  souboru.

### Vytvoření ZIPu – vlastní zapisovač v PHP (rozhodnuto)

Na serveru není ani PHP modul `zip`, ani `zip` CLI, a nechceme další systémovou
závislost. ZIP se zapíše vlastní třídou `ZipWriter` v `downloadLib.php`:

- metoda **0 (Stored)** – řádná metoda ZIP formátu, rozbalí ji každý nástroj;
- local file header (`PK\3\4`) s flag bitem 11 (názvy UTF‑8), DOS čas/datum,
  CRC‑32 (`hash_file('crc32b')`, hex → int), velikosti; data přes
  `stream_copy_to_stream`; na konci central directory (`PK\1\2`) a EOCD (`PK\5\6`);
- **bez ZIP64** – limit 4 GB na archiv; worker před balením sečte velikosti a
  nad `DOWNLOAD_MAX_ZIP = 4 GiB − rezerva` skončí chybou „album je příliš velké“
  (ZIP64 lze doplnit později, ~40 řádků);
- ověření výsledku: `unzip -t` / `7z t` v `check.sh` (pokud jsou nástroje
  k dispozici) a ruční test ve Windows Explorer, macOS a Androidu.

## 4. Adresářová struktura

```
music/
└── tmp/                       nový; v .gitignore; fix-perms.sh nastaví OWNER:www-data 2770
    ├── .slots/                globální limit souběžných konverzí (lock soubory 0..N-1)
    └── <userKey>/             jeden adresář na uživatele
        ├── .lock              flock – jeden job na uživatele
        ├── job.json           stav jobu (viz §6)
        ├── work/              rozpracované soubory (mazáno po dokončení)
        ├── album.zip.part     ZIP ve výstavbě
        └── Interpret - Album (rok) [MP3].zip   hotový výsledek
```

`userKey` = bezpečný název odvozený z loginu: `libor` → `u-libor` (jen
`[A-Za-z0-9._-]`, ostatní znaky → `_`, max 64 znaků).

**Stahovat smí jen uživatel přihlášený jménem a heslem.** Automatický IP login
(`@ip:…`) a `@noconfig` stahování nemají – API vrátí 403, UI tlačítko
nezobrazí (`whoami` vrací `user`, klient pozná prefix `@`). Důvod: IP
adresa není identita, sdílená síť by měla jedno společné album a nešlo by
určit vlastníka.

`tmp/` je za `auth_request` stejně jako `cd/` a `covers/` (viz §9); stažení jde
přes nginx, nikoli přes PHP.

## 5. Tok

```
[UI: tlačítko „Stáhnout album…“ v detailu alba]
    │  dialog: formát, kvalita (lossy), bez diakritiky, odhad velikosti
    ▼
POST getData.php?action=downloadPrepare  {id, format, ascii, replace}
    │  ověří přihlášení a album, načte stav job.json
    ├─ existuje ready/running job pro jiné album (nebo jiný formát)
    │     a replace=false  → 409 {status:'exists', job:{…}}  → UI se zeptá
    ├─ existuje ready job pro totéž album+formát → 200 {status:'ready', …}
    │     (UI rovnou nabídne stažení, nic se nepřipravuje)
    ├─ replace=true → zabít běžící worker (SIGTERM na PID), smazat adresář
    ▼
zapíše job.json {status:'queued'}, spustí worker:
    exec('nohup php download-worker.php <userKey> >/dev/null 2>&1 &')
    → 202 {status:'queued'}
    │
    ▼  worker (CLI, běží dál i po zavření záložky)
  1. flock tmp/<userKey>/.lock (nonblocking; obsazeno → konec)
  2. úklid: smaže cizí tmp/*/ starší než TTL (§7)
  3. získá slot: flock prvního volného tmp/.slots/N (blokující, status 'queued')
  4. status 'converting', pro každý track ffmpeg (paralelně), heartbeat + progress
  5. status 'packing', zip → album.zip.part → rename na finální název
  6. status 'ready' {file, size, finishedAt}; smaže work/
  chyba kdekoli → status 'error' {message}, smaže work/ a .part
    │
    ▼
UI polluje GET getData.php?action=downloadStatus každé 2 s
  (nebo SSE – viz §8), zobrazí průběh; ready → odkaz ke stažení
    │
    ▼
GET /music/tmp/<userKey>/<soubor>.zip   (nginx, auth_request, Range OK)
```

Stažení hotového souboru **nemaže** – uživatel může stáhnout opakovaně;
smaže se při další žádosti (replace), ručně tlačítkem, nebo úklidem (§7).

## 6. job.json

```json
{
  "id": "Interpret/Album",
  "artist": "Interpret", "title": "Album", "year": 1997,
  "format": "mp3", "ascii": false,
  "status": "converting",
  "pid": 12345,
  "startedAt": 1756300000, "heartbeat": 1756300042, "finishedAt": null,
  "tracksTotal": 12, "tracksDone": 5,
  "file": null, "size": null,
  "message": null
}
```

Stavy: `queued` → `converting` → `packing` → `ready` | `error`.

Zápis atomicky (`job.json.tmp` + `rename`). `heartbeat` obnovuje worker po
každém tracku a min. každých 15 s (při dlouhé konverzi z vedlejšího ticku).

Detekce mrtvého jobu (bez cronu, dělá `downloadStatus` při čtení): status
`queued|converting|packing` a (`heartbeat` starší než 90 s **nebo**
`posix_kill(pid, 0)` selže) → API vrátí `status:'error', message:'Příprava
selhala (proces skončil)'` a nabídne „Zkusit znovu“, což je běžný
`downloadPrepare` s `replace=true`.

## 7. Úklid bez cronu

- **Při startu workeru**: projde `tmp/*/job.json`; `ready` nebo `error` starší
  než **7 dní** (`finishedAt`), případně adresář bez `job.json` starší než 1 den
  → smazat celý adresář. Běžící joby cizích uživatelů nechává.
- **Při `whoami`** (jednou za přihlášení) levná kontrola vlastního adresáře:
  totéž pravidlo jen pro sebe.
- **Ručně**: `downloadDelete` – tlačítko „Smazat připravené“.
- TTL jako konstanta `DOWNLOAD_TTL_DAYS = 7` v `getData.php`/workeru,
  přepsatelná v `config.json` klíčem `downloadTtlDays`.

## 8. API (getData.php) – nové akce

Všechny vyžadují přihlášení (401) **heslem** – IP auto‑login dostane 403
(pomocná funkce `requirePasswordUser()`). Žádné nové právo v `config.json`;
volitelně později právo `download` pro další omezení.

| Akce | Metoda | Vstup | Výstup |
|---|---|---|---|
| `downloadEstimate&id=X&format=F` | GET | | `{size, duration, tracks}` – FLAC součet velikostí, lossy `duration × bitrate` |
| `downloadPrepare` | POST | `{id, format, ascii, replace}` | 202 `{status:'queued'}` / 200 `{status:'ready',…}` / 409 `{status:'exists', job}` / 400 |
| `downloadStatus` | GET | | `job.json` (+ `url` u ready, + detekce mrtvého jobu) nebo `{status:'none'}` |
| `downloadCancel` | POST | | SIGTERM workeru, smazání adresáře → `{status:'none'}` |
| `downloadDelete` | POST | | smazání hotového souboru → `{status:'none'}` |
| `downloadEvents` | GET (SSE) | | volitelně místo pollingu: `text/event-stream`, PHP smyčka čte `job.json` každou 1 s, `fastcgi_finish_request` nepoužívat; ukončit po `ready|error` nebo po 10 min |

Doporučení: začít **pollingem** (2 s, jen když je dialog/badge viditelný),
SSE přidat jen pokud bude vadit.

## 9. nginx

Rozšířit stávající snippet:

```nginx
location ~ ^/music/(?:cd|covers|tmp)/ {
	auth_request /music-auth-check;
}
```

Poznámky:

- `auth.php` ověří jen přihlášení, **ne** vlastnictví adresáře. Aby si
  uživatelé nestahovali navzájem, buď (a) `userKey` nechat neuhodnutelný –
  `u-<login>-<8 hex z HMAC(login, rememberKey/secret)>`, nebo (b) do
  `auth.php` doplnit kontrolu `X-Original-URI` proti `userKey` aktuálního
  uživatele (nginx: `proxy_set_header`/`fastcgi_param X_ORIGINAL_URI
  $request_uri`). **Doporučeno (b)** – deterministické, čitelné, bezpečné;
  (a) je záložní jednodušší varianta.
- `job.json`, `.lock`, `work/`, `*.part` nesmí být stažitelné:
  `location ~ ^/music/tmp/[^/]+/(?:\.|job\.json|work/|.*\.part$) { deny all; }`
  (nebo obecně zakázat všechno v `tmp/` kromě `*.zip`).
- Přidat `Content-Disposition: attachment` pro `*.zip` v `tmp/`
  (`add_header`), aby prohlížeč rovnou stahoval.
- `check.sh` rozšířit: `tmp/…/*.zip` bez přihlášení → 403, `job.json` → 403
  i s přihlášením.

## 10. Souběh a limity

- **Jeden job na uživatele**: `flock(tmp/<userKey>/.lock, LOCK_EX|LOCK_NB)`
  v workeru; API navíc odmítne `downloadPrepare`, pokud je stav
  `queued|converting|packing` a `replace=false` (409).
- **Globální limit**: `DOWNLOAD_SLOTS = 2` (2 joby × až 4 ffmpeg = 8 procesů
  na 6 jádrech – OK, přehrávání streamuje nginx bez CPU). Worker čeká na slot
  se stavem `queued`, UI ukáže „Čeká ve frontě“.
- **Dvě záložky**: druhé kliknutí vidí 409 → dotaz „Právě se připravuje X.
  Nahradit?“.
- **Kill workeru**: SIGTERM → worker zachytí (`pcntl_signal`), zabije své
  ffmpeg potomky (`proc_terminate`), smaže `work/`, uvolní lock, skončí.
  Bez `pcntl` fallback: API smaže adresář, osiřelý ffmpeg dopíše do smazaného
  inode a skončí sám – nepěkné, ale neškodné.

## 11. UI

- **Detail alba**: tlačítko „Stáhnout album…“ → dialog:
  - formát (radio: FLAC · ALAC · AAC · MP3) s jednořádkovou nápovědou
    („FLAC – bez ztráty, okamžitě; ALAC – iPhone; AAC/MP3 – menší soubory“);
  - checkbox „názvy souborů bez diakritiky“;
  - řádek „Odhad: 12 skladeb · 52:10 · ≈ 96 MB“ (z `downloadEstimate`);
  - „Připravit“.
- Pokud existuje jiné připravené/běžící album → dotaz „Máte připravené
  *X [FLAC]* (340 MB). Nahradit ho?“ [Nahradit] [Stáhnout stávající] [Zrušit].
- Pokud existuje totéž album ve stejném formátu → rovnou stažení.
- **Průběh** ve stejném dialogu i jako lišta/badge v hlavičce (viditelná i po
  odchodu z alba): „Čeká ve frontě“ → „Převádím 5/12 – Název skladby“ →
  „Balím…“ → „Hotovo · 96 MB · [Stáhnout] [Smazat]“ / „Chyba: … [Zkusit
  znovu]“. Tlačítko [Zrušit] během běhu.
- Badge s hotovým albem se zobrazuje trvale v hlavičce (po `whoami` se
  zavolá `downloadStatus`), dokud uživatel soubor nesmaže / nenahradí.
- Tlačítko „Stáhnout album…“ se zobrazuje jen heslovým uživatelům
  (`whoami.user` bez prefixu `@`).
- Volitelné: `Notification API` „Album je připravené“ když uživatel dialog
  opustil; Esc zavírá dialog (stejně jako jinde v aplikaci).

## 12. Soubory k vytvoření / úpravě

| Soubor | Změna |
|---|---|
| `download-worker.php` | nový CLI worker (konverze, ZIP, úklid, sloty) |
| `downloadLib.php` | nový: `userKey()`, čtení/zápis `job.json`, sanitizace názvů, odhad, třída `ZipWriter` – sdílí `getData.php` i worker |
| `getData.php` | akce z §8, `whoami` + úklid vlastního adresáře |
| `auth.php` | pro `tmp/` navíc: jen heslový uživatel a kontrola vlastnictví `tmp/<userKey>/` podle `X-Original-URI` |
| `app.js`, `index.php`, `style.css` | dialog, průběh, badge |
| `fix-perms.sh` | přidat `tmp` do seznamu adresářů |
| `.gitignore` | `/tmp/` |
| `nginx/…`, README | snippet z §9, Requirements (`zip`), popis funkce, API tabulka |
| `check.sh` | testy z §9 |

## 13. Rozhodnutí

1. ~~Způsob vytvoření ZIPu~~ – rozhodnuto: vlastní zapisovač v PHP (§3).
2. ~~Ochrana `tmp/<userKey>`~~ – rozhodnuto: varianta (b) přes `auth.php`
   + `X_ORIGINAL_URI` (jeden řádek navíc v nginx snippetu).
3. ~~IP auto‑login uživatelé~~ – rozhodnuto: stahují jen heslově přihlášení.
4. ~~Kvalita u lossy~~ – rozhodnuto: pevně vysoká, bez volby.
