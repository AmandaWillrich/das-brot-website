# Das Brot

Static website and product catalog for Das Brot, hosted on GitHub Pages.
Catalog data and photos come from the public WhatsApp Business catalog.

## Local preview

Use Node.js 24 LTS and Python 3. No dependency installation is required.

```bash
node scripts/update-catalog.mjs
python3 -m http.server 8000 --directory dist
```

Open http://localhost:8000/ or http://localhost:8000/catalogo/.
The catalog update requires an internet connection. The generated `dist/` folder is ignored by Git.
Run the script again after changing the website files.

## Publish

1. Push the website files to the public repository's default branch.
2. In **Settings → Pages → Source**, select **GitHub Actions**.
3. Run **Actions → Update catalog → Run workflow** on the default branch.
4. Choose `whatsapp` for the first publication or to refresh products and photos.
5. Configure `dasbrotartesanal.com.br` as the custom domain in Pages and check its DNS records.

For interface-only updates, choose `published` to reuse the catalog already available at the custom domain. This requires a working published catalog.
Publishing is manual; pushing code alone does not deploy the website.
If catalog preparation fails, the existing publication is preserved.

## Tests

```bash
node --test tests/*.test.mjs
```

Keep customer-facing content in Portuguese. The catalog uses an unofficial WhatsApp endpoint that may require maintenance if WhatsApp changes it.
