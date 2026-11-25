# Reheated Nachos
<img width="1257" height="760" alt="Captura de pantalla 2026-11-25 a les 13 19 42" src="https://github.com/user-attachments/assets/57d85b0f-dcc6-4075-879d-6b5b5cb3f89e" />


## Què és Reheated Nachos?
Reheated Nachos és un cronòmetre que permet fer seguiment del temps que dediques a una tasca. Amb cada temporitzador, escalfaràs un plat de menjar al teu gust.

## D'on surt la idea de Reheated Nachos?
És un "remake" de l'aplicació mòbil Forest, amb què es podia plantar un arbre mentre estudiaves. Una empresa més grossa va comprar l'aplicació i ara és de pagament amb subscripció mensual.

## Què vol dir el nom Reheated Nachos
Reheating nachos is internet-speak for producing creative work—such as a song, album, acting performance, lewk, etc.—that is similar to, but (usually) not as good as, one that came before. In other words, to reheat nachos is to build on someone else’s work (or one’s own) without adding anything new or fresh. (https://www.merriam-webster.com/slang/reheat-nachos)

A més, literalment es poden reescalfar natxos! 

## L'app (v0.1b)
Una pàgina senzilla: entres amb correu i contrasenya, tries el menjar, poses una etiqueta i el poses a escalfar (▶) fins que l'atures (■). A sota hi ha les estadístiques per setmana, mes i any (total i per etiqueta) i els darrers plats, que es poden editar o esborrar.

Fet amb [Bun](https://bun.sh), SQLite (`bun:sqlite`) i [Better Auth](https://www.better-auth.com). Sense framework ni compilació: `server.ts` serveix l'API i `public/index.html`.

### Posar-la en marxa
```bash
bun install
echo "BETTER_AUTH_SECRET=$(openssl rand -base64 32)" > .env
bun run server.ts        # http://localhost:3002/app/
```

- Configuració a `.env`: `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` (l'adreça pública); opcionals `PORT`, `BASE_PATH`, `DB_PATH`.
- Les dades són a `reheated-nachos.db`; les taules es creen soles en arrencar.
- En producció corre amb pm2 i nginx hi envia `/app` (vegeu `nginx-app.conf`). Cal que nginx passi la IP real a `X-Forwarded-For`, que es fa servir per limitar els intents de login.

### Usuaris
El registre és tancat. Els comptes es creen des del panell d'admin (si ets admin, clicant el teu correu a baix de tot) o al servidor:

```bash
bun run crea-usuari.ts [--admin] correu@exemple.cat "Nom"
```

Cada compte nou rep una contrasenya aleatòria que s'ha de canviar en entrar per primer cop.
