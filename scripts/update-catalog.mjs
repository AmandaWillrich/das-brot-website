import { createHash } from 'node:crypto';
import { appendFile, cp, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

// Internal WhatsApp Web endpoint. This is a public app token, not a personal credential.
export const catalogConfig = {
    endpoint: 'https://graph.whatsapp.com/graphql/catalog',
    appToken: process.env.WHATSAPP_APP_TOKEN || 'WA|787118555984857|7bb1544a3599aa180ac9a3f7688ba243',
    documentId: process.env.WHATSAPP_CATALOG_DOC_ID || '30445081048424116',
    collectionsDocumentId: process.env.WHATSAPP_COLLECTIONS_DOC_ID || '9430970660362540',
    number: '554999272840',
    publishedSiteUrl: 'https://dasbrotartesanal.com.br/',
};

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const publicFiles = ['index.html', 'catalogo', 'main.css', 'catalog.js', 'assets', 'CNAME'];
const maximumBytes = 15 * 1024 * 1024;
const placeholderImage = 'assets/icons/product-placeholder.svg';

export async function loadPublishedCatalog({ config = catalogConfig, fetchImpl = fetch } = {}) {
    const bytes = await requestBytes(new URL('catalog.json', config.publishedSiteUrl).href, {
        headers: { 'Cache-Control': 'no-cache' },
    }, fetchImpl);
    let catalog;
    try {
        catalog = JSON.parse(bytes.toString('utf8'));
    } catch {
        throw new Error('The published catalog is not valid JSON.');
    }
    if (!catalog || catalog.whatsappNumber !== config.number
        || typeof catalog.updatedAt !== 'string' || Number.isNaN(Date.parse(catalog.updatedAt))
        || !Array.isArray(catalog.products) || !catalog.products.length) {
        throw new Error('Invalid published catalog metadata or products.');
    }
    const ids = new Set();
    for (const product of catalog.products) {
        const images = product?.images ?? [product?.image];
        if (!product || typeof product.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(product.id)
            || ids.has(product.id) || typeof product.name !== 'string' || !product.name.trim()
            || typeof product.description !== 'string' || typeof product.available !== 'boolean'
            || typeof product.currency !== 'string' || !/^[A-Z]{3}$/.test(product.currency)
            || (product.priceAmount1000 != null && (!Number.isSafeInteger(product.priceAmount1000)
                || product.priceAmount1000 < 0))
            || !Array.isArray(images) || !images.length || product.image !== images[0]) {
            throw new Error('Invalid published product data.');
        }
        for (const image of images) {
            if (typeof image !== 'string' || !(image === placeholderImage
                || /^assets\/imgs\/catalog\/[a-zA-Z0-9_-]+\.(jpg|png|webp)$/.test(image))) {
                throw new Error('Invalid published image path.');
            }
        }
        ids.add(product.id);
    }
    const collectionIds = new Set();
    const collections = catalog.collections ?? [];
    if (!Array.isArray(collections)) throw new Error('Invalid published collections.');
    for (const collection of collections) {
        if (!collection || typeof collection.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(collection.id)
            || collectionIds.has(collection.id) || typeof collection.name !== 'string' || !collection.name.trim()
            || !Array.isArray(collection.productIds) || collection.productIds.some(id => !ids.has(id))) {
            throw new Error('Invalid published collection data.');
        }
        collectionIds.add(collection.id);
    }
    return catalog;
}

async function requestBytes(url, options, fetchImpl) {
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const response = await fetchImpl(url, {
                ...options,
                signal: AbortSignal.timeout(30000),
            });
            if (!response.ok) {
                await response.body?.cancel();
                throw new Error(`Request returned HTTP ${response.status}.`);
            }
            const chunks = [];
            let size = 0;
            for await (const chunk of response.body) {
                size += chunk.length;
                if (size > maximumBytes) {
                    throw new Error('Response exceeded the 15 MB limit.');
                }
                chunks.push(chunk);
            }
            return Buffer.concat(chunks);
        } catch (error) {
            if (attempt === 2) throw error;
            await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
        }
    }
}

async function queryCatalog(request, documentId, config, fetchImpl) {
    const bytes = await requestBytes(config.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            access_token: config.appToken,
            doc_id: documentId,
            lang: 'pt_BR',
            variables: { request },
        }),
    }, fetchImpl);
    let result;
    try {
        result = JSON.parse(bytes.toString('utf8'));
    } catch {
        throw new Error('WhatsApp did not return valid JSON.');
    }
    if (result.errors?.length || result.error) {
        throw new Error('WhatsApp returned a GraphQL error. Check the public app token and doc_id.');
    }
    return result;
}

