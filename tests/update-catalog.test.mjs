import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildSite, loadCatalog, loadCollections, loadPublishedCatalog, normalizeProducts } from '../scripts/update-catalog.mjs';

function product(overrides = {}) {
    return {
        id: '123', name: 'Caixa Abraço', description: 'Pães artesanais\nUm cartão especial.',
        currency: 'BRL', price: '278000', product_availability: 'IN_STOCK',
        status_info: { status: 'APPROVED' }, media: { images: [] }, ...overrides,
    };
}

function page(products, after = null) {
    return { data: { xwa_product_catalog_get_product_catalog: {
        product_catalog: { products, paging: { after } },
    } } };
}

function collectionsPage(collections, after = null) {
    return { data: { xwa_product_catalog_get_collections: { collections, paging: { after } } } };
}

function collection(overrides = {}) {
    return { id: '10', name: 'Caixas De Doces', products: [{ id: '123' }], ...overrides };
}

function withCollections(fetchImpl, collections = []) {
    return async (url, options) => options?.body && JSON.parse(options.body).variables.request.collections
        ? Response.json(collectionsPage(collections)) : fetchImpl(url, options);
}

function publishedCatalog() {
    const image = 'assets/imgs/catalog/123-first.jpg';
    return {
        updatedAt: '2026-10-31T17:33:43.056Z', whatsappNumber: '554999272840',
        products: [{ id: '123', name: 'Caixa Abraço', description: 'Pães e café', currency: 'BRL',
            priceAmount1000: 278000, available: true, image,
            images: [image, 'assets/imgs/catalog/123-second.jpg'] }],
        collections: [{ id: '10', name: 'Caixas De Doces', productIds: ['123'] }],
    };
}

test('published mode preserves the snapshot and combines local code with deduplicated published photos', async t => {
    const root = await fixture(t);
    const catalog = publishedCatalog();
    catalog.products.push({ ...catalog.products[0], id: '456', name: 'Outra caixa' });
    catalog.products.push({ ...catalog.products[0], id: '789', image: 'assets/icons/product-placeholder.svg',
        images: ['assets/icons/product-placeholder.svg'], priceAmount1000: null, available: false });
    const requests = [];
    const photo = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    const result = await buildSite({ root, source: 'published', fetchImpl: async (url, options) => {
        assert.equal(options.method, undefined);
        assert.equal(options.body, undefined);
        assert.ok(url.startsWith('https://dasbrotartesanal.com.br/'));
        requests.push(url);
        if (url.endsWith('/catalog.json')) return Response.json(catalog);
        assert.ok(catalog.products[0].images.some(image => url.endsWith('/' + image)));
        return new Response(photo);
    } });
    assert.equal(result.source, 'published');
    assert.equal(result.updatedAt, catalog.updatedAt);
    assert.equal(result.productCount, 3);
    assert.equal(result.collectionCount, 1);
    assert.equal(result.imageCount, 2);
    assert.equal(requests.length, 3);
    assert.deepEqual(JSON.parse(await readFile(path.join(root, 'dist/catalog.json'), 'utf8')), catalog);
    for (const image of catalog.products[0].images) {
        assert.deepEqual(await readFile(path.join(root, 'dist', image)), photo);
    }
    for (const name of ['index.html', 'catalogo/index.html', 'main.css', 'catalog.js', 'CNAME']) {
        assert.equal(await readFile(path.join(root, 'dist', name), 'utf8'), name);
    }
    assert.equal(await readFile(path.join(root, 'dist/.nojekyll'), 'utf8'), '');
    assert.equal((await readdir(path.join(root, 'dist'))).includes('private.txt'), false);
    assert.equal((await readdir(root)).some(name => name.startsWith('.catalog-build-')), false);
});

