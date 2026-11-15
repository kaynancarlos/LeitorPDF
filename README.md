# Leitor PDF

Leitor de PDF **sem anúncios**, com **tema claro e escuro**, zoom, busca e **conversor de imagem para PDF**.
É um site estático: roda 100% no navegador, não tem servidor e nenhum arquivo é enviado para a internet.

## Recursos

**Leitor**
- Abrir PDF por botão, arrastando o arquivo ou `Ctrl+O`
- Zoom (botões, lista, `Ctrl+scroll` e pinça no celular), ajustar à largura e página inteira
- Mostra a página atual e **permite digitar a página** para ir direto (`Ctrl+G`)
- Miniaturas na lateral, que **pode ser arrastada para redimensionar** ou ocultada
- Ferramenta mão (arrastar o documento), selecionar e copiar texto
- Busca de texto com destaque (`Ctrl+F`)
- Girar páginas, tela cheia, baixar e imprimir
- PDFs com senha
- Lembra a última página lida de cada arquivo
- Tema claro/escuro e opção de "páginas escuras" (inverte as cores para ler à noite)

**Imagem → PDF**
- Várias imagens em um único PDF, ou **tirar foto pela câmera** no celular
- Reordenar (arrastar ou setas), girar e remover
- Tamanho A4, Carta ou ajustado à imagem; orientação e margens
- Qualidade (alta, equilibrada ou pequena, para enviar por e-mail)
- Baixar, compartilhar (celular) ou abrir direto no leitor

## Estrutura

```
leitor-pdf/
├── index.html            # página única (SEO, Open Graph, JSON-LD)
├── 404.html
├── favicon.svg
├── site.webmanifest      # instalável como app (PWA leve)
├── robots.txt
├── sitemap.xml
├── vercel.json           # cabeçalhos de segurança e cache
├── package.json
├── scripts/set-domain.mjs
└── assets/
    ├── css/style.css
    ├── js/               # app.js, viewer.js, converter.js, utils.js, theme-init.js
    ├── img/              # ícones e imagem de compartilhamento
    └── vendor/           # PDF.js e pdf-lib (já incluídos, sem CDN)
```

## Rodar no seu computador

Precisa só de um servidor estático (abrir o `index.html` direto com duplo clique **não funciona**, por causa dos módulos do navegador):

```bash
npm run dev
# abre em http://localhost:3000
```

ou, com Python: `python3 -m http.server 3000`

## Publicar (GitHub + Vercel)

1. **GitHub:** crie um repositório novo (ex.: `leitor-pdf`) e envie a pasta:
   ```bash
   git init
   git add .
   git commit -m "Leitor PDF"
   git branch -M main
   git remote add origin https://github.com/SEU-USUARIO/leitor-pdf.git
   git push -u origin main
   ```
   (Ou, pelo site do GitHub, **Add file → Upload files** e arraste o conteúdo da pasta.)
2. **Vercel:** em [vercel.com/new](https://vercel.com/new) escolha **Import** no repositório.
   Em *Framework Preset* deixe **Other**. Não precisa de *Build Command* nem de *Output Directory*. Clique em **Deploy**.
3. **Ajustar o endereço (SEO):** depois do deploy, a Vercel mostra o seu endereço (ex.: `leitor-pdf-abc.vercel.app`). Rode:
   ```bash
   node scripts/set-domain.mjs leitor-pdf-abc.vercel.app
   git commit -am "Configura domínio" && git push
   ```
   Isso troca `SEU-DOMINIO.vercel.app` em `index.html`, `robots.txt` e `sitemap.xml`.
4. **Google:** cadastre o site no [Search Console](https://search.google.com/search-console) e envie o `sitemap.xml`.

## Tecnologias

HTML, CSS e JavaScript puro (sem build). Bibliotecas incluídas em `assets/vendor/`:
[PDF.js](https://github.com/mozilla/pdf.js) (Apache-2.0) e [pdf-lib](https://github.com/Hopding/pdf-lib) (MIT). Veja `THIRD_PARTY_LICENSES.md`.

## Licença

MIT. Veja `LICENSE`.
