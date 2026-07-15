// ==UserScript==
// @name         Ozon Orders Finder
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Фильтр заказов на странице архива Ozon по диапазону цены с поддержкой динамической подгрузки
// @author       p166
// @homepageURL  https://github.com/p166/ozon-orders-finder
// @source       https://github.com/p166/ozon-orders-finder.git
// @supportURL   https://github.com/p166/ozon-orders-finder/issues
// @icon         https://st.ozone.ru/assets/favicon.ico
// @match        https://www.ozon.ru/my/orderlist?selectedTab=archive*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    const STORAGE_KEY = 'ozon_orders_finder_settings';
    let observer = null;
    let currentMin = -Infinity;
    let currentMax = Infinity;
    let hideNonMatching = false;

    function getSavedSettings() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return { min: '', max: '', hide: false, active: false };
            const parsed = JSON.parse(raw);
            return {
                min: parsed.min || '',
                max: parsed.max || '',
                hide: !!parsed.hide,
                active: !!parsed.active
            };
        } catch (e) {
            return { min: '', max: '', hide: false, active: false };
        }
    }

    function saveSettings(min, max, hide, active) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({ min, max, hide, active }));
        } catch (e) {}
    }

    function parsePrice(text) {
        if (!text) return null;
        const cleaned = text.replace(/\s/g, '').replace(/[^\d.,]/g, '');
        const normalized = cleaned.replace(',', '.');
        const val = parseFloat(normalized);
        return isNaN(val) ? null : val;
    }

    function extractPriceFromBlock(el) {
        const priceSelectors = [
            '.c35_4_0-a1',
            '[class*="price"]',
            '[class*="Price"]',
            '[class*="total"]',
            '[class*="Total"]',
        ];

        for (const sel of priceSelectors) {
            const priceEl = el.querySelector(sel);
            if (priceEl) {
                const price = parsePrice(priceEl.textContent);
                if (price !== null) return price;
            }
        }

        const allText = el.textContent || '';
        const match = allText.match(/(\d[\d\s]*[.,]?\d*)\s*[₽рPР]/);
        if (match) {
            return parsePrice(match[1]);
        }

        return null;
    }

    function clearHighlights() {
        const highlighted = document.querySelectorAll('[data-ozof-highlight]');
        highlighted.forEach(el => {
            el.style.outline = '';
            el.style.outlineOffset = '';
            el.style.backgroundColor = '';
            el.style.display = '';
            delete el.dataset.ozofHighlight;
        });
        const blocks = document.querySelectorAll('.w9d_11');
        blocks.forEach(el => {
            el.style.outline = '';
            el.style.outlineOffset = '';
            el.style.backgroundColor = '';
            el.style.display = '';
            delete el.dataset.ozofHighlight;
        });
    }

    function applyFilter() {
        const blocks = document.querySelectorAll('.w9d_11');
        let matched = 0;
        let firstMatched = null;

        blocks.forEach(el => {
            const price = extractPriceFromBlock(el);
            if (price === null) {
                if (hideNonMatching) el.style.display = 'none';
                return;
            }

            const isMatch = price >= currentMin && price <= currentMax;
            if (isMatch) {
                el.style.outline = '2px solid #00b341';
                el.style.outlineOffset = '-2px';
                el.style.backgroundColor = 'rgba(0,179,65,0.06)';
                el.style.display = '';
                el.dataset.ozofHighlight = '1';
                matched++;
                if (!firstMatched) firstMatched = el;
            } else if (hideNonMatching) {
                el.style.outline = '';
                el.style.outlineOffset = '';
                el.style.backgroundColor = '';
                el.style.display = 'none';
                delete el.dataset.ozofHighlight;
            }
        });

        if (firstMatched) {
            firstMatched.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }

        const statusEl = document.getElementById('ozof-status');
        if (statusEl) {
            statusEl.textContent = `Найдено: ${matched}`;
        }
    }

    function filterByPrice() {
        const minInput = document.getElementById('ozof-min');
        const maxInput = document.getElementById('ozof-max');
        const hideCheckbox = document.getElementById('ozof-hide');
        if (!minInput || !maxInput || !hideCheckbox) return;

        const minRaw = minInput.value.trim();
        const maxRaw = maxInput.value.trim();
        hideNonMatching = hideCheckbox.checked;

        saveSettings(minRaw, maxRaw, hideNonMatching, true);

        currentMin = minRaw === '' ? -Infinity : parseFloat(minRaw.replace(',', '.'));
        currentMax = maxRaw === '' ? Infinity : parseFloat(maxRaw.replace(',', '.'));

        if ((minRaw !== '' && isNaN(currentMin)) || (maxRaw !== '' && isNaN(currentMax))) {
            alert('Введите корректные числовые значения для цены');
            return;
        }

        clearHighlights();
        applyFilter();
    }

    function resetFilter() {
        clearHighlights();
        currentMin = -Infinity;
        currentMax = Infinity;
        hideNonMatching = false;

        const minInput = document.getElementById('ozof-min');
        const maxInput = document.getElementById('ozof-max');
        const hideCheckbox = document.getElementById('ozof-hide');

        const minRaw = minInput ? minInput.value.trim() : '';
        const maxRaw = maxInput ? maxInput.value.trim() : '';
        const hide = hideCheckbox ? hideCheckbox.checked : false;

        saveSettings(minRaw, maxRaw, hide, false);

        const statusEl = document.getElementById('ozof-status');
        if (statusEl) statusEl.textContent = '';
    }

    function observeNewBlocks() {
        if (observer) return;

        observer = new MutationObserver((mutations) => {
            let hasNew = false;
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType === 1 && (node.matches?.('.w9d_11') || node.querySelector?.('.w9d_11'))) {
                        hasNew = true;
                        break;
                    }
                }
                if (hasNew) break;
            }
            if (hasNew) {
                applyFilter();
            }
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });
    }

    function initUI() {
        if (document.getElementById('ozof-panel')) return;

        const settings = getSavedSettings();

        const panel = document.createElement('div');
        panel.id = 'ozof-panel';
        panel.style.cssText = `
            position: fixed;
            top: 16px;
            right: 16px;
            width: 340px;
            max-height: 90vh;
            overflow: auto;
            background: #fff;
            border: 1px solid #ddd;
            border-radius: 12px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.12);
            padding: 16px;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            font-size: 14px;
            z-index: 999999;
        `;

        const title = document.createElement('div');
        title.textContent = 'Ozon Orders Finder';
        title.style.cssText = `
            font-weight: 600;
            font-size: 16px;
            margin-bottom: 12px;
            color: #0f0f0f;
        `;

        const desc = document.createElement('div');
        desc.textContent = 'Фильтр по цене товара (₽):';
        desc.style.cssText = `
            color: #555;
            margin-bottom: 8px;
        `;

        const rowFrom = document.createElement('div');
        rowFrom.style.cssText = 'display:flex; gap:8px; align-items:center; margin-bottom:8px;';

        const labelFrom = document.createElement('label');
        labelFrom.textContent = 'От';
        labelFrom.style.cssText = 'width: 24px; color:#555;';

        const minInput = document.createElement('input');
        minInput.id = 'ozof-min';
        minInput.type = 'text';
        minInput.inputMode = 'decimal';
        minInput.placeholder = 'мин';
        minInput.value = settings.min || '';
        minInput.style.cssText = `
            flex: 1;
            padding: 8px;
            border: 1px solid #d3d3d3;
            border-radius: 8px;
            font-size: 14px;
        `;

        const rowTo = document.createElement('div');
        rowTo.style.cssText = 'display:flex; gap:8px; align-items:center; margin-bottom:12px;';

        const labelTo = document.createElement('label');
        labelTo.textContent = 'До';
        labelTo.style.cssText = 'width: 24px; color:#555;';

        const maxInput = document.createElement('input');
        maxInput.id = 'ozof-max';
        maxInput.type = 'text';
        maxInput.inputMode = 'decimal';
        maxInput.placeholder = 'макс';
        maxInput.value = settings.max || '';
        maxInput.style.cssText = `
            flex: 1;
            padding: 8px;
            border: 1px solid #d3d3d3;
            border-radius: 8px;
            font-size: 14px;
        `;

        const buttons = document.createElement('div');
        buttons.style.cssText = `
            display: flex;
            gap: 8px;
            margin-top: 4px;
        `;

        const btnFind = document.createElement('button');
        btnFind.textContent = 'Найти';
        btnFind.style.cssText = `
            flex: 1;
            padding: 10px;
            border: none;
            border-radius: 8px;
            background: #0f0f0f;
            color: #fff;
            cursor: pointer;
            font-weight: 500;
        `;

        const btnClear = document.createElement('button');
        btnClear.textContent = 'Сбросить';
        btnClear.style.cssText = `
            flex: 1;
            padding: 10px;
            border: 1px solid #d3d3d3;
            border-radius: 8px;
            background: #fff;
            color: #0f0f0f;
            cursor: pointer;
            font-weight: 500;
        `;

        const hideRow = document.createElement('div');
        hideRow.style.cssText = 'display:flex; align-items:center; gap:8px; margin-bottom:12px;';

        const hideCheckbox = document.createElement('input');
        hideCheckbox.id = 'ozof-hide';
        hideCheckbox.type = 'checkbox';
        hideCheckbox.checked = settings.hide || false;

        const hideLabel = document.createElement('label');
        hideLabel.textContent = 'Скрыть не подходящие';
        hideLabel.htmlFor = 'ozof-hide';
        hideLabel.style.cssText = 'color:#555; cursor:pointer; user-select:none;';

        hideRow.appendChild(hideCheckbox);
        hideRow.appendChild(hideLabel);

        const statusEl = document.createElement('div');
        statusEl.id = 'ozof-status';
        statusEl.style.cssText = `
            margin-top: 10px;
            color: #555;
            font-size: 13px;
            text-align: center;
            min-height: 18px;
        `;

        btnFind.addEventListener('click', () => {
            filterByPrice();
            observeNewBlocks();
        });

        btnClear.addEventListener('click', resetFilter);

        rowFrom.appendChild(labelFrom);
        rowFrom.appendChild(minInput);
        rowTo.appendChild(labelTo);
        rowTo.appendChild(maxInput);
        buttons.appendChild(btnFind);
        buttons.appendChild(btnClear);

        panel.appendChild(title);
        panel.appendChild(desc);
        panel.appendChild(rowFrom);
        panel.appendChild(rowTo);
        panel.appendChild(hideRow);
        panel.appendChild(buttons);
        panel.appendChild(statusEl);
        document.body.appendChild(panel);

        if (settings.active) {
            filterByPrice();
            observeNewBlocks();
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initUI);
    } else {
        initUI();
    }
})();