test('published mode supports snapshots with only image and no collections', async t => {
    const root = await fixture(t);
    const catalog = publishedCatalog();
    delete catalog.products[0].images;
    delete catalog.collections;
    const requests = [];
    const result = await buildSite({ root, source: 'published', fetchImpl: async url => {
        requests.push(url);
        return url.endsWith('/catalog.json') ? Response.json(catalog)
            : new Response(Buffer.from([0xff, 0xd8, 0xff, 0x00]));
    } });
    assert.equal(requests.length, 2);
    assert.equal(result.collectionCount, 0);
    assert.deepEqual(JSON.parse(await readFile(path.join(root, 'dist/catalog.json'), 'utf8')), catalog);
});

test('published catalogs reject invalid metadata, products, paths and collection references before downloads', async () => {
    const invalid = [
        catalog => { catalog.products = []; },
        catalog => { catalog.updatedAt = 'invalid'; },
        catalog => { catalog.whatsappNumber = 'another business'; },
        catalog => { catalog.products.push({ ...catalog.products[0] }); },
        catalog => { catalog.products[0].priceAmount1000 = -1; },
        catalog => { catalog.products[0].available = 'true'; },
        catalog => { catalog.products[0].name = ''; },
        catalog => { catalog.products[0].images = []; },
        catalog => { catalog.products[0].images = [catalog.products[0].image, null]; },
        catalog => { catalog.products[0].image = 'assets/imgs/catalog/mismatched.jpg'; },
        catalog => { catalog.collections = {}; },
        catalog => { catalog.collections[0].productIds = ['unknown']; },
        catalog => { catalog.collections.push(catalog.collections[0]); },
    ];
    for (const image of ['assets/imgs/catalog/../../main.css', 'assets/imgs/catalog/%2e%2e/photo.jpg',
        'assets/imgs/catalog/photo.jpg?query=1', 'https://example.com/photo.jpg', '/assets/imgs/catalog/photo.jpg',
        'assets/imgs/catalog/photo.svg', 'assets/imgs/catalog/../photo.jpg', 'assets/imgs/catalog/dir/photo.jpg']) {
        invalid.push(catalog => { catalog.products[0].image = image; catalog.products[0].images = [image]; });
    }
    for (const mutate of invalid) {
        const catalog = publishedCatalog();
        mutate(catalog);
        let requests = 0;
        await assert.rejects(loadPublishedCatalog({ fetchImpl: async () => {
            requests++;
            return Response.json(catalog);
        } }), /Invalid published/);
        assert.equal(requests, 1);
    }
});

test('published download and validation failures preserve the previous site without falling back to WhatsApp', async t => {
    const root = await fixture(t);
    const valid = publishedCatalog();
    const scenarios = [
        async () => new Response('Not found', { status: 404 }),
        async () => new Response('<html>Not JSON</html>'),
        async () => Response.json({ ...valid, products: [] }),
        async url => url.endsWith('/catalog.json') ? Response.json(valid) : new Response('Not an image'),
        async url => url.endsWith('/catalog.json') ? Response.json(valid)
            : url.endsWith('/123-first.jpg') ? new Response(Buffer.from([0xff, 0xd8, 0xff, 0x00]))
                : new Response('Missing second photo', { status: 404 }),
        async url => url.endsWith('/catalog.json') ? Response.json(valid)
            : new Response(Buffer.from('RIFF0000WEBP')),
    ];
    for (const scenario of scenarios) {
        await assert.rejects(buildSite({ root, source: 'published', fetchImpl: async (url, options) => {
            assert.ok(url.startsWith('https://dasbrotartesanal.com.br/'));
            assert.equal(options.body, undefined);
            return scenario(url);
        } }));
        assert.equal(await readFile(path.join(root, 'dist/catalog.json'), 'utf8'), 'previous snapshot');
        assert.equal((await readdir(root)).some(name => name.startsWith('.catalog-build-')), false);
    }
});

