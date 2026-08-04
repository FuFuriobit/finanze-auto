// ============================================
// URL DEL TUO CLOUDFLARE WORKER
// ============================================
const WORKER_URL = "https://my-yahoo-proxy.vegekou95-at.workers.dev/";

// ============================================
// PORTAFOGLIO DI DEFAULT (TICKER BTCW.MI per il prezzo in EUR!)
// ============================================
const portafoglioDefault = [
    { isin: "IT0003132476", ticker: "ENI.MI", nome: "Eni S.p.A.", tipo: "Azione", acquisti: [] },
    { isin: "IE00B579F325", ticker: "SGLD.MI", nome: "WisdomTree Physical Gold", tipo: "ETC", acquisti: [] },
    { isin: "IE00BGYWCB81", ticker: "VDEA.MI", nome: "Vanguard USD Emerging Markets Gov Bond", tipo: "ETF", acquisti: [] },
    { isin: "LU1407890620", ticker: "US10.MI", nome: "Amundi US Treasury Bond 7-10Y", tipo: "ETF", acquisti: [] },
    { isin: "LU1650489385", ticker: "MTE.PA", nome: "Amundi Euro Gov Bond 10-15Y", tipo: "ETF", acquisti: [] },
    { isin: "LU1829218749", ticker: "COMO.PA", nome: "Amundi Commodity Index", tipo: "ETF", acquisti: [] },
    { isin: "GB00BJYDH287", ticker: "BTCW.MI", nome: "WisdomTree Physical Bitcoin", tipo: "ETN", acquisti: [] }, // ✅ Prezzo in EUR!
    { isin: "LU0290358497", ticker: "XEON.DE", nome: "Xtrackers II EUR Overnight Rate Swap", tipo: "ETF", acquisti: [] }
];

// Caricamento portafoglio da localStorage
let portafoglio = JSON.parse(localStorage.getItem("mio_portafoglio_lotti")) || portafoglioDefault;
let prezziCorrenti = {};
let assetInModifica = null;
let graficoIstanza = null;
let isDarkMode = localStorage.getItem("theme_dark") === "true";

// Cache per ridurre le chiamate al Worker
const cachePrezzi = new Map();
const CACHE_DURATION = 60000; // 1 minuto

// ============================================
// FUNZIONI DI TEMA
// ============================================
function applicaTema() {
    if (isDarkMode) {
        document.body.classList.add("dark-mode");
        const btn = document.getElementById("btn-theme-toggle");
        if(btn) btn.innerText = "☀️ Tema Chiaro";
    } else {
        document.body.classList.remove("dark-mode");
        const btn = document.getElementById("btn-theme-toggle");
        if(btn) btn.innerText = "🌙 Tema Scuro";
    }
    if (graficoIstanza) aggiornaGrafico();
}

function toggleDarkMode() {
    isDarkMode = !isDarkMode;
    localStorage.setItem("theme_dark", isDarkMode);
    applicaTema();
}

// ============================================
// FUNZIONI DI CALCOLO
// ============================================
function calcolaTotaliAsset(acquisti) {
    if (!acquisti || !Array.isArray(acquisti) || acquisti.length === 0) {
        return { quoteTotali: 0, pmcPonderato: 0 };
    }
    let quoteTotali = 0, costoTotale = 0;
    acquisti.forEach(acc => {
        const q = parseFloat(acc.quote) || 0;
        const p = parseFloat(acc.prezzo) || 0;
        quoteTotali += q;
        costoTotale += (q * p);
    });
    return { quoteTotali, pmcPonderato: quoteTotali > 0 ? (costoTotale / quoteTotali) : 0 };
}

// ============================================
// FETCH TRAMITE CLOUDFLARE WORKER
// ============================================
async function fetchTickerData(ticker, range = "1d", interval = "1m") {
    const cacheKey = `${ticker}_${range}_${interval}`;
    const now = Date.now();
    
    // Controlla la cache
    if (cachePrezzi.has(cacheKey)) {
        const cached = cachePrezzi.get(cacheKey);
        if (now - cached.timestamp < CACHE_DURATION) {
            return cached.data;
        }
    }
    
    try {
        const url = `${WORKER_URL}?ticker=${encodeURIComponent(ticker)}&range=${range}&interval=${interval}`;
        console.log("Chiamata Worker:", url);
        
        const response = await fetch(url, {
            signal: AbortSignal.timeout(10000)
        });
        
        if (!response.ok) {
            console.error("Errore response:", response.status);
            return null;
        }
        
        const data = await response.json();
        console.log("Dati ricevuti per", ticker, data);
        
        if (data && data.chart && data.chart.result && data.chart.result.length > 0) {
            // Salva in cache
            cachePrezzi.set(cacheKey, {
                data: data.chart.result[0],
                timestamp: now
            });
            return data.chart.result[0];
        } else if (data && data.error) {
            console.error("Errore dal Worker:", data.error);
        }
    } catch (e) {
        console.error("Errore fetch Worker per", ticker, ":", e);
    }
    return null;
}

