// ============================================
// CONFIGURAZIONE
// ============================================
const WORKER_URL = "https://my-yahoo-proxy.vegekou95-at.workers.dev";
const AGGIORNAMENTO_INTERVALLO = 60000; // 60 secondi
const RETRY_INTERVALLO = 30000;
const MAX_RETRY = 10;
const SYNC_PULL_INTERVALLO = 60000; // pull cloud ogni 60 secondi

// Cache per i prezzi (persistente in localStorage)
const CACHE_CHIAVE = "prezzi_etf_cache";
const PORTAFOGLIO_CHIAVE = "mio_portafoglio_lotti";
const PENDING_SYNC_CHIAVE = "mio_portafoglio_pending_sync";

// ============================================
// CONFIGURAZIONE GRAFICO
// ============================================
const COLORI_CRYPTO = '#f7931a';
const COLORI_ETF = '#2563eb';
const COLORI_ETN = '#8b5cf6';
const COLORI_AZIONI = '#22c55e';

// ============================================
// GESTIONE CACHE PERSISTENTE
// ============================================
function caricaCache() {
    try {
        const data = localStorage.getItem(CACHE_CHIAVE);
        return data ? JSON.parse(data) : {};
    } catch (e) {
        return {};
    }
}

function salvaCache(cache) {
    try {
        localStorage.setItem(CACHE_CHIAVE, JSON.stringify(cache));
    } catch (e) {
        console.error("Errore salvataggio cache:", e);
    }
}

// ============================================
// PORTAFOGLIO DI DEFAULT
// ============================================
const portafoglioDefault = [
    { isin: "IT0003132476", ticker: "ENI.MI", nome: "Eni S.p.A.", tipo: "Azione", acquisti: [] },
    { isin: "IE00B579F325", ticker: "SGLD.MI", nome: "WisdomTree Physical Gold", tipo: "ETC", acquisti: [] },
    { isin: "IE00BGYWCB81", ticker: "VDEA.MI", nome: "Vanguard USD Emerging Markets Gov Bond", tipo: "ETF", acquisti: [] },
    { isin: "LU1407890620", ticker: "US10.MI", nome: "Amundi US Treasury Bond 7-10Y", tipo: "ETF", acquisti: [] },
    { isin: "LU1650489385", ticker: "MTE.PA", nome: "Amundi Euro Gov Bond 10-15Y", tipo: "ETF", acquisti: [] },
    { isin: "LU1829218749", ticker: "COMO.PA", nome: "Amundi Commodity Index", tipo: "ETF", acquisti: [] },
    { isin: "GB00BJYDH287", ticker: "BTCW.MI", nome: "WisdomTree Physical Bitcoin", tipo: "ETN", acquisti: [] },
    { isin: "LU0290358497", ticker: "XEON.DE", nome: "Xtrackers II EUR Overnight Rate Swap", tipo: "ETF", acquisti: [] }
];

let portafoglio = [];
let prezziCorrenti = {};
let assetInModifica = null;
let graficoIstanza = null;
let isDarkMode = localStorage.getItem("theme_dark") === "true";

// Cache in memoria
let cachePrezzi = caricaCache();
let aggiornamentoInCorso = false;
let prezzoBitcoinValido = false;
let saveQueue = Promise.resolve();
let pullCloudInCorso = false;

function workerUrl(path = "", params = {}) {
    const url = new URL(path, WORKER_URL + "/");
    Object.entries(params).forEach(([key, value]) => {
        if (value !== null && value !== undefined) {
            url.searchParams.set(key, value);
        }
    });
    return url.toString();
}

function isPortafoglioValido(data) {
    return Array.isArray(data) && data.every(item =>
        item &&
        typeof item.isin === "string" &&
        typeof item.ticker === "string" &&
        typeof item.nome === "string" &&
        Array.isArray(item.acquisti)
    );
}

function leggiPortafoglioLocale() {
    try {
        const data = JSON.parse(localStorage.getItem(PORTAFOGLIO_CHIAVE) || "[]");
        return isPortafoglioValido(data) ? data : null;
    } catch (e) {
        return null;
    }
}

