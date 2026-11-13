const grid = document.querySelector('#catalog-grid');
const status = document.querySelector('#catalog-status');
const fallbackImage = 'assets/icons/product-placeholder.svg';
const siteRoot = new URL('../', window.location.href);
const mobileLayout = window.matchMedia('(max-width: 700px)');
const detailControls = [];
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const motionControllers = new Set();
const detailClosers = new WeakMap();

function stopMotion() {
    for (const cancel of motionControllers) cancel();
}
reducedMotion.addEventListener('change', stopMotion);
mobileLayout.addEventListener('change', stopMotion);

function animateDetails(details, summary) {
    let animation = null;
    let expanded = false;
    const reset = () => {
        const previous = animation;
        animation = null;
        previous?.cancel();
        details.style.overflow = '';
        details.open = expanded = false;
    };
    detailClosers.set(details, reset);
    motionControllers.add(reset);
    summary.addEventListener('click', event => {
        if (!mobileLayout.matches || reducedMotion.matches || !details.animate) return;
        event.preventDefault();
        const start = details.getBoundingClientRect().height;
        expanded = animation ? !expanded : !details.open;
        const previous = animation;
        animation = null;
        previous?.cancel();
        details.open = true;
        const end = expanded ? details.scrollHeight : summary.getBoundingClientRect().height;
        details.style.overflow = 'hidden';
        const current = details.animate([{ height: `${start}px` }, { height: `${end}px` }], {
            duration: 220, easing: 'ease-in-out',
        });
        animation = current;
        current.finished.then(() => {
            if (animation !== current) return;
            animation = null;
            details.open = expanded;
            details.style.overflow = '';
        }, () => {});
    });
}

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
}

function formatPrice(product) {
    return product.priceAmount1000 == null ? 'Consulte o valor'
        : new Intl.NumberFormat('pt-BR', { style: 'currency', currency: product.currency })
            .format(product.priceAmount1000 / 1000);
}

function orderAction(product, whatsappNumber) {
    if (!product.available) {
        const unavailable = element('span', 'button catalog-order catalog-order-disabled', 'Indisponível');
        unavailable.setAttribute('aria-disabled', 'true');
        return unavailable;
    }
    const order = element('a', 'button button-primary catalog-order', 'Encomendar pelo WhatsApp');
    const message = `Olá! Gostaria de encomendar: ${product.name}. Podemos combinar os detalhes?`;
    order.href = `https://wa.me/${whatsappNumber}?text=${encodeURIComponent(message)}`;
    order.target = '_blank';
    order.rel = 'noopener noreferrer';
    order.setAttribute('aria-label', `Encomendar ${product.name} pelo WhatsApp (abre em nova aba)`);
    return order;
}