// ============================================
// RECUPERO DATI ASSET (con BTCW.MI per il prezzo in EUR)
// ============================================
async function recuperaDatiAsset(item) {
    try {
        // PER L'ETN BITCOIN - Usa BTCW.MI per il prezzo in EUR
        if (item.isin === "GB00BJYDH287") {
            const res = await fetchTickerData("BTCW.MI", "1d", "1m");
            
            if (res && res.meta) {
                const meta = res.meta;
                let prezzoAttuale = meta.regularMarketPrice || meta.previousClose || 0;
                
                if (res.indicators && res.indicators.quote && res.indicators.quote[0] && res.indicators.quote[0].close) {
                    const arr = res.indicators.quote[0].close.filter(v => v !== null && v !== undefined && !isNaN(v) && v > 0);
                    if (arr.length > 0) {
                        prezzoAttuale = arr[arr.length - 1];
                    }
                }
                
                if (prezzoAttuale > 0) {
                    const prezzoIeri = meta.chartPreviousClose || meta.previousClose || prezzoAttuale;
                    console.log("✅ Prezzo Bitcoin in EUR (BTCW.MI):", prezzoAttuale);
                    return {
                        prezzo: parseFloat(prezzoAttuale),
                        varGiornaliera: (prezzoIeri > 0 && prezzoAttuale > 0) ? ((prezzoAttuale - prezzoIeri) / prezzoIeri) * 100 : 0
                    };
                }
            }
            
            console.error("❌ Ticker BTCW.MI non ha restituito dati");
            return { prezzo: 0, varGiornaliera: 0 };
        }
        
        // PER TUTTI GLI ALTRI ASSET
        const res = await fetchTickerData(item.ticker, "1d", "1m");
        
        if (res && res.meta) {
            const meta = res.meta;
            let prezzoAttuale = meta.regularMarketPrice || meta.previousClose || 0;
            
            if (res.indicators && res.indicators.quote && res.indicators.quote[0] && res.indicators.quote[0].close) {
                const arr = res.indicators.quote[0].close.filter(v => v !== null && v !== undefined && !isNaN(v) && v > 0);
                if (arr.length > 0) {
                    prezzoAttuale = arr[arr.length - 1];
                }
            }
            
            if (prezzoAttuale > 0) {
                const prezzoIeri = meta.chartPreviousClose || meta.previousClose || prezzoAttuale;
                return {
                    prezzo: parseFloat(prezzoAttuale),
                    varGiornaliera: (prezzoIeri > 0 && prezzoAttuale > 0) ? ((prezzoAttuale - prezzoIeri) / prezzoIeri) * 100 : 0
                };
            }
        }
    } catch(err) {
        console.error("Errore recupero dati per", item.ticker, err);
    }

    return { prezzo: 0, varGiornaliera: 0 };
}

// ============================================
// FUNZIONI DI UTILITY
// ============================================
function isAssetCrypto(item) {
    const t = item.tipo ? item.tipo.toLowerCase() : "";
    const ticker = item.ticker ? item.ticker.toUpperCase() : "";
    const isin = item.isin ? item.isin.toUpperCase() : "";

    return t === "crypto" || 
           t === "etn" ||
           ticker.includes("BTC") || 
           isin === "GB00BJYDH287";
}

function formattaBadgeSummary(valoreTotale, investitoTotale) {
    const pnlEuro = valoreTotale - investitoTotale;
    const pnlPerc = investitoTotale > 0 ? (pnlEuro / investitoTotale) * 100 : 0;
    const classTotale = pnlEuro >= 0 ? "pos" : "neg";
    const segno = pnlEuro >= 0 ? "+" : "";

    return `
        <strong>${valoreTotale.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €</strong>
        <span class="${classTotale}" style="margin-left: 4px;">
            (${segno}${pnlEuro.toFixed(2)} € / ${segno}${pnlPerc.toFixed(2)}%)
        </span>
    `;
}