export async function loadCatalog({ config = catalogConfig, fetchImpl = fetch } = {}) {
    const products = new Map();
    const cursors = new Set();
    let after = null;
    for (let page = 0; page < 100; page++) {
        const result = await queryCatalog({ product_catalog: {
            jid: `${config.number}@s.whatsapp.net`,
            allow_shop_source: 'ALLOWSHOPSOURCE_TRUE',
            width: '800', height: '800', limit: '50', after,
            catalog_session_id: null,
            direct_connection_encrypted_info: null,
            variant_info_fields: null,
            variant_thumbnail_height: null,
            variant_thumbnail_width: null,
        } }, config.documentId, config, fetchImpl);
        const catalog = result.data?.xwa_product_catalog_get_product_catalog?.product_catalog;
        if (!Array.isArray(catalog?.products)) {
            throw new Error('Unknown catalog format. The WhatsApp response may have changed.');
        }
        for (const product of catalog.products) {
            if (typeof product?.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(product.id)) {
                throw new Error('Product has no valid identifier.');
            }
            if (!products.has(product.id)) products.set(product.id, product);
        }
        const next = catalog.paging?.after;
        if (next == null || next === '') {
            return normalizeProducts([...products.values()]);
        }
        if (typeof next !== 'string' || cursors.has(next)) {
            throw new Error('Invalid pagination or repeated cursor; publication stopped.');
        }
        cursors.add(next);
        after = next;
    }
    throw new Error('Catalog exceeded the 100-page limit.');
}

export async function loadCollections(products, { config = catalogConfig, fetchImpl = fetch } = {}) {
    const publishedIds = new Set(products.map(product => product.id));
    const collections = new Map();
    const cursors = new Set();
    let after = null;
    for (let page = 0; page < 100; page++) {
        const result = await queryCatalog({ collections: {
            biz_jid: `${config.number}@s.whatsapp.net`,
            collection_limit: '50', item_limit: '50', width: 100, height: 100, after,
            direct_connection_encrypted_info: null,
            variant_info_fields: null,
            variant_thumbnail_height: null,
            variant_thumbnail_width: null,
        } }, config.collectionsDocumentId, config, fetchImpl);
        const data = result.data?.xwa_product_catalog_get_collections;
        if (!Array.isArray(data?.collections)) {
            throw new Error('Unknown collections format. The WhatsApp response may have changed.');
        }
        for (const collection of data.collections) {
            if (collection.status_info?.status && collection.status_info.status !== 'APPROVED') continue;
            if (typeof collection.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(collection.id)
                || typeof collection.name !== 'string' || !collection.name.trim()
                || !Array.isArray(collection.products)) {
                throw new Error('Invalid collection data.');
            }
            // The endpoint exposes no per-collection product cursor. Avoid publishing a truncated filter.
            if (collection.products.length >= 50) {
                throw new Error(`Collection ${collection.id} reached the item limit; completeness cannot be confirmed.`);
            }
            const existing = collections.get(collection.id) || {
                id: collection.id, name: collection.name.trim(), productIds: new Set(),
            };
            for (const product of collection.products) {
                if (typeof product?.id !== 'string') throw new Error('Invalid collection product identifier.');
                if (publishedIds.has(product.id)) existing.productIds.add(product.id);
            }
            collections.set(collection.id, existing);
        }
        const next = data.paging?.after;
        if (next == null || next === '') {
            return [...collections.values()].map(collection => ({
                ...collection, productIds: [...collection.productIds],
            }));
        }
        if (typeof next !== 'string' || cursors.has(next)) {
            throw new Error('Invalid collection pagination or repeated cursor; publication stopped.');
        }
        cursors.add(next);
        after = next;
    }
    throw new Error('Collections exceeded the 100-page limit.');
}

function parsePrice(value) {
    if (value == null || value === '') return null;
    if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value))) {
        throw new Error('Invalid catalog price.');
    }
    return Number(value);
}

export function normalizeProducts(rawProducts) {
    const products = rawProducts.filter(product => {
        const hidden = product.is_hidden;
        const sanctioned = product.is_sanctioned;
        const status = product.status_info?.status;
        const price = product.sale_price ?? product.price;
        const missingPrice = price == null || price === '';
        const missingCurrency = product.currency == null || product.currency === '';
        return ![true, 'true', 'ISHIDDEN_TRUE'].includes(hidden)
            && ![true, 'true'].includes(sanctioned)
            && (!status || status === 'APPROVED')
            // Informational catalog entries can omit both price and currency.
            && !(missingPrice && missingCurrency);
    }).map(product => {
        if (typeof product.name !== 'string' || !product.name.trim()
            || (product.description != null && typeof product.description !== 'string')
            || !/^[A-Z]{3}$/.test(product.currency || '')) {
            throw new Error(`Invalid data for product ${product.id}.`);
        }
        const photos = product.media?.images ?? [];
        if (!Array.isArray(photos)) throw new Error(`Invalid images for product ${product.id}.`);
        const imageUrls = [...new Set(photos.map(photo => {
            const url = photo?.original_image_url || photo?.request_image_url;
            if (typeof url !== 'string' || new URL(url).protocol !== 'https:') {
                throw new Error(`Invalid image URL for product ${product.id}.`);
            }
            return url;
        }))];
        return {
            id: product.id,
            name: product.name.trim(),
            description: product.description || '',
            currency: product.currency,
            priceAmount1000: parsePrice(product.sale_price ?? product.price),
            available: product.product_availability === 'IN_STOCK',
            imageUrls,
        };
    });
    if (!products.length) {
        throw new Error('No public products found. The previous site will be preserved.');
    }
    return products;
}