function createProductDialog() {
    const dialog = element('dialog', 'catalog-dialog');
    dialog.id = 'catalog-dialog';
    dialog.setAttribute('aria-labelledby', 'catalog-dialog-title');
    const header = element('div', 'catalog-dialog-header');
    const title = element('h2', 'catalog-dialog-title');
    title.id = 'catalog-dialog-title';
    title.tabIndex = -1;
    const close = element('button', 'catalog-dialog-close', 'Fechar');
    close.type = 'button';
    close.setAttribute('aria-label', 'Fechar detalhes do produto');
    close.addEventListener('click', () => requestClose());
    header.append(title, close);

    const content = element('div', 'catalog-dialog-content');
    const photos = element('div', 'catalog-dialog-photos');
    const information = element('div', 'catalog-dialog-information');
    const price = element('p', 'catalog-price');
    const availability = element('p', 'catalog-unavailable', 'Indisponível no momento');
    const description = element('p', 'catalog-description');
    information.append(price, availability, description);
    content.append(photos, information);
    const footer = element('div', 'catalog-dialog-footer');
    dialog.append(header, content, footer);
    document.body.append(dialog);

    let activeControl = null;
    let backdropPressed = false;
    let dialogAnimation = null;
    let backdropAnimation = null;
    let closing = false;
    function cancelDialogAnimation() {
        const current = dialogAnimation;
        dialogAnimation = null;
        current?.cancel();
        backdropAnimation?.cancel();
        backdropAnimation = null;
    }
    function animateBackdrop(from, to, duration, easing) {
        try {
            const animation = dialog.animate([{ backgroundColor: from }, { backgroundColor: to }], {
                duration, easing, fill: 'both', pseudoElement: '::backdrop',
            });
            animation.finished.then(() => {}, () => {});
            if (animation.effect?.pseudoElement === '::backdrop') backdropAnimation = animation;
            else animation.cancel();
        } catch {
            // Older browsers may support element animation without pseudo-element animation.
        }
    }
    function requestClose() {
        if (!dialog.open || closing) return;
        if (reducedMotion.matches || !dialog.animate) {
            dialog.close();
            return;
        }
        closing = true;
        const appearance = window.getComputedStyle(dialog);
        const start = { opacity: appearance.opacity, transform: appearance.transform };
        const backdrop = window.getComputedStyle(dialog, '::backdrop').backgroundColor;
        cancelDialogAnimation();
        const current = dialog.animate([start, { opacity: 0, transform: 'translateY(12px)' }], {
            duration: 160, easing: 'ease-in', fill: 'both',
        });
        dialogAnimation = current;
        animateBackdrop(backdrop, 'transparent', 160, 'ease-in');
        current.finished.then(() => {
            if (dialogAnimation === current) dialog.close();
        }, () => {});
    }
    function outsideDialog(event) {
        const bounds = dialog.getBoundingClientRect();
        return event.clientX < bounds.left || event.clientX > bounds.right
            || event.clientY < bounds.top || event.clientY > bounds.bottom;
    }
    dialog.addEventListener('pointerdown', event => {
        backdropPressed = event.target === dialog && outsideDialog(event);
    });
    dialog.addEventListener('click', event => {
        if (backdropPressed && event.target === dialog && outsideDialog(event)) requestClose();
        backdropPressed = false;
    });
    // Keep the native focus containment while delaying Escape closure for the exit animation.
    dialog.addEventListener('cancel', event => {
        event.preventDefault();
        requestClose();
    });
    dialog.addEventListener('close', () => {
        cancelDialogAnimation();
        closing = false;
        document.documentElement.classList.remove('catalog-dialog-open');
        const control = activeControl;
        activeControl = null;
        backdropPressed = false;
        photos.querySelector('.catalog-gallery')?.disposeMotion?.();
        photos.replaceChildren();
        if (control) (mobileLayout.matches ? control.summary : control.button).focus({ preventScroll: true });
    });
    mobileLayout.addEventListener('change', () => {
        for (const control of detailControls) {
            control.details.open = false;
            if (!mobileLayout.matches && document.activeElement === control.summary) {
                control.button.focus({ preventScroll: true });
            }
        }
        if (dialog.open) dialog.close();
    });
    reducedMotion.addEventListener('change', () => {
        if (!reducedMotion.matches) return;
        if (closing) {
            dialog.close();
        } else {
            cancelDialogAnimation();
        }
    });

    return {
        open(product, whatsappNumber, control, catalogUrl) {
            if (mobileLayout.matches || dialog.open) return;
            activeControl = control;
            title.textContent = product.name;
            price.textContent = formatPrice(product);
            availability.hidden = product.available;
            description.textContent = product.description;
            const gallery = productGallery(product, catalogUrl);
            gallery.querySelector('img').loading = 'eager';
            photos.replaceChildren(gallery);
            content.scrollTop = 0;
            footer.replaceChildren(orderAction(product, whatsappNumber));
            document.documentElement.classList.add('catalog-dialog-open');
            const animated = !reducedMotion.matches && Boolean(dialog.animate);
            dialog.showModal();
            if (animated) {
                const backdrop = window.getComputedStyle(dialog, '::backdrop').backgroundColor;
                const current = dialog.animate([
                    { opacity: 0, transform: 'translateY(12px)' },
                    { opacity: 1, transform: 'translateY(0)' },
                ], { duration: 200, easing: 'ease-out', fill: 'both' });
                dialogAnimation = current;
                animateBackdrop('transparent', backdrop, 200, 'ease-out');
                current.finished.then(() => {
                    if (dialogAnimation === current) cancelDialogAnimation();
                }, () => {});
            }
            title.focus({ preventScroll: true });
        },
    };
}

const productDialog = createProductDialog();