function salvaPortafoglioLocale(dati, pendingSync = false) {
    localStorage.setItem(PORTAFOGLIO_CHIAVE, JSON.stringify(dati));
    localStorage.setItem(PENDING_SYNC_CHIAVE, pendingSync ? "1" : "0");
}

function hasPendingSync() {
    return localStorage.getItem(PENDING_SYNC_CHIAVE) === "1";
}

function portafogliUguali(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}

// ============================================
// SINCRONIZZAZIONE CON CLOUD (Cloudflare KV)
// ============================================
function aggiornaStatoSincronizzazione(stato, messaggio) {
    const statusEl = document.getElementById('sync-status');
    const btnSync = document.getElementById('btn-sync');
    if (!statusEl) return;
    
    switch(stato) {
        case 'synced':
            statusEl.className = 'sync-status synced';
            statusEl.innerText = `☁️ ${messaggio || 'Sincronizzato'}`;
            if (btnSync) {
                btnSync.className = 'btn-sync success';
                btnSync.innerText = '✅ Sincronizzato';
                setTimeout(() => {
                    btnSync.className = 'btn-sync';
                    btnSync.innerText = '☁️ Sincronizza';
                }, 3000);
            }
            break;
        case 'syncing':
            statusEl.className = 'sync-status syncing';
            statusEl.innerText = `☁️ ${messaggio || 'Sincronizzazione...'}`;
            if (btnSync) {
                btnSync.className = 'btn-sync';
                btnSync.innerText = '⏳ Sincronizzo...';
            }
            break;
        case 'error':
            statusEl.className = 'sync-status';
            statusEl.innerText = `⚠️ ${messaggio || 'Errore'}`;
            if (btnSync) {
                btnSync.className = 'btn-sync error';
                btnSync.innerText = '❌ Riprova';
                setTimeout(() => {
                    btnSync.className = 'btn-sync';
                    btnSync.innerText = '☁️ Sincronizza';
                }, 4000);
            }
            break;
        default:
            statusEl.className = 'sync-status';
            statusEl.innerText = `☁️ ${messaggio || 'Pronto'}`;
            if (btnSync) {
                btnSync.className = 'btn-sync';
                btnSync.innerText = '☁️ Sincronizza';
            }
    }
}

async function salvaDatiCloudImpl(dati) {
    aggiornaStatoSincronizzazione('syncing', 'Salvataggio...');
    console.log("☁️ Salvataggio dati su cloud...");

    const datiDaSalvare = dati || portafoglio || [];
    if (!isPortafoglioValido(datiDaSalvare) || datiDaSalvare.length === 0) {
        console.log("⚠️ Nessun dato valido da salvare");
        aggiornaStatoSincronizzazione('synced', 'Nessun dato da salvare');
        return false;
    }

    const response = await fetch(workerUrl("/save"), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(datiDaSalvare)
    });

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }

    const result = await response.json();
    if (!result.success) {
        throw new Error(result.error || 'Errore sconosciuto');
    }

    console.log("✅ Dati salvati su cloud:", result);
    salvaPortafoglioLocale(datiDaSalvare, false);
    aggiornaStatoSincronizzazione('synced', `Salvati ${result.count} asset`);
    return true;
}

function salvaDatiCloud(dati) {
    saveQueue = saveQueue
        .catch(() => {})
        .then(() => salvaDatiCloudImpl(dati))
        .catch((e) => {
            console.error("❌ Errore salvataggio cloud:", e);
            aggiornaStatoSincronizzazione('error', 'Errore: ' + e.message);
            return false;
        });
    return saveQueue;
}

async function caricaDatiCloud(silent = false) {
    try {
        if (!silent) {
            aggiornaStatoSincronizzazione('syncing', 'Caricamento...');
        }
        console.log("☁️ Caricamento dati dal cloud...");

        const response = await fetch(workerUrl("/load"), { cache: "no-store" });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();
        if (isPortafoglioValido(data) && data.length > 0) {
            console.log(`✅ Caricati ${data.length} asset dal cloud`);
            if (!silent) {
                aggiornaStatoSincronizzazione('synced', `Caricati ${data.length} asset`);
            }
            return data;
        }

        console.log("📭 Nessun dato valido nel cloud");
        if (!silent) {
            aggiornaStatoSincronizzazione('synced', 'Nessun dato cloud');
        }
        return null;
    } catch (e) {
        console.error("❌ Errore caricamento cloud:", e);
        if (!silent) {
            aggiornaStatoSincronizzazione('error', 'Errore caricamento');
        }
        return null;
    }
}

