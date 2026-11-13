import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../catalog.js', import.meta.url), 'utf8');

// Minimal DOM for testing loading and generated content without npm dependencies.
class Element {
    constructor(tag) {
        this.tag = tag;
        this.children = [];
        this.attributes = {};
        this.hidden = true;
        this.textContent = '';
        this.open = false;
        this.listeners = new Map();
        this.style = {
            setProperty(name, value) { this[name] = value; },
            removeProperty(name) { delete this[name]; },
        };
        this.scrollHeight = 500;
        this.clientWidth = 500;
        this.scrollWidth = 500;
        this.scrollLeft = 0;
        this.scrollCalls = [];
        const classes = new Set();
        this.classList = {
            add: name => classes.add(name),
            remove: name => classes.delete(name),
            contains: name => classes.has(name),
        };
    }
    append(...children) {
        this.children.push(...children);
        for (const child of children) child.parentElement = this;
    }
    remove() {
        if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
        this.parentElement = null;
    }
    replaceChildren(...children) {
        this.children = children.flatMap(child => child.tag === '#fragment' ? child.children : [child]);
        for (const child of this.children) child.parentElement = this;
    }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(type, listener) {
        const listeners = this.listeners.get(type) || [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
    }
    dispatch(type, event = {}) {
        const emitted = { target: this, defaultPrevented: false,
            preventDefault() { this.defaultPrevented = true; }, ...event };
        for (const listener of this.listeners.get(type) || []) listener(emitted);
        return emitted;
    }
    querySelector(selector) {
        for (const child of this.children) {
            if (selector.startsWith('.') ? child.className?.split(' ').includes(selector.slice(1)) : child.tag === selector) return child;
            const descendant = child.querySelector(selector);
            if (descendant) return descendant;
        }
    }
    showModal() { this.open = true; this.modalShown = true; }
    close() {
        if (!this.open) return;
        this.open = false;
        this.dispatch('close');
    }
    focus(options) { this.ownerDocument.activeElement = this; this.focusOptions = options; }
    setPointerCapture(id) { this.capturedPointer = id; }
    scrollBy(options) {
        this.scrollCalls.push(options);
        this.scrollLeft = Math.max(0, Math.min(this.scrollWidth - this.clientWidth, this.scrollLeft + options.left));
        this.dispatch('scroll');
    }
    getBoundingClientRect() {
        if (this.parentElement?.isFilterTrack) {
            const track = this.parentElement;
            const left = 108 + track.children.indexOf(this) * 120 - track.scrollLeft;
            return { left, right: left + 112 };
        }
        return { left: 100, right: 600, top: 100, bottom: 600, height: 100 };
    }
}

const sample = {
    updatedAt: '2026-10-31T16:43:40.561Z',
    whatsappNumber: '554999272840',
    products: [{
        id: '123', name: 'Caixa <Abraço> & Café', description: '<script>alert(1)</script>\nPães e café ☕',
        currency: 'BRL', priceAmount1000: 12500, available: true,
        image: 'assets/imgs/catalog/123-abcdef.jpg',
    }],
};

const flushMotion = async () => {
    for (let count = 0; count < 6; count++) await Promise.resolve();
};

export async function renderCatalog({ href, request, width = 600, motion = false, reduced = false, backdropMotion = true,
    filterLayout = { width: 500, contentWidth: 500 } }) {
    const animations = [];
    const nodes = Object.fromEntries(['catalog-grid', 'catalog-status', 'catalog-updated', 'catalog-error', 'catalog-filters',
        'catalog-filter-navigation', 'catalog-filters-previous', 'catalog-filters-next']
        .map(id => [id, new Element('div')]));
    const navigation = nodes['catalog-filter-navigation'];
    const filters = nodes['catalog-filters'];
    navigation.clientWidth = filterLayout.width;
    filters.scrollWidth = filterLayout.contentWidth;
    filters.isFilterTrack = true;
    Object.defineProperty(filters, 'clientWidth', { get: () => navigation.clientWidth });
    filters.getBoundingClientRect = () => ({ left: 100, right: 100 + filters.clientWidth });
    nodes['catalog-updated'].append(new Element('time'));
    const requests = [];
    const errors = [];
    const document = {
        activeElement: null,
        querySelector: selector => nodes[selector.slice(1)],
        createElement: tag => {
            const node = new Element(tag);
            node.ownerDocument = document;
            if (motion) node.animate = (frames, options) => {
                let finish, reject;
                const finished = new Promise((resolve, fail) => { finish = resolve; reject = fail; });
                const animation = { node, frames, options, finished, finish,
                    effect: { pseudoElement: backdropMotion ? options.pseudoElement ?? null : null },
                    cancel() { this.canceled = true; reject(new Error('Canceled')); } };
                animations.push(animation);
                return animation;
            };
            return node;
        },
        createDocumentFragment: () => new Element('#fragment'),
    };
    document.body = document.createElement('body');
    document.documentElement = document.createElement('html');
    const layoutListeners = [];
    const resizeListeners = [];
    const observers = [];
    const motionListeners = [];
    const preference = { matches: reduced, addEventListener: (type, listener) => motionListeners.push(listener) };
    const media = {
        matches: width <= 700,
        addEventListener: (type, listener) => { if (type === 'change') layoutListeners.push(listener); },
    };
    await vm.runInNewContext(source, {
        document,
        window: {
            location: new URL(href),
            addEventListener: (type, listener) => { if (type === 'resize') resizeListeners.push(listener); },
            getComputedStyle: (node, pseudo) => pseudo
                ? { backgroundColor: 'rgba(33, 23, 19, 0.3)' }
                : { opacity: '0.5', transform: 'matrix(1, 0, 0, 1, 0, 6)' },
            matchMedia: query => {
                if (query === '(prefers-reduced-motion: reduce)') return preference;
                assert.equal(query, '(max-width: 700px)');
                return media;
            },
        },
        ResizeObserver: class {
            constructor(callback) { observers.push(callback); }
            observe() {}
        },
        fetch: async url => { requests.push(url.href); return request(url); },
        console: { error: (...args) => errors.push(args) },
        URL, AbortSignal, Intl,
    });
    return {
        nodes, requests, errors, document, animations,
        reduceMotion() {
            preference.matches = true;
            for (const listener of motionListeners) listener();
        },
        resizeFilters(nextWidth, contentWidth = filters.scrollWidth) {
            navigation.clientWidth = nextWidth;
            filters.scrollWidth = contentWidth;
            for (const callback of observers) callback();
        },
        resize(nextWidth) {
            const matches = nextWidth <= 700;
            if (matches !== media.matches) {
                media.matches = matches;
                for (const listener of layoutListeners) listener({ matches });
            }
            for (const listener of resizeListeners) listener();
        },
    };
}

test('modal entry and each exit path preserve focus and scrolling until exit completes', async () => {
    for (const method of ['button', 'escape', 'backdrop']) {
        const result = await renderCatalog({ href: 'https://example.com/catalogo/', width: 1200, motion: true,
            request: () => Response.json(sample) });
        const trigger = result.nodes['catalog-grid'].children[0].querySelector('.catalog-details-button');
        const dialog = result.document.body.querySelector('dialog');
        trigger.dispatch('click');
        assert.equal(result.animations.length, 2);
        const entrance = result.animations[0];
        assert.equal(entrance.options.duration, 200);
        assert.equal(entrance.frames[0].transform, 'translateY(12px)');
        assert.equal(result.animations[1].options.pseudoElement, '::backdrop');
        entrance.finish();
        await flushMotion();
        if (method === 'button') dialog.querySelector('.catalog-dialog-close').dispatch('click');
        if (method === 'escape') assert.equal(dialog.dispatch('cancel').defaultPrevented, true);
        if (method === 'backdrop') {
            dialog.dispatch('pointerdown', { clientX: 20, clientY: 20 });
            dialog.dispatch('click', { clientX: 20, clientY: 20 });
        }
        assert.equal(dialog.open, true);
        assert.equal(result.document.activeElement, dialog.querySelector('h2'));
        assert.equal(result.document.documentElement.classList.contains('catalog-dialog-open'), true);
        assert.ok(dialog.querySelector('img'));
        assert.equal(result.animations[2].options.duration, 160);
        assert.equal(result.animations[3].frames[1].backgroundColor, 'transparent');
        dialog.querySelector('.catalog-dialog-close').dispatch('click');
        dialog.dispatch('cancel');
        trigger.dispatch('click');
        assert.equal(result.animations.length, 4);
        result.animations[2].finish();
        await flushMotion();
        assert.equal(dialog.open, false);
        assert.equal(result.document.activeElement, trigger);
        assert.equal(result.document.documentElement.classList.contains('catalog-dialog-open'), false);
        assert.equal(dialog.querySelector('img'), undefined);
        trigger.dispatch('click');
        assert.equal(dialog.open, true);
        assert.equal(result.animations.length, 6);
        dialog.close();
        await flushMotion();
    }
});

test('closing during entry starts from the current modal and backdrop appearance', async () => {
    const result = await renderCatalog({ href: 'https://example.com/catalogo/', width: 1200, motion: true,
        request: () => Response.json(sample) });
    result.nodes['catalog-grid'].children[0].querySelector('.catalog-details-button').dispatch('click');
    const dialog = result.document.body.querySelector('dialog');
    dialog.querySelector('.catalog-dialog-close').dispatch('click');
    assert.equal(result.animations[0].canceled, true);
    assert.equal(result.animations[1].canceled, true);
    assert.equal(result.animations[2].frames[0].opacity, '0.5');
    assert.equal(result.animations[2].frames[0].transform, 'matrix(1, 0, 0, 1, 0, 6)');
    assert.equal(result.animations[3].frames[0].backgroundColor, 'rgba(33, 23, 19, 0.3)');
    result.animations[0].finish();
    await flushMotion();
    assert.equal(dialog.open, true);
    result.animations[2].finish();
    await flushMotion();
    assert.equal(dialog.open, false);
});

test('modal animation ends immediately for reduced motion and mobile breakpoint changes', async () => {
    for (const stage of ['opening', 'closing', 'mobile']) {
        const result = await renderCatalog({ href: 'https://example.com/catalogo/', width: 1200, motion: true,
            request: () => Response.json(sample) });
        const card = result.nodes['catalog-grid'].children[0];
        const trigger = card.querySelector('.catalog-details-button');
        const dialog = result.document.body.querySelector('dialog');
        trigger.dispatch('click');
        if (stage !== 'opening') dialog.querySelector('.catalog-dialog-close').dispatch('click');
        if (stage === 'mobile') result.resize(700);
        else result.reduceMotion();
        await flushMotion();
        assert.ok(result.animations.every(animation => animation.canceled));
        if (stage === 'opening') {
            assert.equal(dialog.open, true);
            dialog.querySelector('.catalog-dialog-close').dispatch('click');
        }
        assert.equal(dialog.open, false);
        assert.equal(result.document.activeElement, stage === 'mobile' ? card.querySelector('summary') : trigger);
        assert.equal(result.document.documentElement.classList.contains('catalog-dialog-open'), false);
    }
    for (const settings of [{ motion: true, reduced: true }, { motion: false }]) {
        const result = await renderCatalog({ href: 'https://example.com/catalogo/', width: 1200, ...settings,
            request: () => Response.json(sample) });
        result.nodes['catalog-grid'].children[0].querySelector('.catalog-details-button').dispatch('click');
        const dialog = result.document.body.querySelector('dialog');
        dialog.dispatch('cancel');
        assert.equal(dialog.open, false);
        assert.equal(result.animations.length, 0);
    }
});

test('unsupported backdrop animation keeps the modal usable without animating its background', async () => {
    const result = await renderCatalog({ href: 'https://example.com/catalogo/', width: 1200,
        motion: true, backdropMotion: false, request: () => Response.json(sample) });
    result.nodes['catalog-grid'].children[0].querySelector('.catalog-details-button').dispatch('click');
    const dialog = result.document.body.querySelector('dialog');
    assert.equal(result.animations[1].canceled, true);
    dialog.dispatch('cancel');
    assert.equal(result.animations[3].canceled, true);
    result.animations[2].finish();
    await flushMotion();
    assert.equal(dialog.open, false);
});

test('mobile details animate measured heights, reverse quickly and reset at breakpoints', async () => {
    const result = await renderCatalog({ href: 'http://localhost:5500/catalogo/', motion: true,
        request: () => Response.json(sample) });
    const details = result.nodes['catalog-grid'].children[0].querySelector('details');
    const summary = details.querySelector('summary');
    assert.equal(summary.dispatch('click').defaultPrevented, true);
    assert.equal(details.open, true);
    assert.equal(details.style.overflow, 'hidden');
    assert.equal(result.animations[0].frames[1].height, '500px');
    summary.dispatch('click');
    assert.equal(result.animations[0].canceled, true);
    assert.equal(result.animations[1].frames[1].height, '100px');
    result.animations[1].finish();
    await flushMotion();
    assert.equal(details.open, false);
    assert.equal(details.style.overflow, '');
    summary.dispatch('click');
    result.animations.at(-1).finish();
    await flushMotion();
    assert.equal(details.open, true);
    summary.dispatch('click');
    result.resize(1200);
    await flushMotion();
    assert.equal(result.animations.at(-1).canceled, true);
    assert.equal(details.open, false);
    assert.equal(details.style.overflow, '');
});

test('photo motion waits for loading, ignores stale loads and commits only the latest selection', async () => {
    const images = [1, 2, 3].map(number => `assets/imgs/catalog/123-${number}.jpg`);
    const result = await renderCatalog({ href: 'http://localhost:5500/catalogo/', motion: true,
        request: () => Response.json({ ...sample, products: [{ ...sample.products[0], images }] }) });
    const gallery = result.nodes['catalog-grid'].children[0].querySelector('.catalog-gallery');
    const image = gallery.querySelector('img');
    const next = gallery.querySelector('.catalog-photo-next');
    // Capture detached image creation to emulate asynchronous network completion.
    const created = [];
    const create = result.document.createElement;
    result.document.createElement = tag => {
        const node = create(tag);
        if (tag === 'img') created.push(node);
        return node;
    };
    next.dispatch('click');
    assert.match(image.src, /123-1.jpg$/);
    assert.equal(result.animations.length, 0);
    next.dispatch('click');
    created[0].dispatch('load');
    await flushMotion();
    assert.equal(result.animations.length, 0);
    created[1].dispatch('load');
    await flushMotion();
    assert.equal(result.animations.length, 2);
    assert.equal(result.animations[1].frames[0].transform, 'translateX(100%)');
    assert.match(image.src, /123-1.jpg$/);
    for (const animation of result.animations) animation.finish();
    await flushMotion();
    assert.match(image.src, /123-3.jpg$/);
    assert.equal(gallery.querySelector('.catalog-photo-counter').textContent, 'Foto 3 de 3');
    assert.equal(gallery.querySelector('.catalog-photo-incoming'), undefined);
    gallery.querySelector('.catalog-photo-previous').dispatch('click');
    created.at(-1).dispatch('load');
    await flushMotion();
    assert.equal(result.animations.at(-1).frames[0].transform, 'translateX(-100%)');
    result.nodes['catalog-filters'].children[0].dispatch('click');
    await flushMotion();
    assert.equal(result.animations.at(-1).canceled, true);
    assert.equal(gallery.querySelector('.catalog-photo-incoming'), undefined);
    assert.match(image.src, /123-3.jpg$/);
});

test('modal close cancels loading photos and failed images transition to the placeholder', async () => {
    const images = ['assets/imgs/catalog/123-first.jpg', 'assets/imgs/catalog/123-second.jpg'];
    const result = await renderCatalog({ href: 'https://example.com/catalogo/', width: 1200, motion: true,
        request: () => Response.json({ ...sample, products: [{ ...sample.products[0], images }] }) });
    const created = [];
    const create = result.document.createElement;
    result.document.createElement = tag => {
        const node = create(tag);
        if (tag === 'img') created.push(node);
        return node;
    };
    const trigger = result.nodes['catalog-grid'].children[0].querySelector('.catalog-details-button');
    const dialog = result.document.body.querySelector('dialog');
    trigger.dispatch('click');
    dialog.querySelector('.catalog-photo-next').dispatch('click');
    const abandoned = created.at(-1);
    dialog.close();
    abandoned.dispatch('load');
    await flushMotion();
    assert.equal(result.animations.filter(animation => animation.node.tag === 'img').length, 0);
    assert.equal(dialog.querySelector('img'), undefined);
    trigger.dispatch('click');
    dialog.querySelector('.catalog-photo-next').dispatch('click');
    const incoming = created.at(-1);
    incoming.dispatch('error');
    assert.match(incoming.src, /product-placeholder.svg$/);
    incoming.dispatch('load');
    await flushMotion();
    for (const animation of result.animations) animation.finish();
    await flushMotion();
    assert.match(dialog.querySelector('img').src, /product-placeholder.svg$/);
    dialog.querySelector('.catalog-photo-next').dispatch('click');
    created.at(-1).dispatch('load');
    await flushMotion();
    dialog.close();
    await flushMotion();
    assert.equal(result.animations.at(-1).canceled, true);
});

test('reduced motion uses immediate updates and cancels active animations when enabled', async () => {
    const images = ['assets/imgs/catalog/123-first.jpg', 'assets/imgs/catalog/123-second.jpg'];
    for (const reduced of [true, false]) {
        const result = await renderCatalog({ href: 'https://example.com/catalogo/', motion: true, reduced,
            request: () => Response.json({ ...sample, products: [{ ...sample.products[0], images }] }) });
        const card = result.nodes['catalog-grid'].children[0];
        const details = card.querySelector('details');
        const event = details.querySelector('summary').dispatch('click');
        assert.equal(event.defaultPrevented, !reduced);
        if (!reduced) result.reduceMotion();
        card.querySelector('.catalog-photo-next').dispatch('click');
        assert.match(card.querySelector('img').src, /123-second.jpg$/);
        assert.equal(result.animations.length, reduced ? 0 : 1);
        assert.equal(details.style.overflow || '', '');
        await flushMotion();
    }
});

test('Live Server at the project root loads JSON and images from dist/', async () => {
    const result = await renderCatalog({
        href: 'http://localhost:5500/catalogo/',
        request: url => url.pathname === '/catalog.json'
            ? new Response('', { status: 404 }) : Response.json(sample),
    });
    assert.deepEqual(result.requests, [
        'http://localhost:5500/catalog.json', 'http://localhost:5500/dist/catalog.json',
    ]);
    assert.equal(result.errors.length, 0);
    assert.equal(result.nodes['catalog-grid'].children.length, 1);
    const card = result.nodes['catalog-grid'].children[0];
    assert.equal(card.querySelector('img').src, 'http://localhost:5500/dist/assets/imgs/catalog/123-abcdef.jpg');
    const body = card.children[1];
    assert.equal(body.children[0].textContent, sample.products[0].name);
    assert.equal(body.children[1].textContent.replace(/\s/g, ' '), 'R$ 12,50');
    const details = body.children.find(child => child.tag === 'details');
    assert.equal(details.children[1].textContent, sample.products[0].description);
    const order = new URL(body.children.find(child => child.tag === 'a').href);
    assert.equal(order.hostname, 'wa.me');
    assert.equal(order.pathname, '/554999272840');
    assert.match(order.searchParams.get('text'), /Caixa <Abraço> & Café/);
    assert.equal(result.nodes['catalog-updated'].hidden, false);
    assert.equal(result.nodes['catalog-grid'].attributes['aria-busy'], 'false');
});

test('subdirectory deployment resolves JSON and images relative to the page', async () => {
    const result = await renderCatalog({
        href: 'https://example.github.io/das-brot-menu/catalogo/',
        request: () => Response.json(sample),
    });
    assert.deepEqual(result.requests, ['https://example.github.io/das-brot-menu/catalog.json']);
    assert.equal(result.nodes['catalog-grid'].children[0].querySelector('img').src,
        'https://example.github.io/das-brot-menu/assets/imgs/catalog/123-abcdef.jpg');
});

test('unavailable products without a price have no order link', async () => {
    const result = await renderCatalog({
        href: 'http://localhost:8000/catalogo/',
        request: () => Response.json({ ...sample,
            products: [{ ...sample.products[0], available: false, priceAmount1000: null }],
        }),
    });
    const body = result.nodes['catalog-grid'].children[0].children[1];
    assert.equal(body.children[1].textContent, 'Consulte o valor');
    assert.equal(body.children.some(child => child.tag === 'a'), false);
    assert.equal(body.children.at(-1).attributes['aria-disabled'], 'true');
});

test('network errors and invalid data show the WhatsApp fallback', async () => {
    for (const request of [
        () => new Response('', { status: 404 }),
        () => { throw new Error('Offline'); },
        () => Response.json({ products: [] }),
        () => Response.json({ ...sample, products: [{ ...sample.products[0], priceAmount1000: -1 }] }),
    ]) {
        const result = await renderCatalog({ href: 'https://dasbrotartesanal.com.br/catalogo/', request });
        assert.equal(result.requests.length, 1);
        assert.equal(result.nodes['catalog-error'].hidden, false);
        assert.equal(result.nodes['catalog-filter-navigation'].hidden, true);
        assert.equal(result.nodes['catalog-grid'].children.length, 0);
        assert.equal(result.nodes['catalog-grid'].attributes['aria-busy'], 'false');
    }
});

test('desktop details open a modal without expanding cards and return focus on close', async () => {
    for (const width of [701, 900, 1200]) {
        const result = await renderCatalog({
            href: 'https://dasbrotartesanal.com.br/catalogo/', width,
            request: () => Response.json(sample),
        });
        const card = result.nodes['catalog-grid'].children[0];
        const details = card.querySelector('details');
        const trigger = card.querySelector('button');
        const dialog = result.document.body.querySelector('dialog');
        trigger.dispatch('click');
        assert.equal(dialog.open, true);
        assert.equal(dialog.modalShown, true);
        assert.equal(details.open, false);
        assert.equal(result.nodes['catalog-grid'].children[0], card);
        assert.equal(trigger.attributes['aria-haspopup'], 'dialog');
        assert.equal(dialog.attributes['aria-labelledby'], 'catalog-dialog-title');
        assert.equal(dialog.querySelector('h2').textContent, sample.products[0].name);
        const content = dialog.children[1];
        assert.equal(content.querySelector('.catalog-price').textContent.replace(/\s/g, ' '), 'R$ 12,50');
        assert.equal(content.querySelector('.catalog-description').textContent, sample.products[0].description);
        assert.equal(result.document.activeElement, dialog.querySelector('h2'));
        assert.equal(result.document.documentElement.classList.contains('catalog-dialog-open'), true);
        assert.match(new URL(dialog.querySelector('a').href).searchParams.get('text'), /Caixa <Abraço> & Café/);
        dialog.querySelector('button').dispatch('click');
        assert.equal(dialog.open, false);
        assert.equal(result.document.activeElement, trigger);
        assert.equal(trigger.focusOptions.preventScroll, true);
        assert.equal(result.document.documentElement.classList.contains('catalog-dialog-open'), false);
    }
});

test('modal galleries are created on demand, navigate independently and are removed on close', async () => {
    const images = ['assets/imgs/catalog/123-first.jpg', 'assets/imgs/catalog/123-second.jpg'];
    const result = await renderCatalog({
        href: 'http://localhost:5500/catalogo/', width: 1200,
        request: url => url.pathname === '/catalog.json'
            ? new Response('', { status: 404 })
            : Response.json({ ...sample, products: [{ ...sample.products[0], image: images[0], images }] }),
    });
    const card = result.nodes['catalog-grid'].children[0];
    const dialog = result.document.body.querySelector('dialog');
    const photos = dialog.querySelector('.catalog-dialog-photos');
    const trigger = card.querySelector('.catalog-details-button');
    const firstUrl = 'http://localhost:5500/dist/' + images[0];
    const secondUrl = 'http://localhost:5500/dist/' + images[1];
    assert.equal(photos.children.length, 0);
    card.querySelector('.catalog-photo-next').dispatch('click');
    assert.equal(card.querySelector('img').src, secondUrl);
    trigger.dispatch('click');
    const gallery = photos.querySelector('.catalog-gallery');
    const image = gallery.querySelector('img');
    assert.equal(image.src, firstUrl);
    assert.equal(image.loading, 'eager');
    assert.equal(gallery.children.filter(child => child.tag === 'img').length, 1);
    gallery.querySelector('.catalog-photo-next').dispatch('click');
    assert.equal(image.src, secondUrl);
    gallery.dispatch('keydown', { key: 'ArrowLeft' });
    assert.equal(image.src, firstUrl);
    assert.equal(card.querySelector('img').src, secondUrl);
    image.dispatch('error');
    assert.equal(image.src, 'http://localhost:5500/assets/icons/product-placeholder.svg');
    gallery.querySelector('.catalog-photo-next').dispatch('click');
    assert.equal(image.src, secondUrl);
    dialog.close();
    assert.equal(photos.children.length, 0);
    assert.equal(result.document.activeElement, trigger);
    trigger.dispatch('click');
    assert.equal(photos.querySelector('img').src, firstUrl);
    assert.notEqual(photos.querySelector('.catalog-gallery'), gallery);
    assert.equal(result.requests.length, 2);
});

test('single-column widths retain inline details without opening the modal', async () => {
    for (const width of [390, 700]) {
        const result = await renderCatalog({
            href: 'http://localhost:5500/catalogo/', width,
            request: () => Response.json(sample),
        });
        const card = result.nodes['catalog-grid'].children[0];
        const details = card.querySelector('details');
        details.open = true;
        card.querySelector('button').dispatch('click');
        assert.equal(details.open, true);
        assert.equal(result.document.body.querySelector('dialog').open, false);
        assert.equal(result.document.body.querySelector('dialog').querySelector('img'), undefined);
    }
});

test('one shared dialog refreshes text, price and availability between products', async () => {
    const unavailable = { ...sample.products[0], id: '456', name: 'Outra caixa',
        description: 'Outra composição', priceAmount1000: null, available: false };
    const result = await renderCatalog({
        href: 'https://dasbrotartesanal.com.br/catalogo/', width: 1200,
        request: () => Response.json({ ...sample, products: [...sample.products, unavailable] }),
    });
    const [first, second] = result.nodes['catalog-grid'].children;
    const dialog = result.document.body.querySelector('dialog');
    first.querySelector('button').dispatch('click');
    dialog.close();
    second.querySelector('button').dispatch('click');
    assert.equal(result.document.body.children.length, 1);
    assert.equal(dialog.querySelector('h2').textContent, unavailable.name);
    assert.equal(dialog.querySelector('img').alt, unavailable.name);
    assert.equal(dialog.querySelector('.catalog-photo-next'), undefined);
    assert.equal(dialog.querySelector('.catalog-price').textContent, 'Consulte o valor');
    assert.equal(dialog.querySelector('.catalog-unavailable').hidden, false);
    assert.equal(dialog.querySelector('.catalog-description').textContent, unavailable.description);
    assert.equal(dialog.querySelector('a'), undefined);
    assert.equal(dialog.querySelector('span').attributes['aria-disabled'], 'true');
});

test('backdrop closing requires both pointer down and click outside the dialog', async () => {
    const result = await renderCatalog({
        href: 'https://dasbrotartesanal.com.br/catalogo/', width: 1200,
        request: () => Response.json(sample),
    });
    const trigger = result.nodes['catalog-grid'].children[0].querySelector('button');
    const dialog = result.document.body.querySelector('dialog');
    trigger.dispatch('click');
    dialog.dispatch('pointerdown', { clientX: 150, clientY: 150 });
    dialog.dispatch('click', { clientX: 150, clientY: 150 });
    assert.equal(dialog.open, true);
    dialog.dispatch('pointerdown', { target: dialog.querySelector('h2'), clientX: 150, clientY: 150 });
    dialog.dispatch('click', { clientX: 20, clientY: 20 });
    assert.equal(dialog.open, true);
    dialog.dispatch('pointerdown', { clientX: 20, clientY: 20 });
    dialog.dispatch('click', { clientX: 20, clientY: 20 });
    assert.equal(dialog.open, false);
    assert.equal(result.document.activeElement, trigger);
});

test('crossing the breakpoint closes details and moves focus to the visible control without refetching', async () => {
    const result = await renderCatalog({
        href: 'https://dasbrotartesanal.com.br/catalogo/', width: 1200,
        request: () => Response.json(sample),
    });
    const card = result.nodes['catalog-grid'].children[0];
    const details = card.querySelector('details');
    const summary = details.querySelector('summary');
    const trigger = card.querySelector('button');
    const dialog = result.document.body.querySelector('dialog');
    trigger.dispatch('click');
    result.resize(900);
    assert.equal(dialog.open, true);
    result.resize(700);
    assert.equal(dialog.open, false);
    assert.equal(details.open, false);
    assert.equal(result.document.activeElement, summary);
    assert.equal(result.document.documentElement.classList.contains('catalog-dialog-open'), false);
    details.open = true;
    summary.focus();
    result.resize(701);
    assert.equal(details.open, false);
    assert.equal(result.document.activeElement, trigger);
    assert.equal(result.requests.length, 1);
});

test('collection filters preserve WhatsApp order, select the first collection and put all items last', async () => {
    for (const width of [390, 1200]) {
        const products = [sample.products[0], { ...sample.products[0], id: '456', name: 'Caixa PETIT' },
            { ...sample.products[0], id: '789', name: 'Caixa sem coleção' }];
        const result = await renderCatalog({
            href: 'https://dasbrotartesanal.com.br/catalogo/', width,
            request: () => Response.json({ ...sample, products, collections: [
                { id: 'empty', name: 'Coleção vazia', productIds: [] },
                { id: '10', name: 'Caixas De Doces', productIds: ['123', '456'] },
                { id: '20', name: 'Caixas De Café Da Manhã', productIds: ['123'] },
            ] }),
        });
        const filters = result.nodes['catalog-filters'];
        const [sweets, breakfast, all] = filters.children;
        const cards = result.nodes['catalog-grid'].children;
        const visible = () => cards.filter(card => !card.hidden);
        assert.equal(filters.hidden, false);
        assert.deepEqual(filters.children.map(button => button.attributes['aria-label']),
            ['Caixas de doces', 'Caixas de café da manhã', 'Todas as cestas']);
        assert.deepEqual(filters.children.map(button => button.children[0].textContent),
            ['Caixas de doces', 'Caixas de café da manhã', 'Todas as cestas']);
        assert.deepEqual(filters.children.map(button => button.children[1].textContent),
            ['Doces', 'Café da manhã', 'Todas']);
        assert.equal(sweets.attributes['aria-pressed'], 'true');
        assert.equal(breakfast.attributes['aria-pressed'], 'false');
        assert.equal(all.attributes['aria-pressed'], 'false');
        assert.equal(visible().length, 2);
        assert.equal(result.nodes['catalog-status'].textContent, '2 opções para presentear');
        const details = cards[0].querySelector('details');
        details.open = true;
        sweets.dispatch('click');
        assert.equal(visible().length, 2);
        assert.equal(details.open, false);
        assert.equal(sweets.attributes['aria-pressed'], 'true');
        assert.equal(all.attributes['aria-pressed'], 'false');
        assert.equal(result.nodes['catalog-status'].textContent, '2 opções para presentear');
        breakfast.dispatch('click');
        assert.equal(visible().length, 1);
        assert.equal(visible()[0], cards[0]);
        assert.equal(result.nodes['catalog-status'].textContent, '1 opção para presentear');
        if (width > 700) {
            cards[0].querySelector('button').dispatch('click');
            const dialog = result.document.body.querySelector('dialog');
            assert.equal(dialog.open, true);
            dialog.close();
        }
        all.dispatch('click');
        assert.equal(visible().length, 3);
        assert.equal(all.attributes['aria-pressed'], 'true');
        assert.equal(breakfast.attributes['aria-pressed'], 'false');
        assert.equal(result.nodes['catalog-status'].textContent, '3 opções para presentear');
        assert.equal(result.requests.length, 1);
        assert.deepEqual(result.nodes['catalog-grid'].children, cards);
        assert.equal(result.errors.length, 0);
    }
});

test('mobile filter arrows track overflow, scrolling, resizing and the desktop breakpoint', async () => {
    const result = await renderCatalog({ href: 'https://example.com/catalogo/', width: 390,
        filterLayout: { width: 300, contentWidth: 600 },
        request: () => Response.json({ ...sample, collections: [
            { id: '10', name: 'Caixas De Doces', productIds: ['123'] },
        ] }) });
    const filters = result.nodes['catalog-filters'];
    const previous = result.nodes['catalog-filters-previous'];
    const next = result.nodes['catalog-filters-next'];
    const navigation = result.nodes['catalog-filter-navigation'];
    assert.equal(navigation.hidden, false);
    assert.equal(filters.clientWidth, navigation.clientWidth);
    assert.equal(previous.hidden, true);
    assert.equal(next.hidden, false);
    next.dispatch('click');
    assert.equal(filters.scrollCalls.at(-1).left, filters.clientWidth * 0.75);
    assert.equal(filters.scrollCalls.at(-1).behavior, 'smooth');
    assert.equal(previous.hidden, false);
    assert.equal(next.hidden, false);
    assert.equal(filters.clientWidth, navigation.clientWidth, 'Arrows must not reserve lateral columns');
    // A swipe also updates the controls, independently of arrow clicks.
    filters.scrollLeft = filters.scrollWidth - filters.clientWidth;
    filters.dispatch('scroll');
    assert.equal(previous.hidden, false);
    assert.equal(next.hidden, true);
    previous.dispatch('click');
    assert.equal(filters.scrollCalls.at(-1).left, -filters.clientWidth * 0.75);
    assert.equal(next.hidden, false);
    result.resize(1200);
    assert.equal(previous.hidden, true);
    assert.equal(next.hidden, true);
    assert.equal(filters.clientWidth, navigation.clientWidth);
    result.resize(390);
    assert.equal(next.hidden, false);
    result.resizeFilters(700);
    assert.equal(previous.hidden, true);
    assert.equal(next.hidden, true);
    assert.equal(filters.clientWidth, navigation.clientWidth);
    result.resizeFilters(300);
    assert.equal(next.hidden, false);
    assert.equal(result.errors.length, 0);
});

test('mobile selection and keyboard focus reveal filters using only horizontal scrolling', async () => {
    const result = await renderCatalog({ href: 'https://example.com/catalogo/', width: 390,
        filterLayout: { width: 300, contentWidth: 368 },
        request: () => Response.json({ ...sample, collections: [
            { id: '10', name: 'Caixas De Doces', productIds: ['123'] },
            { id: '20', name: 'Caixas De Café Da Manhã', productIds: ['123'] },
        ] }) });
    const filters = result.nodes['catalog-filters'];
    const first = filters.children[0];
    const all = filters.children.at(-1);
    assert.equal(filters.scrollCalls.length, 0);
    all.dispatch('click');
    assert.equal(all.attributes['aria-pressed'], 'true');
    assert.ok(all.getBoundingClientRect().right <= filters.getBoundingClientRect().right - 8);
    assert.equal(filters.scrollCalls.at(-1).behavior, 'smooth');
    first.dispatch('click');
    assert.equal(filters.scrollLeft, 0);
    result.reduceMotion();
    filters.dispatch('focusin', { target: all });
    assert.equal(filters.scrollCalls.at(-1).behavior, 'instant');
    assert.ok(all.getBoundingClientRect().right <= filters.getBoundingClientRect().right - 8);
    assert.equal(first.attributes['aria-pressed'], 'true', 'Focus must not change the selected collection');
    result.nodes['catalog-filters-previous'].dispatch('click');
    assert.equal(filters.scrollCalls.at(-1).behavior, 'instant');
    for (const call of filters.scrollCalls) assert.deepEqual(Object.keys(call).sort(), ['behavior', 'left']);
    assert.equal(result.requests.length, 1);
    assert.equal(result.errors.length, 0);
});

test('selected and focused middle filters remain clear of both overlay controls on narrow screens', async () => {
    for (const width of [320, 390]) {
        const result = await renderCatalog({ href: 'https://example.com/catalogo/', width,
            filterLayout: { width: width - 24, contentWidth: 608 },
            request: () => Response.json({ ...sample, collections: [
                { id: '10', name: 'Caixas De Doces', productIds: ['123'] },
                { id: '20', name: 'Caixas De Café Da Manhã', productIds: ['123'] },
                { id: '30', name: 'Caixas De Aniversário', productIds: ['123'] },
                { id: '40', name: 'Caixas Kids', productIds: ['123'] },
            ] }) });
        const filters = result.nodes['catalog-filters'];
        const middle = filters.children[2];
        middle.dispatch('click');
        assert.equal(result.nodes['catalog-filters-previous'].hidden, false);
        assert.equal(result.nodes['catalog-filters-next'].hidden, false);
        assert.ok(middle.getBoundingClientRect().left >= filters.getBoundingClientRect().left + 48);
        assert.ok(middle.getBoundingClientRect().right <= filters.getBoundingClientRect().right - 48);
        assert.equal(filters.clientWidth, result.nodes['catalog-filter-navigation'].clientWidth);

        // Browser focus can scroll the track before the queued scroll event updates the arrows.
        filters.scrollLeft = 0;
        filters.dispatch('scroll');
        filters.scrollLeft = 120;
        const second = filters.children[1];
        filters.dispatch('focusin', { target: second });
        assert.ok(second.getBoundingClientRect().left >= filters.getBoundingClientRect().left + 48);
        assert.ok(second.getBoundingClientRect().right <= filters.getBoundingClientRect().right - 48);
        assert.equal(middle.attributes['aria-pressed'], 'true');
        assert.equal(result.errors.length, 0);
    }
});

test('filters without overflow keep both arrows hidden on mobile and desktop', async () => {
    for (const width of [390, 1200]) {
        const result = await renderCatalog({ href: 'https://example.com/catalogo/', width,
            request: () => Response.json({ ...sample, collections: [
                { id: '10', name: 'Caixas De Doces', productIds: ['123'] },
            ] }) });
        assert.equal(result.nodes['catalog-filter-navigation'].hidden, false);
        assert.equal(result.nodes['catalog-filters-previous'].hidden, true);
        assert.equal(result.nodes['catalog-filters-next'].hidden, true);
    }
});

test('older snapshots and empty collections keep all products visible without redundant filters', async () => {
    for (const collections of [undefined, [], [{ id: '10', name: 'Coleção vazia', productIds: [] }]]) {
        const result = await renderCatalog({
            href: 'https://dasbrotartesanal.com.br/catalogo/',
            request: () => Response.json({ ...sample, collections }),
        });
        assert.equal(result.nodes['catalog-filters'].hidden, true);
        assert.equal(result.nodes['catalog-filter-navigation'].hidden, true);
        assert.equal(result.nodes['catalog-grid'].children[0].hidden, false);
        assert.equal(result.errors.length, 0);
    }
});

test('prices sort ascending in every filter, with stable ties, zero first and missing prices last', async () => {
    for (const width of [390, 1200]) {
        const products = [
            { ...sample.products[0], id: 'high', name: 'Caixa maior', priceAmount1000: 200000 },
            { ...sample.products[0], id: 'missing', name: 'Caixa sob consulta', priceAmount1000: null },
            { ...sample.products[0], id: 'low', name: 'Caixa menor', priceAmount1000: 64000 },
            { ...sample.products[0], id: 'equal', name: 'Outra caixa menor', priceAmount1000: 64000 },
            { ...sample.products[0], id: 'zero', name: 'Sem custo', priceAmount1000: 0 },
        ];
        const result = await renderCatalog({
            href: 'https://dasbrotartesanal.com.br/catalogo/', width,
            request: () => Response.json({ ...sample, products, collections: [
                { id: '10', name: 'Caixas De Doces', productIds: ['high', 'missing', 'low', 'equal'] },
            ] }),
        });
        const visibleNames = () => result.nodes['catalog-grid'].children.filter(card => !card.hidden)
            .map(card => card.querySelector('h2').textContent);
        const expected = ['Sem custo', 'Caixa menor', 'Outra caixa menor', 'Caixa maior', 'Caixa sob consulta'];
        assert.deepEqual(visibleNames(), expected.slice(1));
        const [sweets, all] = result.nodes['catalog-filters'].children;
        sweets.dispatch('click');
        assert.deepEqual(visibleNames(), expected.slice(1));
        all.dispatch('click');
        assert.deepEqual(visibleNames(), expected);
        assert.equal(result.requests.length, 1);
    }
});

test('each gallery navigates independently by arrows and keyboard without opening details or fetching', async () => {
    for (const width of [390, 1200]) {
        const images = ['assets/imgs/catalog/first.jpg', 'assets/imgs/catalog/second.jpg', 'assets/imgs/catalog/third.jpg'];
        const result = await renderCatalog({
            href: 'https://example.github.io/das-brot-menu/catalogo/', width,
            request: () => Response.json({ ...sample, products: [
                { ...sample.products[0], images }, { ...sample.products[0], id: '456', name: 'Outra caixa', images },
            ] }),
        });
        const [first, second] = result.nodes['catalog-grid'].children;
        const gallery = first.querySelector('.catalog-gallery');
        const image = gallery.querySelector('img');
        const counter = gallery.querySelector('.catalog-photo-counter');
        const next = gallery.querySelector('.catalog-photo-next');
        const previous = gallery.querySelector('.catalog-photo-previous');
        assert.equal(gallery.attributes['aria-roledescription'], 'carrossel');
        assert.equal(gallery.tabIndex, 0);
        assert.equal(counter.textContent, 'Foto 1 de 3');
        next.dispatch('click');
        assert.equal(image.src, 'https://example.github.io/das-brot-menu/assets/imgs/catalog/second.jpg');
        assert.equal(counter.textContent, 'Foto 2 de 3');
        assert.match(image.alt, /foto 2 de 3/);
        assert.equal(second.querySelector('.catalog-photo-counter').textContent, 'Foto 1 de 3');
        previous.dispatch('click');
        previous.dispatch('click');
        assert.equal(counter.textContent, 'Foto 3 de 3');
        const key = gallery.dispatch('keydown', { key: 'ArrowRight' });
        assert.equal(key.defaultPrevented, true);
        assert.equal(counter.textContent, 'Foto 1 de 3');
        gallery.dispatch('keydown', { key: 'ArrowLeft' });
        assert.equal(counter.textContent, 'Foto 3 de 3');
        assert.equal(result.document.body.querySelector('dialog').open, false);
        if (width > 700) {
            first.querySelector('.catalog-details-button').dispatch('click');
            const dialog = result.document.body.querySelector('dialog');
            assert.equal(dialog.open, true);
            dialog.close();
            assert.equal(result.document.activeElement, first.querySelector('.catalog-details-button'));
            assert.equal(counter.textContent, 'Foto 3 de 3');
        }
        assert.equal(result.requests.length, 1);
    }
});

test('touch swipes change photos while short, vertical and canceled gestures do not', async () => {
    const result = await renderCatalog({ href: 'http://localhost:5500/catalogo/',
        request: () => Response.json({ ...sample, products: [{ ...sample.products[0], images: [
            'assets/imgs/catalog/first.jpg', 'assets/imgs/catalog/second.jpg',
        ] }] }),
    });
    const gallery = result.nodes['catalog-grid'].children[0].querySelector('.catalog-gallery');
    const counter = gallery.querySelector('.catalog-photo-counter');
    const start = { pointerType: 'touch', pointerId: 1, clientX: 200, clientY: 100 };
    gallery.dispatch('pointerdown', start);
    gallery.dispatch('pointerup', { pointerId: 1, clientX: 100, clientY: 110 });
    assert.equal(counter.textContent, 'Foto 2 de 2');
    gallery.dispatch('pointerdown', { ...start, clientX: 100 });
    gallery.dispatch('pointerup', { pointerId: 1, clientX: 200, clientY: 100 });
    assert.equal(counter.textContent, 'Foto 1 de 2');
    for (const end of [{ clientX: 190, clientY: 100 }, { clientX: 150, clientY: 220 }]) {
        gallery.dispatch('pointerdown', start);
        gallery.dispatch('pointerup', { pointerId: 1, ...end });
        assert.equal(counter.textContent, 'Foto 1 de 2');
    }
    gallery.dispatch('pointerdown', start);
    gallery.dispatch('pointercancel');
    gallery.dispatch('pointerup', { pointerId: 1, clientX: 100, clientY: 100 });
    assert.equal(counter.textContent, 'Foto 1 de 2');
});

test('single-image snapshots and placeholders omit carousel controls and recover from image failures', async () => {
    for (const product of [sample.products[0], { ...sample.products[0], images: ['assets/icons/product-placeholder.svg'] }]) {
        const result = await renderCatalog({ href: 'http://localhost:5500/catalogo/',
            request: () => Response.json({ ...sample, products: [product] }),
        });
        const gallery = result.nodes['catalog-grid'].children[0].querySelector('.catalog-gallery');
        assert.equal(gallery.querySelector('button'), undefined);
        const image = gallery.querySelector('img');
        image.dispatch('error');
        image.dispatch('error');
        assert.equal(image.src, 'http://localhost:5500/assets/icons/product-placeholder.svg');
        assert.equal(result.errors.length, 0);
    }
});