function imageExtension(bytes) {
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
    if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
    if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
    throw new Error('An image did not return a valid JPEG, PNG or WebP file.');
}

export async function buildSite({ root = projectRoot, config = catalogConfig, fetchImpl = fetch, source = 'whatsapp' } = {}) {
    if (!['whatsapp', 'published'].includes(source)) throw new Error('Source must be whatsapp or published.');
    let products;
    let catalog;
    if (source === 'published') {
        catalog = await loadPublishedCatalog({ config, fetchImpl });
    } else {
        products = await loadCatalog({ config, fetchImpl });
        catalog = { whatsappNumber: config.number, collections: await loadCollections(products, { config, fetchImpl }) };
    }
    const staging = await mkdtemp(path.join(root, '.catalog-build-'));
    const output = path.join(root, 'dist');
    const backup = `${staging}-previous`;
    let movedPrevious = false;
    let imageCount = 0;
    try {
        for (const file of publicFiles) {
            await cp(path.join(root, file), path.join(staging, file), { recursive: true });
        }
        await mkdir(path.join(staging, 'assets/imgs/catalog'), { recursive: true });
        if (source === 'published') {
            const images = new Set(catalog.products.flatMap(product => product.images ?? [product.image]));
            for (const image of images) {
                if (image === placeholderImage) continue;
                const bytes = await requestBytes(new URL(image, config.publishedSiteUrl).href, {}, fetchImpl);
                if (!image.endsWith(`.${imageExtension(bytes)}`)) throw new Error('Published image format does not match its path.');
                await writeFile(path.join(staging, image), bytes);
                imageCount++;
            }
        } else {
            const publishedProducts = [];
            for (const { imageUrls, ...product } of products) {
                const images = [];
                for (const imageUrl of imageUrls) {
                    const bytes = await requestBytes(imageUrl, {}, fetchImpl);
                    const extension = imageExtension(bytes);
                    const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
                    const image = `assets/imgs/catalog/${product.id}-${hash}.${extension}`;
                    await writeFile(path.join(staging, image), bytes);
                    if (!images.includes(image)) images.push(image);
                    imageCount++;
                }
                if (!images.length) images.push(placeholderImage);
                publishedProducts.push({ ...product, image: images[0], images });
            }
            catalog.products = publishedProducts;
            catalog.updatedAt = new Date().toISOString();
        }
        await writeFile(path.join(staging, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`);
        await writeFile(path.join(staging, '.nojekyll'), '');
        // Replace the previous directory only after all downloads have completed.
        try {
            await rename(output, backup);
            movedPrevious = true;
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        try {
            await rename(staging, output);
        } catch (error) {
            if (movedPrevious) await rename(backup, output);
            throw error;
        }
        if (movedPrevious) await rm(backup, { recursive: true, force: true });
        return { source, productCount: catalog.products.length, collectionCount: (catalog.collections ?? []).length,
            imageCount, updatedAt: catalog.updatedAt };
    } finally {
        await rm(staging, { recursive: true, force: true });
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const { values } = parseArgs({ options: { source: { type: 'string', default: 'whatsapp' } } });
        const result = await buildSite({ source: values.source });
        console.log(`Site prepared in dist/ from ${result.source}: ${result.productCount} products, ${result.collectionCount} collections and ${result.imageCount} images.`);
        if (process.env.GITHUB_STEP_SUMMARY) {
            await appendFile(process.env.GITHUB_STEP_SUMMARY,
                `## Catalog prepared\n\n- Source: ${result.source}\n- Products: ${result.productCount}\n- Collections: ${result.collectionCount}\n- Images downloaded: ${result.imageCount}\n- Catalog updated at: ${result.updatedAt}\n\nDeployment runs in the next step.\n`);
        }
    } catch (error) {
        console.error(`Update stopped: ${error.message}`);
        process.exitCode = 1;
    }
}