async function applicaDatiCloud(datiCloud, messaggio) {
    if (!isPortafoglioValido(datiCloud)) return false;
    if (portafogliUguali(datiCloud, portafoglio)) return false;

    portafoglio = datiCloud;
    salvaPortafoglioLocale(portafoglio, false);
    aggiornaTutto();
    aggiornaStatoSincronizzazione('synced', messaggio || `Aggiornati ${datiCloud.length} asset dal cloud`);
    return true;
}

async function pullDatiCloud(force = false) {
    if (pullCloudInCorso || hasPendingSync()) return;
    pullCloudInCorso = true;

    try {
        const datiCloud = await caricaDatiCloud(true);
        if (datiCloud) {
            await applicaDatiCloud(datiCloud, force ? 'Dati aggiornati dal cloud' : undefined);
        }
    } finally {
        pullCloudInCorso = false;
    }
}

async function sincronizzaOra() {
    console.log("🔄 Sincronizzazione manuale avviata...");

    const datiLocali = leggiPortafoglioLocale();

    if (hasPendingSync() && datiLocali && datiLocali.length > 0) {
        const ok = await salvaDatiCloud(datiLocali);
        if (ok) {
            aggiornaTutto();
        }
        return;
    }

    const datiCloud = await caricaDatiCloud();
    if (datiCloud) {
        await applicaDatiCloud(datiCloud, 'Dati ripristinati dal cloud');
        return;
    }

    if (datiLocali && datiLocali.length > 0) {
        const ok = await salvaDatiCloud(datiLocali);
        if (ok) {
            aggiornaTutto();
        }
        return;
    }

    aggiornaStatoSincronizzazione('error', 'Nessun dato da sincronizzare');
}

// ============================================
// INIZIALIZZAZIONE PORTAFOGLIO
// ============================================
async function inizializzaPortafoglio() {
    console.log("🚀 Inizializzazione portafoglio...");

    const datiLocali = leggiPortafoglioLocale();
    const datiCloud = await caricaDatiCloud();

    if (hasPendingSync() && datiLocali) {
        portafoglio = datiLocali;
        console.log("📦 Ripristinati dati locali non sincronizzati");
        await salvaDatiCloud(portafoglio);
    } else if (datiCloud) {
        portafoglio = datiCloud;
        salvaPortafoglioLocale(portafoglio, false);
        console.log("📦 Usati dati dal cloud");
    } else if (datiLocali) {
        portafoglio = datiLocali;
        console.log("📦 Usati dati dal localStorage");
        await salvaDatiCloud(portafoglio);
    } else {
        portafoglio = portafoglioDefault;
        console.log("📦 Usati dati di default");
        salvaPortafoglioLocale(portafoglio, true);
        await salvaDatiCloud(portafoglio);
    }

    applicaTema();
    aggiornaTutto();

    setInterval(() => pullDatiCloud(), SYNC_PULL_INTERVALLO);

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            pullDatiCloud(true);
        }
    });

    window.addEventListener('focus', () => pullDatiCloud(true));
}

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
// FETCH TRAMITE CLOUDFLARE WORKER CON RETRY
// ============================================
async function fetchTickerDataConRetry(ticker, range = "1d", interval = "1m", tentativi = 0) {
    const cacheKey = `${ticker}_${range}_${interval}`;
    const now = Date.now();
    
    if (cachePrezzi[cacheKey]) {
        const cached = cachePrezzi[cacheKey];
        const eta = now - cached.timestamp;
        const minuti = eta / (1000 * 60);
        
        if (minuti < 5) {
            console.log(`📦 Usato cache per ${ticker} (${minuti.toFixed(1)} minuti fa)`);
            return cached.data;
        }
    }
    
    try {
        const url = workerUrl("", { ticker, range, interval });
        console.log(`🔄 Tentativo ${tentativi + 1} per ${ticker}`);
        
        const response = await fetch(url, {
            signal: AbortSignal.timeout(10000)
        });
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        
        const data = await response.json();
        
        if (data && data.chart && data.chart.result && data.chart.result.length > 0) {
            const result = data.chart.result[0];
            const prezzo = result.meta?.regularMarketPrice || 0;
            const currency = result.meta?.currency || "EUR";
            
            if (currency !== "EUR" && currency !== "USD (non convertito)") {
                console.log(`⚠️ Attenzione: valuta ${currency} per ${ticker}`);
            }
            
            if (ticker === "BTCW.MI" || ticker === "WBTC.MI" || ticker === "WBTC.DE") {
                if (prezzo > 5 && prezzo < 30) {
                    cachePrezzi[cacheKey] = {
                        data: result,
                        timestamp: now
                    };
                    salvaCache(cachePrezzi);
                    console.log(`✅ Prezzo Bitcoin ETN VALIDO: ${prezzo} ${currency}`);
                    return result;
                } else {
                    console.log(`⚠️ Prezzo Bitcoin ETN non valido: ${prezzo} ${currency}, riprovo...`);
                    throw new Error("Prezzo Bitcoin ETN non valido");
                }
            }
            
            cachePrezzi[cacheKey] = {
                data: result,
                timestamp: now
            };
            salvaCache(cachePrezzi);
            return result;
        }
    } catch (e) {
        console.error(`❌ Errore tentativo ${tentativi + 1} per ${ticker}:`, e.message);
    }
    
    if (tentativi >= MAX_RETRY) {
        console.error(`❌ Raggiunto massimo tentativi per ${ticker}`);
        return null;
    }
    
    await new Promise(resolve => setTimeout(resolve, RETRY_INTERVALLO));
    return fetchTickerDataConRetry(ticker, range, interval, tentativi + 1);
}