// ============================================
// AGGIORNAMENTO PORTAFOGLIO
// ============================================
async function aggiornaTutto() {
    console.log("🔄 Aggiornamento portafoglio in corso...");
    let rowsHtml = "";
    let valTot = 0, invTot = 0;
    let valCrypto = 0, invCrypto = 0;
    let valTrad = 0, invTrad = 0;
    
    const risultati = await Promise.all(portafoglio.map(item => recuperaDatiAsset(item)));
    risultati.forEach((dati, index) => {
        if (dati && dati.prezzo > 0) {
            prezziCorrenti[portafoglio[index].ticker] = dati;
        }
    });

    for (let i = 0; i < portafoglio.length; i++) {
        const item = portafoglio[i];
        const datiUsati = prezziCorrenti[item.ticker] || { prezzo: 0, varGiornaliera: 0 };
        const hasError = datiUsati.prezzo <= 0;
        
        const { quoteTotali, pmcPonderato } = calcolaTotaliAsset(item.acquisti);
        const valoreTotale = hasError ? 0 : (quoteTotali * datiUsati.prezzo);
        const investito = quoteTotali * pmcPonderato;
        const pnlEuro = valoreTotale - investito;
        const pnlPerc = pmcPonderato > 0 ? ((datiUsati.prezzo - pmcPonderato) / pmcPonderato) * 100 : 0;

        if (!hasError && quoteTotali > 0) {
            valTot += valoreTotale;
            invTot += investito;

            if (isAssetCrypto(item)) {
                valCrypto += valoreTotale;
                invCrypto += investito;
            } else {
                valTrad += valoreTotale;
                invTrad += investito;
            }
        }
        
        const classPnl = pnlEuro >= 0 ? "pos" : "neg";
        const classVar = datiUsati.varGiornaliera >= 0 ? "pos" : "neg";
        const numAcquisti = item.acquisti ? item.acquisti.length : 0;

        rowsHtml += `
            <tr>
                <td>
                    <button class="btn-order" onclick="spostaSu(${i})" ${i === 0 ? "disabled" : ""}>⬆️</button>
                    <button class="btn-order" onclick="spostaGiu(${i})" ${i === portafoglio.length - 1 ? "disabled" : ""}>⬇️</button>
                </td>
                <td>
                    <strong>${item.nome}</strong> 
                    <span class="tag">${item.tipo}</span>
                    <br><small style="color:var(--subtext-color)">${item.isin} (${item.ticker})</small>
                </td>
                <td><strong>${!hasError ? datiUsati.prezzo.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €' : '⚠️ Errore Ticker'}</strong></td>
                <td><strong>${quoteTotali}</strong></td>
                <td>${pmcPonderato.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €</td>
                <td><strong>${!hasError ? valoreTotale.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €' : 'N/D'}</strong></td>
                <td class="${!hasError ? classPnl : ''}">${!hasError ? (pnlEuro >= 0 ? '+' : '') + pnlEuro.toFixed(2) + ' € (' + pnlPerc.toFixed(2) + '%)' : 'N/D'}</td>
                <td class="${!hasError ? classVar : ''}">${!hasError ? (datiUsati.varGiornaliera >= 0 ? '+' : '') + datiUsati.varGiornaliera.toFixed(2) + '%' : 'N/D'}</td>
                <td>
                    <button class="btn btn-sm" onclick="apriModalLotti(${i})">📝 Acquisti (${numAcquisti})</button>
                    <button class="btn btn-sm btn-danger" onclick="eliminaAsset(${i})" title="Elimina Asset">🗑️</button>
                </td>
            </tr>
        `;
    }

    document.getElementById("total-portfolio-summary").innerHTML = formattaBadgeSummary(valTot, invTot);
    document.getElementById("total-crypto-summary").innerHTML = formattaBadgeSummary(valCrypto, invCrypto);
    document.getElementById("total-trad-summary").innerHTML = formattaBadgeSummary(valTrad, invTrad);
    
    document.getElementById("portfolio-body").innerHTML = rowsHtml;
    document.getElementById("last-update").innerText = `Ultimo aggiornamento: ${new Date().toLocaleTimeString('it-IT')}`;
    
    popolaSelectAsset();
    console.log("✅ Aggiornamento completato");
}

