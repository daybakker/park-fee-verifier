// src/App.jsx
import React, { useState } from 'react';
import { Upload, Download, Search, AlertCircle, CheckCircle, XCircle } from 'lucide-react';
import Papa from 'papaparse';

/* ------------------------------- Helpers ------------------------------- */

// Little badge styling helper for the Alert column
const getAlertDisplay = (alert) => {
  if (alert === 'no fee') {
    return { icon: CheckCircle, color: 'text-green-600', bg: 'bg-green-50' };
  }
  if (alert === 'unverified') {
    return { icon: XCircle, color: 'text-gray-600', bg: 'bg-gray-50' };
  }
  return { icon: AlertCircle, color: 'text-blue-600', bg: 'bg-blue-50' };
};

// Stable cache key so duplicates get identical answers
const buildKey = (name, state, agency) =>
  [ (name||'').toLowerCase().trim(), (state||'').toLowerCase().trim(), (agency||'').toLowerCase().trim() ]
    .join('|');

// Convert API result -> our row fields (Fee Info, Fee Source, Alert)
function toRowAugment(parkDisplay, apiResult) {
  const url = apiResult?.url || '';
  const info = apiResult?.feeInfo || 'Not verified';
  let alert = 'unverified';

  if ((apiResult?.kind || '') === 'no-fee') {
    alert = 'no fee';
  } else if (apiResult?.kind === 'general' && url) {
    alert = `${parkDisplay} charges a fee to enter. For more information, please visit ${url}.`;
  }

  return { info, url, alert };
}

// One lookup with automatic retry (strict -> lenient)
async function lookupWithRetry({ query, state, nameForMatch }) {
  const strict = await fetch('/api/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, state, nameForMatch })
  }).then(r => r.json()).catch(() => ({ url: null, feeInfo: 'Not verified', kind: 'not-verified' }));

  if (strict && strict.kind !== 'not-verified') return strict;

  const lenient = await fetch('/api/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, state, nameForMatch, lenient: true })
  }).then(r => r.json()).catch(() => ({ url: null, feeInfo: 'Not verified', kind: 'not-verified' }));

  return lenient;
}

// Detect if user typed an AllTrails URL (single-search convenience)
const isAllTrailsUrl = (s) => {
  try { return new URL(s).hostname.includes('alltrails.com'); }
  catch { return false; }
};

/* --------------------------------- UI --------------------------------- */