// ============================================
// RECUPERO DATI ASSET
// ============================================
async function recuperaDatiAsset(item) {
    try {
        if (item.isin === "GB00BJYDH287") {
            const res = await fetchTickerDataConRetry("BTCW.MI", "1d", "1m", 0);
            
            if (res && res.meta) {
                const meta = res.meta;
                let prezzoAttuale = meta.regularMarketPrice || meta.previousClose || 0;
                const prezzoIeri = meta.chartPreviousClose || meta.previousClose || prezzoAttuale;
                const varGiornaliera = (prezzoIeri > 0 && prezzoAttuale > 0) ? ((prezzoAttuale - prezzoIeri) / prezzoIeri) * 100 : 0;
                
                return {
                    prezzo: parseFloat(prezzoAttuale),
                    varGiornaliera: varGiornaliera
                };
            }
            
            return { prezzo: 0, varGiornaliera: 0 };
        }
        
        const res = await fetchTickerDataConRetry(item.ticker, "1d", "1m", 0);
        
        if (res && res.meta) {
            const meta = res.meta;
            let prezzoAttuale = meta.regularMarketPrice || meta.previousClose || 0;
            const prezzoIeri = meta.chartPreviousClose || meta.previousClose || prezzoAttuale;
            const varGiornaliera = (prezzoIeri > 0 && prezzoAttuale > 0) ? ((prezzoAttuale - prezzoIeri) / prezzoIeri) * 100 : 0;
            
            return {
                prezzo: parseFloat(prezzoAttuale),
                varGiornaliera: varGiornaliera
            };
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

    if (isin === "GB00BJYDH287") {
        return false;
    }

    return t === "crypto" || 
           t === "etn" ||
           ticker.includes("BTC");
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
    if (aggiornamentoInCorso) {
        console.log("⚠️ Aggiornamento già in corso...");
        return;
    }
    
    aggiornamentoInCorso = true;
    console.log("🔄 Aggiornamento portafoglio in corso...");
    
    let rowsHtml = "";
    let valTot = 0, invTot = 0;
    let valCrypto = 0, invCrypto = 0;
    let valTrad = 0, invTrad = 0;
    
    try {
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
                    <td><strong>${!hasError ? datiUsati.prezzo.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €' : '🔄 Caricamento...'}</strong></td>
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
    } catch (e) {
        console.error("❌ Errore durante l'aggiornamento:", e);
    } finally {
        aggiornamentoInCorso = false;
    }
}

// ============================================
// FUNZIONI GRAFICO
// ============================================
function popolaSelectAsset() {
    const select = document.getElementById("chart-asset-select");
    if (!select) return;
    const valoreSelezionato = select.value;
    select.innerHTML = '<option value="PORTAFOGLIO">📊 Totale Portafoglio</option>';

    portafoglio.forEach(item => {
        const opt = document.createElement("option");
        opt.value = item.isin;
        let emoji = "📈";
        if (item.tipo === "Crypto") emoji = "🪙";
        else if (item.tipo === "ETN") emoji = "₿";
        else if (item.tipo === "Azione") emoji = "🏢";
        else if (item.tipo === "ETF" || item.tipo === "ETC") emoji = "📈";
        opt.innerText = `${emoji} ${item.nome} (${item.isin})`;
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

        const res = await fetchTickerDataConRetry(tickerTarget, range, interval, 0);

        if (res && res.timestamp && res.indicators?.quote[0]?.close) {
            const timestamps = res.timestamp;
            const closes = res.indicators.quote[0].close;
            const labels = [];
            const data = [];
            const variazioni = [];

            for (let i = 0; i < timestamps.length; i++) {
                if (closes[i] !== null && closes[i] !== undefined) {
                    labels.push(new Date(timestamps[i] * 1000).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: '2-digit' }));
                    data.push(closes[i]);
                    if (i === 0) {
                        variazioni.push(0);
                    } else {
                        const primo = closes[0] || 1;
                        variazioni.push(((closes[i] - primo) / primo) * 100);
                    }
                }
            }

            let colore = COLORI_ETF;
            let emoji = "📈";
            if (item.tipo === "Crypto") { colore = COLORI_CRYPTO; emoji = "🪙"; }
            else if (item.tipo === "Azione") { colore = COLORI_AZIONI; emoji = "🏢"; }

            const datasets = [{
                label: `${emoji} ${item.nome}`,
                data: data,
                color: colore,
                borderWidth: 3,
                fill: false,
                variazione: variazioni
            }];

            renderizzaGraficoMulti(labels, datasets, `Andamento ${item.nome}`);
        }
        return;
    }

    const assetAcquistati = portafoglio.filter(item => {
        const { quoteTotali } = calcolaTotaliAsset(item.acquisti);
        return quoteTotali > 0;
    });

    if (assetAcquistati.length === 0) {
        renderizzaGraficoMulti([], [], "Aggiungi quote agli asset per vedere il grafico");
        return;
    }

    const primoAsset = assetAcquistati[0];
    let tickerGuida = primoAsset.ticker;
    if (primoAsset.isin === "GB00BJYDH287") tickerGuida = "BTCW.MI";

    const resGuida = await fetchTickerDataConRetry(tickerGuida, range, interval, 0);

    if (!resGuida || !resGuida.timestamp) {
        renderizzaGraficoMulti([], [], "Impossibile caricare i dati");
        return;
    }

    const labels = resGuida.timestamp.map(ts => 
        new Date(ts * 1000).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: '2-digit' })
    );

    const datasets = [];
    
    const assetCrypto = assetAcquistati.filter(item => {
        const isCrypto = isAssetCrypto(item);
        return isCrypto && item.isin !== "GB00BJYDH287";
    });

    if (assetCrypto.length > 0) {
        const dataTotaleCrypto = new Array(labels.length).fill(0);
        let firstValueCrypto = 0;
        
        for (let item of assetCrypto) {
            const { quoteTotali } = calcolaTotaliAsset(item.acquisti);
            const r = await fetchTickerDataConRetry(item.ticker, range, interval, 0);
            
            if (r && r.indicators?.quote[0]?.close) {
                const closes = r.indicators.quote[0].close;
                for (let i = 0; i < labels.length; i++) {
                    const idx = Math.min(i, closes.length - 1);
                    const p = closes[idx] || closes[closes.length - 1] || 0;
                    dataTotaleCrypto[i] += (p * quoteTotali);
                }
            }
        }
        
        firstValueCrypto = dataTotaleCrypto[0] || 1;
        const variazioniCrypto = dataTotaleCrypto.map(v => ((v - firstValueCrypto) / firstValueCrypto) * 100);
        
        if (dataTotaleCrypto.some(v => v > 0)) {
            datasets.push({
                label: '🪙 Crypto',
                data: dataTotaleCrypto,
                color: COLORI_CRYPTO,
                borderWidth: 3,
                fill: false,
                variazione: variazioniCrypto
            });
        }
    }

    const assetETF = assetAcquistati.filter(item => {
        return item.tipo === "ETF" || 
               item.tipo === "ETC" || 
               item.isin === "GB00BJYDH287";
    });

    if (assetETF.length > 0) {
        const dataTotaleETF = new Array(labels.length).fill(0);
        let firstValueETF = 0;
        
        for (let item of assetETF) {
            const { quoteTotali } = calcolaTotaliAsset(item.acquisti);
            let tickerCurrent = item.ticker;
            if (item.isin === "GB00BJYDH287") tickerCurrent = "BTCW.MI";

            const r = await fetchTickerDataConRetry(tickerCurrent, range, interval, 0);
            
            if (r && r.indicators?.quote[0]?.close) {
                const closes = r.indicators.quote[0].close;
                for (let i = 0; i < labels.length; i++) {
                    const idx = Math.min(i, closes.length - 1);
                    const p = closes[idx] || closes[closes.length - 1] || 0;
                    dataTotaleETF[i] += (p * quoteTotali);
                }
            }
        }
        
        firstValueETF = dataTotaleETF[0] || 1;
        const variazioniETF = dataTotaleETF.map(v => ((v - firstValueETF) / firstValueETF) * 100);
        
        if (dataTotaleETF.some(v => v > 0)) {
            datasets.push({
                label: '📈 ETF/ETC/ETN',
                data: dataTotaleETF,
                color: COLORI_ETF,
                borderWidth: 3,
                fill: false,
                variazione: variazioniETF
            });
        }
    }

    if (datasets.length === 0) {
        renderizzaGraficoMulti([], [], "Nessun dato disponibile per il grafico");
        return;
    }

    const order = ['🪙 Crypto', '📈 ETF/ETC/ETN'];
    datasets.sort((a, b) => {
        return order.indexOf(a.label) - order.indexOf(b.label);
    });

    renderizzaGraficoMulti(labels, datasets, "Andamento Portafoglio per Categoria");
}

