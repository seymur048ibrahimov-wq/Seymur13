# SEYMUR13

OKX SWAP bazarı üçün çox-timeframe (15m/30m/1H/4H) siqnal botu — 20 sabit coin üzrə 7/24 skan. Telegram-a real-vaxt bildiriş göndərir, istəyə bağlı avtomatik ticarət edə bilər, admin API ilə idarə olunur.

**Status işarələri** (bot mesajlarında və aşağıda eyni məna daşıyır):
- 🟢 aktiv / LONG / işləyir
- 🔴 deaktiv / SHORT / dayanıb
- ⚪ WAIT / gözləmə

## Xüsusiyyətlər

- 4 timeframe-in (15m/30m/1H/4H) konfluensiyası (min. 3/4 eyni istiqamətdə olmalıdır ki, LONG/SHORT siqnalı yaransın)
- Hər siqnalda: giriş qiyməti, Stop Loss, TP1/TP2/TP3, R:R, etibar faizi (0-100%), funding rate, open interest trend
- 📅 Makro trend (1D) + 📊 gözlənilən 4H/24H aralıq — ATR-əsaslı statistik kontekst (proqnoz DEYİL, bax aşağıda)
- 🎯 Erkən triqqer: 15m sürətli TF, 1H trend TF ilə üst-üstə düşəndə əsas siqnaldan əvvəl xəbərdarlıq
- Telegram bot komandaları ilə tam idarəetmə (aşağıya bax)
- Manual giriş (`/open`) — MIN_CONFIDENCE həddini gözləmədən özün istədiyin vaxt AL/SAT aça bilərsən
- Kill-switch: gündəlik zərər limiti aşılanda avtomatik ticarət dayandırılır
- State restart-dan sonra bərpa olunur (fayl və ya Postgres)

## Quraşdırma

```bash
git clone <bu-repo>
cd seymur13
npm install
cp .env.example .env
```

`.env` faylını doldur (minimum: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`). Bütün dəyişənlərin izahı `.env.example` faylındadır.

```bash
npm start
```

## Deploy (Railway / Render və s.)

1. Repo-nu hostinqə qoş
2. `.env`-dəki bütün dəyişənləri hostinqin **Variables/Environment** bölməsinə əl ilə əlavə et (fayl özü GitHub-a getmir)
3. Build/start komandası: `npm start`

## Telegram komandaları

| Komanda | Nə edir |
|---|---|
| `/status` | Bot vəziyyəti: scanner, trading, auto-trade, kill-switch, uptime |
| `/signals` | Son 5 siqnal |
| `/positions` | Açıq mövqelər |
| `/balance` | USDT balansı |
| `/analyse SYMBOL` | Konkret simvolu dərhal analiz et |
| `/open SYMBOL LONG\|SHORT CONFIRM` | **Manual giriş** — etibar faizindən asılı olmadan dərhal aç (risk sənin üzərindədir) |
| `/close SYMBOL` | Açıq mövqeni bağla |
| `/stop` / `/resume` | Skaneri dayandır/işə sal |

## Təhlükəsizlik

- `.env` heç vaxt commit edilməməlidir (`.gitignore`-da bağlıdır)
- `ADMIN_API_KEY` təyin edilməyibsə, bütün pul/mövqe ilə bağlı endpoint-lər tamamilə bağlıdır
- `TRADING_ENABLED=false` olduqda real order göndərilmir — bot yalnız siqnal göndərir
- `MAX_DAILY_LOSS_PCT` aşılanda avtomatik ticarət dayandırılır (kill-switch)

## Backtest

```bash
npm run backtest BTC-USDT-SWAP 15m 180
```

Qeyd: bu, TƏK bir timeframe-in sadələşdirilmiş sınağıdır — real bot 4 timeframe konfluensiyasına əsaslanır.

**Daha dəqiq sınaq (tövsiyə olunur):** `multi-tf-backtest.js` real botun gördüyü 4-timeframe konfluensiyasını (15m/30m/1H/4H) 1:1 təkrarlayır və "bu siqnal anında girsəydim, DƏQİQ 24 saat sonra nə olardı" sualına cavab verir — leverage ilə likvidasiya riski daxil:

```bash
npm run backtest:multi BTC-USDT-SWAP 14 10
# (simvol, neçə gün geriyə, leverage)
```

---

⚠️ Bu proqram maliyyə məsləhəti vermir. Kriptovalyuta ticarəti yüksək riskli fəaliyyətdir, itirə biləcəyindən artıq məbləğlə işləmə.

**"Gözlənilən aralıq" və "Makro trend" haqqında vacib qeyd:** bunlar proqnoz deyil. Makro trend (1D) sadəcə gündəlik EMA50/EMA200 münasibətini göstərir. Gözlənilən aralıq isə son real volatilitəyə (ATR) əsaslanan statistik miqyaslamadır (ATR × √saat) — qiymətin "adətən" nə qədər hərəkət etdiyini göstərir, "harada olacağını" yox. Bazar istənilən an bu aralığın kənarına çıxa bilər.