// ============================================
// FUNZIONI GRAFICO
// ============================================
function popolaSelectAsset() {
    const select = document.getElementById("chart-asset-select");
    if (!select) return;
    const valoreSelezionato = select.value;
    select.innerHTML = '<option value="PORTAFOGLIO">Totale Portafoglio</option>';

    portafoglio.forEach(item => {
        const opt = document.createElement("option");
        opt.value = item.isin;
        opt.innerText = `${item.nome} (${item.isin})`;
        select.appendChild(opt);
    });

    select.value = valoreSelezionato || "PORTAFOGLIO";
    aggiornaGrafico();
}

async function aggiornaGrafico() {
    const selectAsset = document.getElementById("chart-asset-select");
    const selectRange = document.getElementById("chart-range-select");
    if (!selectAsset || !selectRange) return;

    const isinSelezionato = selectAsset.value;
    const range = selectRange.value;

    let interval = "1wk";
    if (range === "1mo") interval = "1d";
    if (range === "5y") interval = "1mo";

    if (isinSelezionato !== "PORTAFOGLIO") {
        const item = portafoglio.find(p => p.isin === isinSelezionato);
        if (!item) return;

        let tickerTarget = item.ticker;
        if (item.isin === "GB00BJYDH287") tickerTarget = "BTCW.MI";

        const res = await fetchTickerData(tickerTarget, range, interval);

        if (res && res.timestamp && res.indicators?.quote[0]?.close) {
            const timestamps = res.timestamp;
            const closes = res.indicators.quote[0].close;
            const labels = [];
            const data = [];

            for (let i = 0; i < timestamps.length; i++) {
                if (closes[i] !== null && closes[i] !== undefined) {
                    labels.push(new Date(timestamps[i] * 1000).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: '2-digit' }));
                    data.push(closes[i]);
                }
            }
            renderizzaGrafico(labels, data, `Prezzo ${item.nome} (€)`);
        }
    } else {
        const assetAcquistati = portafoglio.filter(item => {
            const { quoteTotali } = calcolaTotaliAsset(item.acquisti);
            return quoteTotali > 0;
        });

        if (assetAcquistati.length === 0) {
            renderizzaGrafico([], [], "Aggiungi quote agli asset per vedere il totale");
            return;
        }

        const primoAsset = assetAcquistati[0];
        let tickerGuida = primoAsset.ticker;
        if (primoAsset.isin === "GB00BJYDH287") tickerGuida = "BTCW.MI";

        const resGuida = await fetchTickerData(tickerGuida, range, interval);

        if (resGuida && resGuida.timestamp) {
            const labels = resGuida.timestamp.map(ts => new Date(ts * 1000).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: '2-digit' }));
            const dataTotale = new Array(labels.length).fill(0);

            for (let item of assetAcquistati) {
                const { quoteTotali } = calcolaTotaliAsset(item.acquisti);
                let tickerCurrent = item.ticker;
                if (item.isin === "GB00BJYDH287") tickerCurrent = "BTCW.MI";

                const r = await fetchTickerData(tickerCurrent, range, interval);
                
                if (r && r.indicators?.quote[0]?.close) {
                    const closes = r.indicators.quote[0].close;
                    for (let i = 0; i < labels.length; i++) {
                        const p = closes[i] || closes[closes.length - 1] || 0;
                        dataTotale[i] += (p * quoteTotali);
                    }
                }
            }
            renderizzaGrafico(labels, dataTotale, "Valore Totale Portafoglio (€)");
        }
    }
}

function renderizzaGrafico(labels, data, label) {
    const canvas = document.getElementById("portfolioChart");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");

    if (graficoIstanza) {
        graficoIstanza.destroy();
    }

    const colorText = isDarkMode ? '#94a3b8' : '#64748b';
    const colorGrid = isDarkMode ? '#334155' : '#e2e8f0';

    graficoIstanza = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: label,
                data: data,
                borderColor: '#2563eb',
                backgroundColor: 'rgba(37, 99, 235, 0.15)',
                borderWidth: 2,
                fill: true,
                tension: 0.2,
                pointRadius: labels.length > 50 ? 0 : 3
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { labels: { color: colorText } }
            },
            scales: {
                x: {
                    grid: { display: false },
                    ticks: { color: colorText }
                },
                y: {
                    grid: { color: colorGrid },
                    ticks: {
                        color: colorText,
                        callback: function(value) {
                            return value.toLocaleString('it-IT', { minimumFractionDigits: 2 }) + ' €';
                        }
                    }
                }
            }
        }
    });
}