// ============================================
// RENDER GRAFICO MULTI-LINEA CON DOPPIO ASSE Y
// ============================================
function renderizzaGraficoMulti(labels, datasets, titolo) {
    const canvas = document.getElementById("portfolioChart");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");

    if (graficoIstanza) {
        graficoIstanza.destroy();
    }

    const colorText = isDarkMode ? '#94a3b8' : '#64748b';
    const colorGrid = isDarkMode ? '#334155' : '#e2e8f0';

    if (!labels || labels.length === 0 || !datasets || datasets.length === 0) {
        graficoIstanza = new Chart(ctx, {
            type: 'line',
            data: {
                labels: ['Nessun dato'],
                datasets: [{
                    label: 'Nessun dato disponibile',
                    data: [0],
                    borderColor: '#94a3b8',
                    backgroundColor: 'rgba(148, 163, 184, 0.1)',
                    borderWidth: 1,
                    pointRadius: 0
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { labels: { color: colorText } }
                }
            }
        });
        return;
    }

    const chartDatasets = datasets.map((ds) => {
        let yAxisID = 'y';
        let borderDash = [];
        
        if (ds.label.includes('Crypto')) {
            yAxisID = 'y';
            borderDash = [];
        } else if (ds.label.includes('ETF') || ds.label.includes('ETN')) {
            yAxisID = 'y1';
            borderDash = [5, 5];
        }

        return {
            label: ds.label || 'Serie',
            data: ds.data,
            borderColor: ds.color || COLORI_ETF,
            backgroundColor: ds.color ? ds.color + '22' : 'rgba(37, 99, 235, 0.1)',
            borderWidth: ds.borderWidth || 2.5,
            fill: ds.fill !== undefined ? ds.fill : false,
            tension: 0.2,
            pointRadius: labels.length > 50 ? 1 : 3,
            pointHoverRadius: 8,
            pointHoverBackgroundColor: ds.color || COLORI_ETF,
            pointHoverBorderColor: '#ffffff',
            pointHoverBorderWidth: 2,
            borderDash: borderDash,
            yAxisID: yAxisID,
            _variazione: ds.variazione || []
        };
    });

    graficoIstanza = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: chartDatasets
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                mode: 'index',
                intersect: false,
            },
            plugins: {
                legend: {
                    labels: { 
                        color: colorText,
                        font: { size: 12, weight: '500' },
                        padding: 15,
                        usePointStyle: true,
                        pointStyle: 'circle'
                    }
                },
                tooltip: {
                    mode: 'index',
                    intersect: false,
                    backgroundColor: isDarkMode ? 'rgba(30, 41, 59, 0.95)' : 'rgba(255, 255, 255, 0.95)',
                    titleColor: colorText,
                    bodyColor: colorText,
                    borderColor: isDarkMode ? '#334155' : '#e2e8f0',
                    borderWidth: 1,
                    padding: 12,
                    callbacks: {
                        label: function(context) {
                            let label = context.dataset.label || '';
                            let value = context.parsed.y;
                            if (value !== undefined && value !== null && value > 0) {
                                label += ': ' + value.toLocaleString('it-IT', { 
                                    minimumFractionDigits: 2, 
                                    maximumFractionDigits: 2 
                                }) + ' €';
                            }
                            const variazioni = context.dataset._variazione || [];
                            if (variazioni && variazioni.length > context.dataIndex) {
                                const varPerc = variazioni[context.dataIndex];
                                if (varPerc !== undefined && varPerc !== null && !isNaN(varPerc)) {
                                    const segno = varPerc >= 0 ? '+' : '';
                                    label += ` (${segno}${varPerc.toFixed(2)}%)`;
                                }
                            }
                            return label;
                        }
                    }
                }
            },
            scales: {
                y: {
                    type: 'linear',
                    display: true,
                    position: 'left',
                    grid: {
                        color: colorGrid,
                        drawOnChartArea: true,
                    },
                    ticks: {
                        color: colorText,
                        callback: function(value) {
                            if (value >= 1000) {
                                return value.toLocaleString('it-IT', { 
                                    minimumFractionDigits: 0, 
                                    maximumFractionDigits: 0 
                                }) + ' €';
                            }
                            return value.toLocaleString('it-IT', { 
                                minimumFractionDigits: 2, 
                                maximumFractionDigits: 2 
                            }) + ' €';
                        }
                    },
                    title: {
                        display: true,
                        text: '🪙 Crypto',
                        color: COLORI_CRYPTO,
                        font: { size: 11, weight: 'bold' }
                    }
                },
                y1: {
                    type: 'linear',
                    display: true,
                    position: 'right',
                    grid: {
                        drawOnChartArea: false,
                    },
                    ticks: {
                        color: colorText,
                        callback: function(value) {
                            if (value >= 1000) {
                                return value.toLocaleString('it-IT', { 
                                    minimumFractionDigits: 0, 
                                    maximumFractionDigits: 0 
                                }) + ' €';
                            }
                            return value.toLocaleString('it-IT', { 
                                minimumFractionDigits: 2, 
                                maximumFractionDigits: 2 
                            }) + ' €';
                        }
                    },
                    title: {
                        display: true,
                        text: '📈 ETF/ETN',
                        color: COLORI_ETF,
                        font: { size: 11, weight: 'bold' }
                    }
                },
                x: {
                    grid: { display: false },
                    ticks: { 
                        color: colorText,
                        maxTicksLimit: 20,
                        maxRotation: 45,
                        autoSkip: true
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

async function salvaESincronizza() {
    salvaPortafoglioLocale(portafoglio, true);
    const ok = await salvaDatiCloud(portafoglio);
    if (!ok) {
        aggiornaStatoSincronizzazione('error', 'Modifica salvata solo in locale');
    }
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
inizializzaPortafoglio();

setInterval(() => {
    if (portafoglio.length > 0) {
        aggiornaTutto();
    }
}, AGGIORNAMENTO_INTERVALLO);

console.log("🚀 App avviata con sincronizzazione Cloud!");
console.log("☁️ Dati sincronizzati su Cloudflare KV");
console.log("📊 Grafico multi-linea con doppio asse Y");