test('unknown sources fail before network or filesystem changes', async () => {
    await assert.rejects(buildSite({ source: 'invalid', fetchImpl: () => assert.fail('No request expected') }), /Source must/);
});

test('follows pagination, preserves order and deduplicates by ID', async () => {
    const cursors = [];
    const products = await loadCatalog({ fetchImpl: async (url, options) => {
        const cursor = JSON.parse(options.body).variables.request.product_catalog.after;
        cursors.push(cursor);
        return Response.json(cursor === null
            ? page([product(), product({ id: '456' })], 'next')
            : page([product({ id: '456' }), product({ id: '789' })]));
    } });
    assert.deepEqual(cursors, [null, 'next']);
    assert.deepEqual(products.map(item => item.id), ['123', '456', '789']);
});

test('stops pagination when the service repeats a cursor', async () => {
    await assert.rejects(loadCatalog({ fetchImpl: async () => Response.json(page([product()], 'repeated')) }), /repeated cursor/);
});

test('collection pagination preserves order, merges duplicates and excludes unpublished product IDs', async () => {
    const cursors = [];
    const result = await loadCollections([{ id: '123' }, { id: '456' }], { fetchImpl: async (url, options) => {
        const payload = JSON.parse(options.body);
        assert.equal(payload.doc_id, '9430970660362540');
        const params = payload.variables.request.collections;
        assert.equal(params.biz_jid, '554999272840@s.whatsapp.net');
        cursors.push(params.after);
        return Response.json(params.after === null ? collectionsPage([
            collection({ products: [{ id: '123' }, { id: 'hidden' }, { id: '123' }] }),
            collection({ id: 'rejected', status_info: { status: 'REJECTED' } }),
        ], 'next') : collectionsPage([
            collection({ products: [{ id: '456' }] }),
            collection({ id: '20', name: 'Caixas De Café Da Manhã', products: [{ id: '456' }] }),
        ]));
    } });
    assert.deepEqual(cursors, [null, 'next']);
    assert.deepEqual(result, [
        { id: '10', name: 'Caixas De Doces', productIds: ['123', '456'] },
        { id: '20', name: 'Caixas De Café Da Manhã', productIds: ['456'] },
    ]);
});

test('accepts no collections but rejects malformed, repeated or potentially truncated collection responses', async () => {
    const products = [{ id: '123' }];
    assert.deepEqual(await loadCollections(products, {
        fetchImpl: async () => Response.json(collectionsPage([])),
    }), []);
    for (const response of [
        { errors: [{ message: 'Collections unavailable' }] },
        { data: {} },
        collectionsPage([collection({ products: null })]),
        collectionsPage([collection({ products: Array.from({ length: 50 }, () => ({ id: '123' })) })]),
    ]) {
        await assert.rejects(loadCollections(products, { fetchImpl: async () => Response.json(response) }));
    }
    await assert.rejects(loadCollections(products, {
        fetchImpl: async () => Response.json(collectionsPage([], 'repeated')),
    }), /repeated cursor/);
});

test('rejects GraphQL errors, unknown formats and invalid JSON even with HTTP 200', async () => {
    for (const response of [
        { errors: [{ message: 'Unknown document' }] },
        { error: { message: 'Invalid token' } },
        { data: {} },
    ]) {
        await assert.rejects(loadCatalog({ fetchImpl: async () => Response.json(response) }));
    }
    await assert.rejects(loadCatalog({ fetchImpl: async () => new Response('<html>Error</html>') }), /valid JSON/);
});

test('filters hidden and rejected products while retaining unavailable products', () => {
    const result = normalizeProducts([
        product({ id: '1', is_hidden: 'ISHIDDEN_TRUE' }),
        product({ id: '2', is_hidden: true }),
        product({ id: '3', is_sanctioned: true }),
        product({ id: '4', status_info: { status: 'REJECTED' } }),
        product({ id: '5', product_availability: 'OUT_OF_STOCK' }),
    ]);
    assert.deepEqual(result.map(item => [item.id, item.available]), [['5', false]]);
});