// ============================================
// FUNZIONI MODALI
// ============================================
function apriModalLotti(index) {
    assetInModifica = index;
    const item = portafoglio[index];
    document.getElementById("modal-title").innerText = `Gestisci Acquisti per ${item.nome}`;
    const container = document.getElementById("lotti-container");
    container.innerHTML = "";
    if (!item.acquisti || item.acquisti.length === 0) {
        aggiungiRigaLotto();
    } else {
        item.acquisti.forEach(acc => aggiungiRigaLotto(acc.quote, acc.prezzo));
    }
    document.getElementById("modal-lotti").style.display = "flex";
}

function aggiungiRigaLotto(quote = "", prezzo = "") {
    const container = document.getElementById("lotti-container");
    const div = document.createElement("div");
    div.className = "lotto-row";
    div.innerHTML = `
        <input type="number" placeholder="Quote" value="${quote}" step="any" class="input-quote" style="width: 100px;">
        <input type="number" placeholder="Prezzo (€)" value="${prezzo}" step="any" class="input-prezzo" style="width: 100px;">
        <button class="btn btn-reset btn-sm" onclick="this.parentElement.remove()">❌</button>
    `;
    container.appendChild(div);
}

function apriModalNuovoAsset() {
    document.getElementById("new-nome").value = "";
    document.getElementById("new-isin").value = "";
    document.getElementById("new-ticker").value = "";
    document.getElementById("modal-asset").style.display = "flex";
}

function chiudiModal(modalId) {
    document.getElementById(modalId).style.display = "none";
    assetInModifica = null;
}

function salvaLottiModal() {
    if (assetInModifica === null) return;
    const container = document.getElementById("lotti-container");
    const righe = container.querySelectorAll(".lotto-row");
    const nuoviAcquisti = [];
    righe.forEach(riga => {
        const q = parseFloat(riga.querySelector(".input-quote").value);
        const p = parseFloat(riga.querySelector(".input-prezzo").value);
        if (!isNaN(q) && !isNaN(p) && q > 0) nuoviAcquisti.push({ quote: q, prezzo: p });
    });
    portafoglio[assetInModifica].acquisti = nuoviAcquisti;
    salvaESincronizza();
    chiudiModal('modal-lotti');
}

function salvaNuovoAsset() {
    const nome = document.getElementById("new-nome").value.trim();
    const isin = document.getElementById("new-isin").value.trim().toUpperCase();
    const ticker = document.getElementById("new-ticker").value.trim().toUpperCase();
    const tipo = document.getElementById("new-tipo").value;

    if (!nome || !isin || !ticker) {
        alert("Compila tutti i campi richiesti!");
        return;
    }

    portafoglio.push({ isin, ticker, nome, tipo, acquisti: [] });
    salvaESincronizza();
    chiudiModal('modal-asset');
}

// ============================================
// FUNZIONI DI GESTIONE PORTAFOGLIO
// ============================================
function eliminaAsset(index) {
    const item = portafoglio[index];
    if (confirm(`Sei sicuro di voler eliminare "${item.nome}" (${item.isin})?`)) {
        portafoglio.splice(index, 1);
        salvaESincronizza();
    }
}

function spostaSu(index) {
    if (index > 0) {
        const temp = portafoglio[index];
        portafoglio[index] = portafoglio[index - 1];
        portafoglio[index - 1] = temp;
        salvaESincronizza();
    }
}

function spostaGiu(index) {
    if (index < portafoglio.length - 1) {
        const temp = portafoglio[index];
        portafoglio[index] = portafoglio[index + 1];
        portafoglio[index + 1] = temp;
        salvaESincronizza();
    }
}

function salvaESincronizza() {
    localStorage.setItem("mio_portafoglio_lotti", JSON.stringify(portafoglio));
    aggiornaTutto();
}

function resetPortafoglio() {
    if (confirm("Attenzione: questo ripristinerà il portafoglio iniziale e cancellerà le quote inserite. Continuare?")) {
        localStorage.clear();
        location.reload();
    }
}

// ============================================
// AVVIO
// ============================================
applicaTema();
aggiornaTutto();
// Aggiornamento ogni 5 minuti (300000 ms)
setInterval(aggiornaTutto, 300000);