const App = () => {
  const [inputMode, setInputMode] = useState('single');
  const [singleInput, setSingleInput] = useState('');
  const [results, setResults] = useState([]);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });

  /* --------------------------- Single Search --------------------------- */
  const processSingle = async () => {
    const value = (singleInput || '').trim();
    if (!value) return;

    setProcessing(true);
    setProgress({ current: 0, total: 1 });

    try {
      // If user pasted an AllTrails URL, just use it as query
      const query = value;
      const apiRes = await lookupWithRetry({ query, state: undefined, nameForMatch: isAllTrailsUrl(value) ? undefined : value });

      const parkDisplay = value; // for alert text
      const augment = toRowAugment(parkDisplay, apiRes);

      setResults([{
        name: value,
        state: '-',
        agency: isAllTrailsUrl(value) ? 'Unknown' : 'State',
        'Fee Info': augment.info,
        'Fee Source': augment.url,
        'Alert': augment.alert
      }]);

      setProgress({ current: 1, total: 1 });
    } catch (e) {
      console.error(e);
    } finally {
      setProcessing(false);
    }
  };

  /* ----------------------------- CSV Upload ---------------------------- */
  const processCSV = async (file) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: async (parsed) => {
        const rows = parsed.data || [];
        setProgress({ current: 0, total: rows.length });
        setProcessing(true);

        // Cache to make duplicate parks consistent
        const verCache = new Map();

        // Limit concurrency to keep API happy
        const CONCURRENCY = 3;
        let index = 0;
        const out = new Array(rows.length);

        const runOne = async (i) => {
          const row = rows[i];
          const nameRaw = row.name || row.trail_name || row.park || row['Park Name'] || '';
          const stateRaw = row.state || row.State || '';
          const agencyRaw = row.agency || row.managing_agency || '';
          const urlRaw = row.url || row.link || '';

          if (!nameRaw && !urlRaw) {
            out[i] = { ...row, 'Fee Info': 'Not verified', 'Fee Source': '', 'Alert': 'unverified' };
            setProgress(p => ({ current: p.current + 1, total: p.total }));
            return;
          }

          const isAllTrails = urlRaw && urlRaw.includes('alltrails.com');
          const query = isAllTrails ? urlRaw : nameRaw;

          const key = buildKey(nameRaw, stateRaw, agencyRaw);
          let cached = verCache.get(key);

          if (!cached) {
            const apiRes = await lookupWithRetry({
              query,
              state: stateRaw || undefined,
              nameForMatch: isAllTrails ? undefined : nameRaw
            });

            const parkDisplay = nameRaw || apiRes?.displayName || 'This park';
            const augment = toRowAugment(parkDisplay, apiRes);

            cached = {
              feeInfo: augment.info,
              feeSource: augment.url,
              alert: augment.alert
            };
            verCache.set(key, cached);
          }

          out[i] = {
            ...row,
            'Fee Info': cached.feeInfo,
            'Fee Source': cached.feeSource,
            'Alert': cached.alert
          };

          setProgress(p => ({ current: p.current + 1, total: p.total }));
        };

        // Small worker pool
        const workers = new Array(Math.min(CONCURRENCY, rows.length)).fill(0).map(async () => {
          while (true) {
            const i = index++;
            if (i >= rows.length) break;
            await runOne(i);
          }
        });
        await Promise.all(workers);

        setResults(out);
        setProcessing(false);
      },
      error: (err) => {
        console.error('CSV parsing error:', err);
        setProcessing(false);
      }
    });
  };

  const handleFileUpload = (e) => {
    const file = e.target.files?.[0];
    if (file) processCSV(file);
  };

  const downloadResults = () => {
    const csv = Papa.unparse(results);
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `verified_fees_${Date.now()}.csv`;
    a.click();
    window.URL.revokeObjectURL(url);
  };

  /* -------------------------------- Render ------------------------------- */

  return (
    <div className="min-h-screen bg-gradient-to-br from-green-50 to-blue-50 p-6">
      <div className="max-w-7xl mx-auto">
        <div className="bg-white rounded-lg shadow-lg p-6 mb-6">
          <h1 className="text-3xl font-bold text-gray-800 mb-2">Park & Trail Fee Verifier</h1>
          <p className="text-gray-600 mb-6">Verify entrance, parking, and permit fees using official sources</p>

          <div className="flex gap-4 mb-6">
            <button
              onClick={() => setInputMode('single')}
              className={`flex-1 py-3 px-4 rounded-lg font-medium transition ${
                inputMode === 'single' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              <Search className="inline mr-2" size={20} />
              Single Search
            </button>

            <label className={`flex-1 py-3 px-4 rounded-lg font-medium transition text-center cursor-pointer ${
              inputMode === 'batch' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}>
              <input type="file" accept=".csv" className="hidden" onChange={(e) => { setInputMode('batch'); handleFileUpload(e); }} />
              <Upload className="inline mr-2" size={20} />
              CSV Batch Upload
            </label>
          </div>

          {/* Single input */}
          {inputMode === 'single' && (
            <div className="space-y-4">
              <input
                type="text"
                value={singleInput}
                onChange={(e) => setSingleInput(e.target.value)}
                placeholder="Enter park name OR paste an AllTrails trail URL…"
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                onKeyDown={(e) => e.key === 'Enter' && processSingle()}
              />
              <button
                onClick={processSingle}
                disabled={processing || !singleInput.trim()}
                className="w-full bg-blue-600 text-white py-3 rounded-lg font-medium hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition"
              >
                {processing ? 'Verifying…' : 'Verify Fees'}
              </button>
            </div>
          )}

          {/* Progress bar */}
          {processing && (
            <div className="mt-6">
              <div className="flex justify-between text-sm text-gray-600 mb-2">
                <span>Processing…</span>
                <span>{progress.current} / {progress.total}</span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-3">
                <div
                  className="bg-blue-600 h-3 rounded-full transition-all duration-300"
                  style={{ width: `${progress.total ? (progress.current / progress.total) * 100 : 0}%` }}
                />
              </div>
            </div>
          )}
        </div>

        {/* Results */}
        {results.length > 0 && (
          <div className="bg-white rounded-lg shadow-lg p-6">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-2xl font-bold text-gray-800">
                Verification Results ({results.length})
              </h2>
              <button
                onClick={downloadResults}
                className="flex items-center gap-2 bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700 transition"
              >
                <Download size={20} />
                Download CSV
              </button>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50 border-b-2 border-gray-200">
                  <tr>
                    <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700">Park/Trail</th>
                    <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700">State</th>
                    <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700">Agency</th>
                    <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700">Fee Info</th>
                    <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700">Fee Source</th>
                    <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700">Alert</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {results.slice(0, 1000).map((r, idx) => {
                    const alertText = r.Alert || r.alert || 'unverified';
                    const { icon: Icon, color, bg } = getAlertDisplay(alertText);
                    const feeInfo = r['Fee Info'] || r.feeInfo || 'Not verified';
                    const feeSource = r['Fee Source'] || r.feeSource || '';
                    const displayName = r.name || r.trail_name || r.park || r['Park Name'] || r.Park || '-';

                    return (
                      <tr key={idx} className="hover:bg-gray-50">
                        <td className="px-4 py-3 text-sm text-gray-900">{displayName}</td>
                        <td className="px-4 py-3 text-sm text-gray-600">{r.state || r.State || '-'}</td>
                        <td className="px-4 py-3 text-sm text-gray-600">{r.agency || r.managing_agency || '-'}</td>
                        <td className="px-4 py-3 text-sm text-gray-900 font-medium">{feeInfo}</td>
                        <td className="px-4 py-3 text-sm">
                          {feeSource ? (
                            <a
                              href={feeSource}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-blue-600 hover:underline"
                            >
                              View Source
                            </a>
                          ) : null}
                        </td>
                        <td className="px-4 py-3">
                          <div className={`flex items-start gap-2 ${bg} p-2 rounded`}>
                            <Icon size={16} className={`${color} flex-shrink-0 mt-0.5`} />
                            <span className="text-xs text-gray-800">{alertText}</span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {results.length > 1000 && (
              <p className="text-sm text-gray-600 mt-4 text-center">
                Showing first 1000 results. Download CSV for the complete data.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default App;