test('preserves text and prices in thousandths, including sale, missing and zero prices', () => {
    const result = normalizeProducts([
        product({ description: '<b>Chocolate</b>\nCafé ☕', price: '12500' }),
        product({ id: '2', price: null }),
        product({ id: '3', sale_price: '90000', price: '100000' }),
        product({ id: '4', price: '0' }),
    ]);
    assert.equal(result[0].description, '<b>Chocolate</b>\nCafé ☕');
    assert.deepEqual(result.map(item => item.priceAmount1000), [12500, null, 90000, 0]);
    assert.equal(new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })
        .format(result[0].priceAmount1000 / 1000).replace(/\s/g, ' '), 'R$ 12,50');
    assert.throws(() => normalizeProducts([product({ price: '-1000' })]), /price/);
    assert.throws(() => normalizeProducts([product({ price: '9007199254740992' })]), /price/);
    assert.throws(() => normalizeProducts([product({ name: '' })]), /Invalid data/);
});

test('normalizes every image in order, deduplicates URLs and rejects invalid photos', () => {
    const first = 'https://mmg.whatsapp.net/first';
    const second = 'https://mmg.whatsapp.net/second';
    const result = normalizeProducts([product({ media: { images: [
        { original_image_url: first }, { request_image_url: second }, { original_image_url: first },
    ] } })]);
    assert.deepEqual(result[0].imageUrls, [first, second]);
    assert.deepEqual(normalizeProducts([product()])[0].imageUrls, []);
    assert.deepEqual(normalizeProducts([product({ media: { images: null } })])[0].imageUrls, []);
    for (const images of [[{ original_image_url: 'http://example.com/image.jpg' }], [{}]]) {
        assert.throws(() => normalizeProducts([product({ media: { images } })]));
    }
    assert.throws(() => normalizeProducts([product({ media: { images: 'invalid' } })]), /Invalid images/);
});

async function fixture(t) {
    const root = await mkdtemp(path.join(tmpdir(), 'das-brot-catalog-test-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, 'assets/icons'), { recursive: true });
    await mkdir(path.join(root, 'catalogo'));
    for (const name of ['index.html', 'catalogo/index.html', 'main.css', 'catalog.js', 'CNAME']) {
        await writeFile(path.join(root, name), name);
    }
    await writeFile(path.join(root, 'assets/icons/product-placeholder.svg'), '<svg/>');
    await mkdir(path.join(root, 'dist'));
    await writeFile(path.join(root, 'dist/catalog.json'), 'previous snapshot');
    await writeFile(path.join(root, 'private.txt'), 'do not publish');
    return root;
}

test('builds a complete site with local images and replaces the previous snapshot', async t => {
    const root = await fixture(t);
    const photoUrl = 'https://mmg.whatsapp.net/photo';
    const secondPhotoUrl = 'https://mmg.whatsapp.net/second-photo';
    const image = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
    const secondImage = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01]);
    const result = await buildSite({ root, fetchImpl: withCollections(async url => [photoUrl, secondPhotoUrl].includes(url)
        ? new Response(url === photoUrl ? image : secondImage)
        : Response.json(page([
            product({ media: { images: [{ original_image_url: photoUrl }, { original_image_url: secondPhotoUrl }] } }),
            product({ id: '456' }),
        ])), [collection()]),
    });
    assert.equal(result.productCount, 2);
    assert.equal(result.imageCount, 2);
    assert.equal(result.collectionCount, 1);
    const catalog = JSON.parse(await readFile(path.join(root, 'dist/catalog.json'), 'utf8'));
    assert.deepEqual(catalog.collections, [{ id: '10', name: 'Caixas De Doces', productIds: ['123'] }]);
    assert.match(catalog.products[0].image, /^assets\/imgs\/catalog\/123-[a-f0-9]+\.jpg$/);
    assert.deepEqual(await readFile(path.join(root, 'dist', catalog.products[0].image)), image);
    assert.equal(catalog.products[0].images.length, 2);
    assert.equal(catalog.products[0].images[0], catalog.products[0].image);
    assert.deepEqual(await readFile(path.join(root, 'dist', catalog.products[0].images[1])), secondImage);
    assert.equal(catalog.products[1].image, 'assets/icons/product-placeholder.svg');
    assert.deepEqual(catalog.products[1].images, ['assets/icons/product-placeholder.svg']);
    assert.equal('imageUrl' in catalog.products[0], false);
    assert.equal('imageUrls' in catalog.products[0], false);
    assert.equal(await readFile(path.join(root, 'dist/.nojekyll'), 'utf8'), '');
    assert.equal(await readFile(path.join(root, 'dist/CNAME'), 'utf8'), 'CNAME');
    assert.equal(await readFile(path.join(root, 'dist/catalogo/index.html'), 'utf8'), 'catalogo/index.html');
    assert.equal((await readdir(path.join(root, 'dist'))).includes('private.txt'), false);
    assert.equal((await readdir(root)).some(name => name.startsWith('.catalog-build-')), false);
});

