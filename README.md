# Rise

Compartilhamento de tela simples: crie uma sala, envie o link, convidados entram e o host libera quem pode transmitir.

Backend via **Supabase** (igual ao ECCO Vision): salas, logs e sinalização WebRTC em tempo real. O frontend pode ser hospedado em **GitHub Pages**, Cloudflare ou qualquer CDN estática.

## Instalação do Supabase

1. Abra **Supabase > SQL Editor > New query**.
2. Cole **todo** o conteúdo de [`supabase.sql`](supabase.sql).
3. Clique em **RUN**.
4. Em **Project Settings > API**, confirme a **Project URL** e a chave `sb_publishable_...` em [`config.js`](config.js).
5. Em **Project Settings > Realtime**, confirme que Realtime está **ligado**.
6. Em **Realtime > Settings**, deixe **Allow public access** ativado (a app usa canais públicos `rise-…`).

Pode usar o **mesmo projeto Supabase do ECCO** — as tabelas são `rise_*` e não conflitam com `ecco_*`.

## Configuração

Ajustes em [`config.js`](config.js):

- `SUPABASE_URL` e `SUPABASE_ANON_KEY` — credenciais do projeto.
- `ROOM_TTL_HOURS` — validade de uma sala, em horas.
- `ICE_SERVERS` — servidores STUN/TURN para o WebRTC atravessar NAT.

**Não** coloque `service_role` ou secret key no frontend.

## Deploy (GitHub Pages)

1. Suba o repositório no GitHub.
2. **Settings > Pages** → Source: branch `main`, pasta `/ (root)`.
3. Acesse pelo domínio `*.github.io` ou configure domínio customizado (ex.: `rise.riseroleplay.com.br`).
4. O site **precisa ser HTTPS** (GitHub Pages e Cloudflare já fornecem).

Arquivos necessários no deploy:

- `index.html`, `styles.css`, `app.js`, `config.js`
- `Logo.png` (e demais assets referenciados no HTML)

Não é necessário `node server.js` nem VPS para produção.

## Uso

1. Digite seu nickname e clique em **Criar sala**.
2. Copie o **link** ou **QR** no topo e envie para a equipe.
3. Convidados entram com o mesmo código ou link.
4. O **host** vê todos no painel **Pessoas** e clica em **Liberar tela** para permitir transmissão.
5. Quem foi liberado clica em **Compartilhar**.

## Checklist se a sala não cria

1. `supabase.sql` executado no projeto certo?
2. `config.js` com URL e chave publishable corretas?
3. Site aberto em **HTTPS**?
4. Realtime ligado e **Allow public access** ativo?
5. Hard refresh no navegador após deploy (`app.js?v=15`).

Se a lista de pessoas não atualizar entre aparelhos: rode de novo o `supabase.sql` (policies de Presence nos canais `rise-*`).

## Desenvolvimento local

Para testar sem Supabase, ainda existe o [`server.js`](server.js) legado (`node server.js` na porta 4173). Em produção, use Supabase.

## WebRTC

A mídia (tela compartilhada) **nunca passa pelo Supabase**: a transmissão é ponto a ponto entre navegadores. O backend só guarda salas/logs e faz a sinalização (presença, offer/answer/ICE).