function productGallery(product, catalogUrl) {
    const images = product.images ?? [product.image];
    const gallery = element('div', 'catalog-gallery');
    const image = element('img', 'catalog-photo');
    image.src = new URL(images[0], catalogUrl).href;
    image.alt = product.name;
    image.width = 800;
    image.height = 800;
    image.loading = 'lazy';
    image.decoding = 'async';
    image.draggable = false;
    image.addEventListener('error', () => {
        const placeholder = new URL(fallbackImage, siteRoot).href;
        if (image.src !== placeholder) image.src = placeholder;
    });
    gallery.append(image);
    if (images.length === 1) return gallery;

    gallery.tabIndex = 0;
    gallery.setAttribute('role', 'group');
    gallery.setAttribute('aria-roledescription', 'carrossel');
    gallery.setAttribute('aria-label', `Fotos de ${product.name}`);
    const previous = element('button', 'catalog-photo-arrow catalog-photo-previous');
    const next = element('button', 'catalog-photo-arrow catalog-photo-next');
    previous.type = next.type = 'button';
    previous.setAttribute('aria-label', `Foto anterior de ${product.name}`);
    next.setAttribute('aria-label', `Próxima foto de ${product.name}`);
    const counter = element('span', 'catalog-photo-counter');
    counter.setAttribute('role', 'status');
    counter.setAttribute('aria-live', 'polite');
    counter.setAttribute('aria-atomic', 'true');
    let index = 0;
    let visibleIndex = 0;
    let revision = 0;
    let pending = null;
    let animations = [];
    function cancelMotion() {
        revision++;
        for (const animation of animations) animation.cancel();
        animations = [];
        pending?.remove();
        pending = null;
        index = visibleIndex;
    }
    motionControllers.add(cancelMotion);
    gallery.cancelMotion = cancelMotion;
    gallery.disposeMotion = () => {
        cancelMotion();
        motionControllers.delete(cancelMotion);
    };
    function commit(nextIndex, url) {
        visibleIndex = nextIndex;
        image.src = url;
        image.alt = `${product.name} - foto ${nextIndex + 1} de ${images.length}`;
        counter.textContent = `Foto ${nextIndex + 1} de ${images.length}`;
    }
    function showPhoto(nextIndex) {
        const direction = nextIndex < index ? -1 : 1;
        const target = (nextIndex + images.length) % images.length;
        cancelMotion();
        index = target;
        const url = new URL(images[target], catalogUrl).href;
        if (!image.animate || reducedMotion.matches || target === visibleIndex) {
            commit(target, url);
            return;
        }
        const request = revision;
        const incoming = element('img', 'catalog-photo catalog-photo-incoming');
        incoming.alt = '';
        incoming.setAttribute('aria-hidden', 'true');
        incoming.width = incoming.height = 800;
        incoming.decoding = 'async';
        incoming.draggable = false;
        pending = incoming;
        let failed = false;
        incoming.addEventListener('error', () => {
            if (request !== revision) return;
            if (!failed) {
                failed = true;
                incoming.src = new URL(fallbackImage, siteRoot).href;
            } else {
                commit(target, incoming.src);
                cancelMotion();
            }
        });
        incoming.addEventListener('load', async () => {
            try { await incoming.decode?.(); } catch { /* A loaded fallback can still be displayed. */ }
            if (request !== revision) return;
            gallery.append(incoming);
            const options = { duration: 250, easing: 'ease-in-out' };
            animations = [
                image.animate([{ transform: 'translateX(0)' }, { transform: `translateX(${-direction * 100}%)` }], options),
                incoming.animate([{ transform: `translateX(${direction * 100}%)` }, { transform: 'translateX(0)' }], options),
            ];
            Promise.all(animations.map(animation => animation.finished)).then(() => {
                if (request !== revision) return;
                commit(target, incoming.src);
                cancelMotion();
            }, () => {});
        });
        incoming.src = url;
    }
    previous.addEventListener('click', () => showPhoto(index - 1));
    next.addEventListener('click', () => showPhoto(index + 1));
    gallery.addEventListener('keydown', event => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        showPhoto(index + (event.key === 'ArrowRight' ? 1 : -1));
    });
    let swipe = null;
    gallery.addEventListener('pointerdown', event => {
        if (event.pointerType !== 'touch' || event.isPrimary === false
            || event.target === previous || event.target === next) return;
        swipe = { id: event.pointerId, x: event.clientX, y: event.clientY };
        gallery.setPointerCapture(event.pointerId);
    });
    gallery.addEventListener('pointerup', event => {
        const start = swipe;
        swipe = null;
        if (!start || start.id !== event.pointerId) return;
        const horizontal = event.clientX - start.x;
        const vertical = event.clientY - start.y;
        if (Math.abs(horizontal) >= 40 && Math.abs(horizontal) > Math.abs(vertical) * 1.5) {
            showPhoto(index + (horizontal < 0 ? 1 : -1));
        }
    });
    gallery.addEventListener('pointercancel', () => { swipe = null; });
    gallery.append(previous, next, counter);
    showPhoto(0);
    return gallery;
}

