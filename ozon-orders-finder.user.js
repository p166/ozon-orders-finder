// ==UserScript==
// @name         Ozon Orders Finder
// @namespace    http://tampermonkey.net/
// @version      1.8
// @description  Фильтр заказов на странице архива Ozon по диапазону цены с поддержкой динамической подгрузки и базой данных товаров
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

    const SETTINGS_KEY = 'ozon_orders_finder_settings';
    const DATA_KEY = 'ozon_orders_finder_data';

    let blocksObserver = null;
    let yearObserver = null;
    let currentMin = -Infinity;
    let currentMax = Infinity;
    let hideNonMatching = false;
    let isScanning = false;
    let scanAbortController = null;
    let currentYear = null;
    let currentOrdersData = [];

    function getYearFromUrl() {
        const url = new URL(window.location.href);
        const year = url.searchParams.get('selectedYear');
        if (year) return year;
        return getYearFromDom();
    }

    function getYearFromDom() {
        const filtersSection = document.querySelector('[data-widget="orderFilters"]');
        if (!filtersSection) return new Date().getFullYear().toString();

        const activeEl = filtersSection.querySelector('.a2p5_7_0-a9 .a2p5_7_0-a5');
        if (activeEl) {
            const year = activeEl.textContent.trim();
            if (/^\d{4}$/.test(year)) return year;
        }

        const allYearEls = filtersSection.querySelectorAll('.a2p5_7_0-a5');
        for (const el of allYearEls) {
            const year = el.textContent.trim();
            if (/^\d{4}$/.test(year)) return year;
        }

        return new Date().getFullYear().toString();
    }

    function formatDate(dateStr) {
        if (!dateStr) return '';
        const months = {
            'января': '01', 'февраля': '02', 'марта': '03', 'апреля': '04',
            'мая': '05', 'июня': '06', 'июля': '07', 'августа': '08',
            'сентября': '09', 'октября': '10', 'ноября': '11', 'декабря': '12'
        };
        const match = dateStr.match(/(\d{1,2})\s+(\w+)\s+(\d{4})/);
        if (match) {
            const day = match[1].padStart(2, '0');
            const month = months[match[2].toLowerCase()] || '00';
            const year = match[3];
            return `${day}/${month}/${year}`;
        }
        return dateStr;
    }

    function observeYearChange() {
        if (yearObserver) return;

        const setupObserver = (filtersSection) => {
            if (!filtersSection) return false;

            yearObserver = new MutationObserver(() => {
                const newYear = getYearFromDom();
                if (newYear && newYear !== currentYear) {
                    currentYear = newYear;
                    updateScanButton();
                    if (document.getElementById('ozof-orders-modal')) {
                        showOrdersModal();
                    }
                }
            });

            yearObserver.observe(filtersSection, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['class']
            });

            return true;
        };

        const filtersSection = document.querySelector('[data-widget="orderFilters"]');
        if (!setupObserver(filtersSection)) {
            const domObserver = new MutationObserver(() => {
                const fs = document.querySelector('[data-widget="orderFilters"]');
                if (setupObserver(fs)) {
                    domObserver.disconnect();
                }
            });
            domObserver.observe(document.body, { childList: true, subtree: true });
        }
    }

    function getSavedSettings() {
        try {
            const raw = localStorage.getItem(SETTINGS_KEY);
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
            localStorage.setItem(SETTINGS_KEY, JSON.stringify({ min, max, hide, active }));
        } catch (e) {}
    }

    function getSavedData() {
        try {
            const raw = localStorage.getItem(DATA_KEY);
            if (!raw) return {};
            return JSON.parse(raw);
        } catch (e) {
            return {};
        }
    }

    function saveData(data) {
        try {
            localStorage.setItem(DATA_KEY, JSON.stringify(data));
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
        if (blocksObserver) return;

        blocksObserver = new MutationObserver((mutations) => {
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

        blocksObserver.observe(document.body, {
            childList: true,
            subtree: true
        });
    }

    function updateScanButton() {
        const btnScan = document.getElementById('ozof-scan');
        if (!btnScan) return;
        const data = getSavedData();
        const yearData = data[currentYear];
        const hasScanned = yearData && yearData.orders && yearData.orders.length > 0;
        btnScan.textContent = hasScanned ? 'Пересканировать' : 'Сканировать';
    }

    async function getAllOrderLinks() {
        const links = new Set();
        const blocks = document.querySelectorAll('.w9d_11');
        blocks.forEach(block => {
            const link = block.querySelector('a[href*="/orderdetails/"]');
            if (link) {
                const href = link.getAttribute('href');
                const match = href.match(/order=([^&]+)/);
                if (match) links.add(match[1]);
            }
        });
        return Array.from(links);
    }

    async function scrollToBottom() {
        return new Promise((resolve) => {
            const checkScroll = () => {
                window.scrollBy(0, window.innerHeight);
            };
            let lastHeight = document.body.scrollHeight;
            let stableCount = 0;
            const interval = setInterval(() => {
                checkScroll();
                const newHeight = document.body.scrollHeight;
                if (newHeight === lastHeight) {
                    stableCount++;
                    if (stableCount >= 3) {
                        clearInterval(interval);
                        resolve();
                    }
                } else {
                    stableCount = 0;
                    lastHeight = newHeight;
                }
            }, 500);
        });
    }

    async function fetchOrderDetails(orderId) {
        const url = new URL(window.location.href);
        url.pathname = '/my/orderdetails/';
        url.search = `?order=${orderId}&selectedTab=archive`;
        try {
            const response = await fetch(url.toString(), { credentials: 'include' });
            if (!response.ok) return null;
            const html = await response.text();
            return parseOrderDetails(html, orderId);
        } catch (e) {
            return null;
        }
    }

    function parseOrderDetails(html, orderId) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');

        const order = {
            id: orderId,
            date: '',
            items: [],
            total: null,
            delivery: ''
        };

        const titleEl = doc.querySelector('[data-widget="titleWithTimer"] .tsHeadline700XLarge');
        if (titleEl) order.date = titleEl.textContent.trim();

        const totalEl = doc.querySelector('[data-widget="orderDoneTotal"] .tsHeadline500Medium, [data-widget="orderDoneTotal"] .tsHeadline400Small');
        if (totalEl) {
            const match = totalEl.textContent.match(/(\d[\d\s]*[.,]?\d*)\s*[₽рPР]/);
            if (match) order.total = parsePrice(match[1]);
        }

        const deliveryEl = doc.querySelector('[data-widget="orderDetailsItem"] .tsBody400Small');
        if (deliveryEl) order.delivery = deliveryEl.textContent.trim();

        const itemBlocks = doc.querySelectorAll('[data-widget="shipmentWidget"]');
        itemBlocks.forEach(block => {
            const nameEl = block.querySelector('.tsCompact500Medium');
            const priceEl = block.querySelector('.c35_4_0-a1');
            const variantEl = block.querySelector('.tsCompact400Small');

            if (nameEl) {
                order.items.push({
                    name: nameEl.textContent.trim(),
                    price: priceEl ? parsePrice(priceEl.textContent) : null,
                    variant: variantEl ? variantEl.textContent.trim() : ''
                });
            }
        });

        if (order.items.length === 0) {
            const allPriceEls = doc.querySelectorAll('.c35_4_0-a1');
            const allTextEls = doc.querySelectorAll('.tsCompact500Medium');
            const minLen = Math.min(allPriceEls.length, allTextEls.length);
            for (let i = 0; i < minLen; i++) {
                order.items.push({
                    name: allTextEls[i].textContent.trim(),
                    price: parsePrice(allPriceEls[i].textContent),
                    variant: ''
                });
            }
        }

        return order;
    }

    async function scanAllOrders(onProgress) {
        if (isScanning) return;
        isScanning = true;
        scanAbortController = new AbortController();

        const btnScan = document.getElementById('ozof-scan');
        if (btnScan) btnScan.disabled = true;

        try {
            await scrollToBottom();
            let orderIds = await getAllOrderLinks();

            if (orderIds.length === 0) {
                alert('Заказы не найдены на странице');
                return;
            }

            const data = getSavedData();
            const yearData = data[currentYear] || { orders: [] };
            const existingIds = new Set(yearData.orders.map(o => o.id));
            const isRescan = existingIds.size > 0;
            const ordersToScan = isRescan ? orderIds : orderIds.filter(id => !existingIds.has(id));

            let processed = 0;
            const total = ordersToScan.length;
            yearData.scannedAt = new Date().toISOString();

            if (isRescan) {
                yearData.orders = [];
            }

            const batchSize = 3;
            for (let i = 0; i < total; i += batchSize) {
                if (scanAbortController.signal.aborted) break;

                const batch = ordersToScan.slice(i, i + batchSize);
                const results = await Promise.all(batch.map(id => fetchOrderDetails(id)));

                results.forEach(result => {
                    if (result) {
                        yearData.orders.push(result);
                    }
                });

                processed += batch.length;
                if (onProgress) onProgress(processed, total);

                await new Promise(resolve => setTimeout(resolve, 800));
            }

            data[currentYear] = yearData;
            saveData(data);

            alert(`Сканирование завершено. Обработано ${processed} заказов`);
            updateScanButton();
        } catch (e) {
            console.error('Scan error:', e);
            alert('Ошибка при сканировании: ' + e.message);
        } finally {
            isScanning = false;
            scanAbortController = null;
            if (btnScan) btnScan.disabled = false;
            updateScanButton();
        }
    }

    function showOrdersModal() {
        const existing = document.getElementById('ozof-orders-modal');
        if (existing) {
            existing.remove();
            return;
        }

        const data = getSavedData();
        const allYears = Object.keys(data).sort((a, b) => b.localeCompare(a));
        if (allYears.length === 0) {
            alert('Нет сканированных заказов. Нажмите "Сканировать" для сбора данных.');
            return;
        }

        currentOrdersData = [];
        allYears.forEach(year => {
            const yearData = data[year];
            if (yearData && yearData.orders) {
                yearData.orders.forEach(order => {
                    order.items.forEach(item => {
                        currentOrdersData.push({
                            ...item,
                            orderId: order.id,
                            orderDate: order.date,
                            delivery: order.delivery,
                            orderTotal: order.total,
                            year: year
                        });
                    });
                });
            }
        });

        if (currentOrdersData.length === 0) {
            alert('Нет сканированных заказов. Нажмите "Сканировать" для сбора данных.');
            return;
        }

        const modal = document.createElement('div');
        modal.id = 'ozof-orders-modal';
        modal.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0,0,0,0.5);
            z-index: 9999999;
            display: flex;
            align-items: center;
            justify-content: center;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        `;

        const content = document.createElement('div');
        content.style.cssText = `
            background: #fff;
            border-radius: 16px;
            width: 90%;
            max-width: 1200px;
            height: 85vh;
            display: flex;
            flex-direction: column;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
        `;

        const header = document.createElement('div');
        header.style.cssText = `
            padding: 20px 24px;
            border-bottom: 1px solid #e5e5e5;
            display: flex;
            justify-content: space-between;
            align-items: center;
        `;

        const title = document.createElement('h2');
        title.textContent = 'Все заказы';
        title.style.cssText = 'margin: 0; font-size: 20px; font-weight: 600;';

        const closeBtn = document.createElement('button');
        closeBtn.textContent = '✕';
        closeBtn.style.cssText = `
            background: none;
            border: none;
            font-size: 24px;
            cursor: pointer;
            color: #666;
            padding: 0;
            width: 32px;
            height: 32px;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 8px;
        `;
        closeBtn.onmouseenter = () => closeBtn.style.background = '#f5f5f5';
        closeBtn.onmouseleave = () => closeBtn.style.background = 'none';
        closeBtn.onclick = () => modal.remove();

        const controls = document.createElement('div');
        controls.style.cssText = `
            padding: 16px 24px;
            border-bottom: 1px solid #e5e5e5;
            display: flex;
            gap: 16px;
            align-items: center;
        `;

        const searchInput = document.createElement('input');
        searchInput.type = 'text';
        searchInput.placeholder = 'Поиск по названию товара...';
        searchInput.style.cssText = `
            flex: 1;
            padding: 10px 14px;
            border: 1px solid #d3d3d3;
            border-radius: 8px;
            font-size: 14px;
            outline: none;
        `;

        const countLabel = document.createElement('span');
        countLabel.id = 'ozof-orders-count';
        countLabel.style.cssText = 'color: #666; font-size: 14px; white-space: nowrap;';

        controls.appendChild(searchInput);
        controls.appendChild(countLabel);

        const tableContainer = document.createElement('div');
        tableContainer.style.cssText = `
            flex: 1;
            overflow: auto;
            padding: 0;
        `;

        const table = document.createElement('table');
        table.style.cssText = `
            width: 100%;
            border-collapse: collapse;
            font-size: 14px;
        `;

        const thead = document.createElement('thead');
        thead.style.cssText = 'position: sticky; top: 0; background: #f9f9f9; z-index: 1;';

        const headerRow = document.createElement('tr');
        const headers = [
            { key: 'year', label: 'Год', width: '60px' },
            { key: 'orderDate', label: 'Дата', width: '120px' },
            { key: 'name', label: 'Название', width: 'auto' },
            { key: 'price', label: 'Цена', width: '100px' },
            { key: 'orderId', label: 'Заказ', width: '130px' }
        ];

        let sortKey = 'orderDate';
        let sortDir = 'desc';

        headers.forEach(h => {
            const th = document.createElement('th');
            th.textContent = h.label + (sortKey === h.key ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '');
            th.style.cssText = `
                padding: 12px 16px;
                text-align: left;
                font-weight: 600;
                color: #333;
                border-bottom: 2px solid #e5e5e5;
                cursor: pointer;
                user-select: none;
                width: ${h.width};
            `;
            th.onclick = () => {
                if (sortKey === h.key) {
                    sortDir = sortDir === 'asc' ? 'desc' : 'asc';
                } else {
                    sortKey = h.key;
                    sortDir = 'asc';
                }
                renderTable();
            };
            headerRow.appendChild(th);
        });

        thead.appendChild(headerRow);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        table.appendChild(tbody);

        function renderTable() {
            const query = searchInput.value.toLowerCase().trim();
            let filtered = currentOrdersData;

            if (query) {
                filtered = filtered.filter(item => item.name.toLowerCase().includes(query));
            }

            filtered.sort((a, b) => {
                let aVal = a[sortKey];
                let bVal = b[sortKey];

                if (sortKey === 'price') {
                    aVal = aVal || 0;
                    bVal = bVal || 0;
                } else if (sortKey === 'orderDate') {
                    aVal = aVal || '';
                    bVal = bVal || '';
                }

                if (aVal < bVal) return sortDir === 'asc' ? -1 : 1;
                if (aVal > bVal) return sortDir === 'asc' ? 1 : -1;
                return 0;
            });

            tbody.innerHTML = '';

            if (filtered.length === 0) {
                const tr = document.createElement('tr');
                const td = document.createElement('td');
                td.colSpan = 5;
                td.textContent = 'Ничего не найдено';
                td.style.cssText = 'padding: 40px; text-align: center; color: #999;';
                tr.appendChild(td);
                tbody.appendChild(tr);
            } else {
                filtered.forEach(item => {
                    const tr = document.createElement('tr');
                    tr.style.cssText = 'cursor: pointer; transition: background 0.15s;';
                    tr.onmouseenter = () => tr.style.background = '#f5f5f5';
                    tr.onmouseleave = () => tr.style.background = '';

                    tr.onclick = () => {
                        document.querySelectorAll('#ozof-orders-modal tbody tr').forEach(r => r.style.background = '');
                        tr.style.background = '#e3f2fd';
                    };

                    const yearTd = document.createElement('td');
                    yearTd.textContent = item.year || '';
                    yearTd.style.cssText = 'padding: 12px 16px; border-bottom: 1px solid #eee; color: #666;';

                    const dateTd = document.createElement('td');
                    dateTd.textContent = formatDate(item.orderDate) || '';
                    dateTd.style.cssText = 'padding: 12px 16px; border-bottom: 1px solid #eee; color: #666;';

                    const nameTd = document.createElement('td');
                    nameTd.textContent = item.name || '';
                    nameTd.style.cssText = 'padding: 12px 16px; border-bottom: 1px solid #eee;';

                    const priceTd = document.createElement('td');
                    priceTd.textContent = item.price ? `${item.price} ₽` : '';
                    priceTd.style.cssText = 'padding: 12px 16px; border-bottom: 1px solid #eee; font-weight: 500;';

                    const orderTd = document.createElement('td');
                    const orderLink = document.createElement('a');
                    orderLink.textContent = item.orderId || '';
                    orderLink.href = `/my/orderdetails/?order=${item.orderId}&selectedTab=archive`;
                    orderLink.target = '_blank';
                    orderLink.style.cssText = 'color: #0066cc; text-decoration: none;';
                    orderLink.onmouseenter = () => orderLink.style.textDecoration = 'underline';
                    orderLink.onmouseleave = () => orderLink.style.textDecoration = 'none';
                    orderTd.appendChild(orderLink);
                    orderTd.style.cssText = 'padding: 12px 16px; border-bottom: 1px solid #eee;';

                    tr.appendChild(yearTd);
                    tr.appendChild(dateTd);
                    tr.appendChild(nameTd);
                    tr.appendChild(priceTd);
                    tr.appendChild(orderTd);
                    tbody.appendChild(tr);
                });
            }

            countLabel.textContent = `Показано: ${filtered.length} из ${currentOrdersData.length}`;
        }

        searchInput.addEventListener('input', renderTable);

        tableContainer.appendChild(table);
        content.appendChild(header);
        content.appendChild(controls);
        content.appendChild(tableContainer);
        modal.appendChild(content);
        document.body.appendChild(modal);

        renderTable();

        modal.onclick = (e) => {
            if (e.target === modal) modal.remove();
        };
    }

    function initUI() {
        if (document.getElementById('ozof-panel')) return;

        currentYear = getYearFromUrl();

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

        const scanRow = document.createElement('div');
        scanRow.style.cssText = 'display:flex; gap:8px; margin-top:12px;';

        const btnScan = document.createElement('button');
        btnScan.id = 'ozof-scan';
        btnScan.textContent = 'Сканировать';
        btnScan.style.cssText = `
            width: 100%;
            padding: 10px;
            border: none;
            border-radius: 8px;
            background: #0066cc;
            color: #fff;
            cursor: pointer;
            font-weight: 500;
        `;

        const btnAllOrders = document.createElement('button');
        btnAllOrders.textContent = 'Все заказы';
        btnAllOrders.style.cssText = `
            width: 100%;
            margin-top: 8px;
            padding: 10px;
            border: 1px solid #0066cc;
            border-radius: 8px;
            background: #fff;
            color: #0066cc;
            cursor: pointer;
            font-weight: 500;
        `;

        scanRow.appendChild(btnScan);

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

        btnScan.addEventListener('click', async () => {
            if (isScanning) return;
            const data = getSavedData();
            const yearData = data[currentYear];
            const hasScanned = yearData && yearData.orders && yearData.orders.length > 0;
            const confirmed = confirm(hasScanned ? 'Пересканировать все заказы за ' + currentYear + ' год?' : 'Сканировать все заказы за ' + currentYear + ' год?\nЭто может занять несколько минут.');
            if (!confirmed) return;

            btnScan.textContent = 'Сканирование...';
            await scanAllOrders((processed, total) => {
                if (statusEl) {
                    statusEl.textContent = `Сканирование: ${processed}/${total}`;
                }
            });
            updateScanButton();
        });

        btnAllOrders.addEventListener('click', showOrdersModal);

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
        panel.appendChild(scanRow);
        panel.appendChild(btnAllOrders);
        panel.appendChild(statusEl);
        document.body.appendChild(panel);

        if (settings.active) {
            filterByPrice();
            observeNewBlocks();
        }

        updateScanButton();
        observeYearChange();

        setTimeout(() => {
            const domYear = getYearFromDom();
            if (domYear && domYear !== currentYear) {
                currentYear = domYear;
                updateScanButton();
            }
        }, 1000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initUI);
    } else {
        initUI();
    }
})();