test('empty catalogs, HTTP errors and invalid images preserve the previous snapshot', async t => {
    const root = await fixture(t);
    const photo = product({ media: { images: [{ original_image_url: 'https://mmg.whatsapp.net/photo' }] } });
    const scenarios = [
        async () => Response.json(page([])),
        async () => new Response('Temporary error', { status: 503 }),
        async url => url.includes('/photo') ? new Response('<html>Not an image</html>') : Response.json(page([photo])),
        async url => url.includes('/photo') ? new Response('Failed', { status: 404 }) : Response.json(page([photo])),
    ];
    for (const fetchImpl of scenarios) {
        await assert.rejects(buildSite({ root, fetchImpl: withCollections(fetchImpl) }));
        assert.equal(await readFile(path.join(root, 'dist/catalog.json'), 'utf8'), 'previous snapshot');
        assert.equal((await readdir(root)).some(name => name.startsWith('.catalog-build-')), false);
    }
});

test('collection query failures preserve the previous snapshot before any image download', async t => {
    const root = await fixture(t);
    let imageRequested = false;
    await assert.rejects(buildSite({ root, fetchImpl: async (url, options) => {
        if (!options?.body) imageRequested = true;
        const request = options?.body && JSON.parse(options.body).variables.request;
        return Response.json(request?.collections
            ? { errors: [{ message: 'Collections unavailable' }] }
            : page([product()]));
    } }), /GraphQL/);
    assert.equal(imageRequested, false);
    assert.equal(await readFile(path.join(root, 'dist/catalog.json'), 'utf8'), 'previous snapshot');
});

test('failure to download a secondary photo preserves the previous snapshot', async t => {
    const root = await fixture(t);
    const downloads = [];
    await assert.rejects(buildSite({ root, fetchImpl: withCollections(async (url, options) => {
        if (options?.body) return Response.json(page([product({ media: { images: [
            { original_image_url: 'https://mmg.whatsapp.net/first' },
            { original_image_url: 'https://mmg.whatsapp.net/second' },
        ] } })]));
        downloads.push(url);
        return url.endsWith('/first') ? new Response(Buffer.from([0xff, 0xd8, 0xff, 0x00]))
            : new Response('Missing photo', { status: 404 });
    }) }), /HTTP 404/);
    assert.equal(downloads[0], 'https://mmg.whatsapp.net/first');
    assert.ok(downloads.includes('https://mmg.whatsapp.net/second'));
    assert.equal(await readFile(path.join(root, 'dist/catalog.json'), 'utf8'), 'previous snapshot');
    assert.equal((await readdir(root)).some(name => name.startsWith('.catalog-build-')), false);
});