function productCard(product, whatsappNumber, catalogUrl) {
    const card = element('article', 'catalog-card');
    card.append(productGallery(product, catalogUrl));

    const body = element('div', 'catalog-card-body');
    body.append(element('h2', 'catalog-product-name', product.name));
    body.append(element('p', 'catalog-price', formatPrice(product)));
    if (!product.available) body.append(element('p', 'catalog-unavailable', 'Indisponível no momento'));

    if (product.description) {
        const details = element('details', 'catalog-details');
        const summary = element('summary', null, 'Ver composição e detalhes');
        details.append(summary);
        details.append(element('p', 'catalog-description', product.description));
        animateDetails(details, summary);
        const button = element('button', 'catalog-details-button', 'Ver composição e detalhes');
        button.type = 'button';
        button.setAttribute('aria-haspopup', 'dialog');
        button.setAttribute('aria-controls', 'catalog-dialog');
        button.setAttribute('aria-label', `Ver composição e detalhes de ${product.name}`);
        const control = { details, summary, button };
        button.addEventListener('click', () => productDialog.open(product, whatsappNumber, control, catalogUrl));
        detailControls.push(control);
        body.append(details, button);
    }

    body.append(orderAction(product, whatsappNumber));
    card.append(body);
    return card;
}

function setupFilters(collections, productCards) {
    const filters = document.querySelector('#catalog-filters');
    const navigation = document.querySelector('#catalog-filter-navigation');
    const previous = document.querySelector('#catalog-filters-previous');
    const next = document.querySelector('#catalog-filters-next');
    const options = [...collections.filter(collection => collection.productIds.length), { name: 'Todas as cestas', productIds: null }];
    const buttons = [];
    function updateNavigation() {
        const overflowing = !navigation.hidden && mobileLayout.matches
            && filters.scrollWidth > filters.clientWidth + 1;
        previous.hidden = !overflowing || filters.scrollLeft <= 1;
        next.hidden = !overflowing || filters.scrollLeft >= filters.scrollWidth - filters.clientWidth - 1;
    }
    function scrollFilters(left) {
        filters.scrollBy({ left, behavior: reducedMotion.matches ? 'instant' : 'smooth' });
    }
    function revealFilter(button) {
        if (!mobileLayout.matches || navigation.hidden) return;
        updateNavigation();
        const track = filters.getBoundingClientRect();
        const bounds = button.getBoundingClientRect();
        const leftInset = previous.hidden ? 8 : 48;
        const rightInset = next.hidden ? 8 : 48;
        let target = filters.scrollLeft;
        if (bounds.left < track.left + leftInset) target += bounds.left - track.left - 48;
        else if (bounds.right > track.right - rightInset) target += bounds.right - track.right + 48;
        target = Math.max(0, Math.min(filters.scrollWidth - filters.clientWidth, target));
        if (target !== filters.scrollLeft) scrollFilters(target - filters.scrollLeft);
    }
    function selectFilter(selectedIndex) {
        const option = options[selectedIndex];
        const visibleIds = option.productIds ? new Set(option.productIds) : null;
        let count = 0;
        for (const [id, card] of productCards) {
            card.hidden = visibleIds !== null && !visibleIds.has(id);
            card.querySelector('.catalog-gallery').cancelMotion?.();
            const details = card.querySelector('details');
            if (details) detailClosers.get(details)();
            if (!card.hidden) count++;
        }
        buttons.forEach((button, index) => button.setAttribute('aria-pressed', String(index === selectedIndex)));
        status.textContent = `${count} ${count === 1 ? 'opção para presentear' : 'opções para presentear'}`;
        revealFilter(buttons[selectedIndex]);
    }
    for (const [index, option] of options.entries()) {
        const isAllItems = option.productIds === null;
        const label = isAllItems ? option.name
            : option.name.charAt(0).toLocaleUpperCase('pt-BR') + option.name.slice(1).toLocaleLowerCase('pt-BR');
        const shortName = isAllItems ? 'Todas' : label.replace(/^caixas? de\s+/i, '');
        const compactLabel = shortName.charAt(0).toLocaleUpperCase('pt-BR') + shortName.slice(1);
        const button = element('button', 'catalog-filter');
        button.append(element('span', 'catalog-filter-label-full', label),
            element('span', 'catalog-filter-label-compact', compactLabel));
        button.type = 'button';
        button.setAttribute('aria-label', label);
        button.setAttribute('aria-controls', 'catalog-grid');
        button.addEventListener('click', () => selectFilter(index));
        buttons.push(button);
    }
    filters.replaceChildren(...buttons);
    filters.hidden = options.length <= 1;
    navigation.hidden = filters.hidden;
    previous.addEventListener('click', () => scrollFilters(-filters.clientWidth * 0.75));
    next.addEventListener('click', () => scrollFilters(filters.clientWidth * 0.75));
    filters.addEventListener('scroll', updateNavigation, { passive: true });
    filters.addEventListener('focusin', event => {
        if (buttons.includes(event.target)) revealFilter(event.target);
    });
    window.addEventListener('resize', updateNavigation);
    mobileLayout.addEventListener('change', updateNavigation);
    if (typeof ResizeObserver !== 'undefined') {
        const observer = new ResizeObserver(updateNavigation);
        observer.observe(navigation);
        observer.observe(filters);
    }
    document.fonts?.ready.then(updateNavigation);
    updateNavigation();
    selectFilter(0);
}

