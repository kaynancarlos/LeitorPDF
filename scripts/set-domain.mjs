// Troca o endereço de exemplo (SEU-DOMINIO.vercel.app) pelo seu endereço real
// em index.html, robots.txt e sitemap.xml.
// Uso:  node scripts/set-domain.mjs meu-leitor.vercel.app
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const domain = (process.argv[2] || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) {
  console.error('Informe o domínio. Exemplo: node scripts/set-domain.mjs meu-leitor.vercel.app');
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const file of ['index.html', 'robots.txt', 'sitemap.xml']) {
  const p = path.join(root, file);
  const text = await readFile(p, 'utf8');
  await writeFile(p, text.replaceAll('SEU-DOMINIO.vercel.app', domain));
  console.log(`Atualizado: ${file}`);
}
console.log(`Pronto! Domínio configurado: https://${domain}`);