async function loadCatalog() {
    try {
        let catalogUrl = new URL('catalog.json', siteRoot);
        let response = await fetch(catalogUrl, { signal: AbortSignal.timeout(15000) });
        // Live Server usually serves the project root, while generated data lives in dist/.
        const localPreview = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
        if (response.status === 404 && localPreview) {
            catalogUrl = new URL('dist/catalog.json', siteRoot);
            response = await fetch(catalogUrl, { signal: AbortSignal.timeout(15000) });
        }
        if (!response.ok) throw new Error(`Catalog unavailable (HTTP ${response.status}).`);
        const catalog = await response.json();
        if (!/^\d+$/.test(catalog.whatsappNumber) || !Array.isArray(catalog.products)
            || !catalog.products.length) throw new Error('Invalid catalog.');
        const collections = catalog.collections ?? [];
        if (!Array.isArray(collections) || collections.some(collection =>
            typeof collection.id !== 'string' || typeof collection.name !== 'string' || !collection.name.trim()
            || !Array.isArray(collection.productIds) || collection.productIds.some(id => typeof id !== 'string'))) {
            throw new Error('Invalid collections.');
        }
        const cards = document.createDocumentFragment();
        const productCards = new Map();
        const sortedProducts = [...catalog.products].sort((first, second) => {
            if (first.priceAmount1000 == null) return second.priceAmount1000 == null ? 0 : 1;
            if (second.priceAmount1000 == null) return -1;
            return first.priceAmount1000 - second.priceAmount1000;
        });
        for (const product of sortedProducts) {
            const images = product.images ?? [product.image];
            if (typeof product.name !== 'string' || typeof product.description !== 'string'
                || typeof product.available !== 'boolean' || !/^[A-Z]{3}$/.test(product.currency)
                || !Array.isArray(images) || !images.length || images.some(image => typeof image !== 'string'
                    || !(image.startsWith('assets/imgs/catalog/') || image === fallbackImage))
                || (product.priceAmount1000 != null && (!Number.isSafeInteger(product.priceAmount1000)
                    || product.priceAmount1000 < 0))) throw new Error('Invalid product.');
            if (typeof product.id !== 'string' || productCards.has(product.id)) throw new Error('Invalid product identifier.');
            const card = productCard(product, catalog.whatsappNumber, catalogUrl);
            productCards.set(product.id, card);
            cards.append(card);
        }
        grid.replaceChildren(cards);
        setupFilters(collections, productCards);
        const updatedAt = new Date(catalog.updatedAt);
        if (!Number.isNaN(updatedAt.getTime())) {
            const updated = document.querySelector('#catalog-updated');
            const time = updated.querySelector('time');
            time.dateTime = updatedAt.toISOString();
            time.textContent = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo' }).format(updatedAt);
            updated.hidden = false;
        }
    } catch (error) {
        console.error('Could not load the catalog:', error);
        grid.replaceChildren();
        document.querySelector('#catalog-filters').hidden = true;
        document.querySelector('#catalog-filter-navigation').hidden = true;
        status.textContent = 'Catálogo temporariamente indisponível';
        document.querySelector('#catalog-error').hidden = false;
    } finally {
        grid.setAttribute('aria-busy', 'false');
    }
}

loadCatalog();
