import React, { useState } from 'react';
import { Upload, Download, Search, AlertCircle, CheckCircle, XCircle } from 'lucide-react';
import Papa from 'papaparse';

/* ----------------------------- Normalization ---------------------------- */

const toNorm = (s) => (s || '')
  .toLowerCase()
  .replace(/[\u2019']/g, '')        // apostrophes
  .replace(/[^\p{L}\p{N}\s]/gu, '') // punctuation
  .replace(/\s+/g, ' ')
  .trim();

// Expand common abbreviations so “SP”, “NP”, etc. group together
const expand = (s) => {
  const m = toNorm(s);
  return m
    .replace(/\bsp\b/g, 'state park')
    .replace(/\bnp\b/g, 'national park')
    .replace(/\bsna\b/g, 'state natural area')
    .replace(/\bnhp\b/g, 'national historical park')
    .replace(/\bnf\b/g, 'national forest')
    .replace(/\bnra\b/g, 'national recreation area')
    .replace(/\bnwr\b/g, 'national wildlife refuge')
    .replace(/\bshp\b/g, 'state historic park');
};

// Make a deterministic group key for “same park”
const parkKey = (name) => expand(name);

/* --------------------------------- UI ---------------------------------- */

const getAlertDisplay = (alert) => {
  if (alert === 'no fee') return { icon: CheckCircle, color: 'text-green-600', bg: 'bg-green-50' };
  if (alert === 'unverified') return { icon: XCircle, color: 'text-gray-600', bg: 'bg-gray-50' };
  return { icon: AlertCircle, color: 'text-blue-600', bg: 'bg-blue-50' };
};

const isAllTrailsUrl = (s) => {
  try { return new URL(s).hostname.includes('alltrails.com'); }
  catch { return false; }
};

// Turn the API payload into our three columns
function toAugment(parkDisplay, api) {
  const url = api?.url || api?.homepage || '';           // prefer direct fee URL, else homepage if provided
  const kind = api?.kind || 'not-verified';
  const feeInfo = api?.feeInfo || (kind === 'no-fee' ? 'No fee' : 'Not verified');

  let alert = 'unverified';
  if (kind === 'no-fee') {
    alert = 'no fee';
  } else if (kind === 'general' || kind === 'parking') {
    // Only two alert templates you asked to keep
    if (kind === 'parking') {
      // trailhead/lot case
      alert = `There is a fee to park at ${parkDisplay}. For more information, please visit ${url}.`;
    } else {
      // general “entrance fee”
      alert = `${parkDisplay} charges a fee to enter. For more information, please visit ${url}.`;
    }
  }
  return { feeInfo, feeSource: url, alert, kind };
}

/* --------------------------- Backend Lookups --------------------------- */

async function callSearch({ query, state, nameForMatch, lenient }) {
  try {
    const res = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        state,
        nameForMatch,
        lenient: !!lenient,
        wantHomepage: true // optional convenience for “always include a source”
      })
    });
    return await res.json();
  } catch {
    return { url: null, feeInfo: 'Not verified', kind: 'not-verified' };
  }
}

// One grouped lookup with strict->lenient retries
async function lookupGroup({ query, state, nameForMatch }) {
  // strict pass
  const strict = await callSearch({ query, state, nameForMatch, lenient: false });
  if (strict && strict.kind !== 'not-verified') return strict;

  // lenient pass, broaden keywords (.gov/.org + admission/fees/day-use, etc.)
  // NOTE: we widen in the *backend*, but as an extra hint we can also append keywords here.
  const fallbackQuery = isAllTrailsUrl(query)
    ? query
    : `${query} (admission OR fees OR "day-use" OR parking)`;

  const lenient = await callSearch({ query: fallbackQuery, state, nameForMatch, lenient: true });
  return lenient || { url: null, feeInfo: 'Not verified', kind: 'not-verified' };
}

/* --------------------------------- App --------------------------------- */

const App = () => {
  const [inputMode, setInputMode] = useState('single');
  const [singleInput, setSingleInput] = useState('');
  const [results, setResults] = useState([]);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });

  /* ------------------------------- Single ------------------------------- */
  const processSingle = async () => {
    const raw = (singleInput || '').trim();
    if (!raw) return;

    setProcessing(true);
    setProgress({ current: 0, total: 1 });

    try {
      const query = raw; // name or AllTrails URL
      const nameForMatch = isAllTrailsUrl(raw) ? undefined : raw;

      const api = await lookupGroup({ query, state: undefined, nameForMatch });
      const augment = toAugment(raw, api);

      setResults([{
        name: raw,
        state: '-',
        agency: '-',
        'Fee Info': augment.feeInfo,
        'Fee Source': augment.feeSource,
        'Alert': augment.alert
      }]);

      setProgress({ current: 1, total: 1 });
    } finally {
      setProcessing(false);
    }
  };

  /* -------------------------------- Batch ------------------------------- */

  // Build a minimal “group model” so a group gets exactly one lookup + a lenient retry
  function groupRows(rows) {
    const groups = new Map(); // key -> { displayName, rowsIdx:[], state?, firstQuery }
    rows.forEach((row, idx) => {
      const name = row.name || row.trail_name || row.park || row['Park Name'] || row.Park || '';
      const url = row.url || row.link || '';
      const display = name || url || `Row ${idx+1}`;
      const key = parkKey(name || url);

      if (!groups.has(key)) {
        groups.set(key, {
          key,
          displayName: display,
          state: row.state || row.State || undefined,
          query: url ? url : name,  // prefer URL if present (AllTrails)
          rowsIdx: []
        });
      }
      groups.get(key).rowsIdx.push(idx);
    });
    return groups;
  }

  const processCSV = async (file) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: async (parsed) => {
        const rows = parsed.data || [];
        if (rows.length === 0) { setResults([]); return; }

        setProcessing(true);
        setProgress({ current: 0, total: rows.length });

        // 1) Build groups so each park gets a single canonical lookup
        const groups = groupRows(rows);

        // 2) Resolve each group (strict->lenient), cache per group
        const groupResults = new Map(); // key -> {feeInfo, feeSource, alert, kind}

        // Small worker pool to control concurrency
        const keys = Array.from(groups.keys());
        let ptr = 0;
        const CONCURRENCY = 4;

        const runWorker = async () => {
          while (true) {
            const i = ptr++; if (i >= keys.length) break;
            const g = groups.get(keys[i]);

            // One lookup per group
            const api = await lookupGroup({
              query: g.query,
              state: g.state,
              nameForMatch: isAllTrailsUrl(g.query) ? undefined : g.displayName
            });

            groupResults.set(g.key, toAugment(g.displayName, api));
          }
        };
        await Promise.all(new Array(Math.min(CONCURRENCY, keys.length)).fill(0).map(runWorker));

        // 3) First fill using group results
        const out = rows.map((row, idx) => {
          const name = row.name || row.trail_name || row.park || row['Park Name'] || row.Park || '';
          const url = row.url || row.link || '';
          const display = name || url || `Row ${idx+1}`;
          const key = parkKey(name || url);
          const g = groupResults.get(key);

          const feeInfo = g?.feeInfo || 'Not verified';
          const feeSource = g?.feeSource || '';
          const alert = g?.alert || 'unverified';

          // progress tick
          setProgress(p => ({ current: Math.min(p.current + 1, p.total), total: p.total }));

          return {
            ...row,
            'Fee Info': feeInfo,
            'Fee Source': feeSource,
            'Alert': alert
          };
        });

        // 4) Group backfill: if any row in a group is verified, copy to all rows in the same group
        //    This removes the “one unverified among identical names” problem.
        for (const [key, group] of groups.entries()) {
          const idxs = group.rowsIdx;
          const best = idxs
            .map(i => out[i])
            .map(r => ({
              i: r,
              score:
                (r['Alert'] === 'no fee' ? 3 :
                (r['Alert'] && r['Alert'] !== 'unverified' ? 2 :
                (r['Fee Source'] ? 1 : 0))) // prefer verified w/fee, then no-fee, then homepage, then none
            }))
            .sort((a,b) => b.score - a.score)[0];

          if (best && best.score > 1) { // has a verified fee alert (2 or 3)
            idxs.forEach(i => {
              out[i]['Fee Info'] = best.i['Fee Info'];
              out[i]['Fee Source'] = best.i['Fee Source'];
              out[i]['Alert'] = best.i['Alert'];
            });
          } else if (best && best.score === 1) {
            // we have at least a homepage source — keep consistency
            idxs.forEach(i => {
              if (!out[i]['Fee Source']) out[i]['Fee Source'] = best.i['Fee Source'];
            });
          }
        }

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
    if (file) {
      setInputMode('batch');
      processCSV(file);
    }
  };

  const downloadResults = () => {
    const csv = Papa.unparse(results);
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `verified_fees_${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
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
              <input type="file" accept=".csv" className="hidden" onChange={handleFileUpload} />
              <Upload className="inline mr-2" size={20} />
              CSV Batch Upload
            </label>
          </div>

          {inputMode === 'single' && (
            <div className="space-y-4">
              <input
                type="text"
                value={singleInput}
                onChange={(e) => setSingleInput(e.target.value)}
                placeholder="Enter park name or paste an AllTrails trail URL…"
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
                  {results.slice(0, 1500).map((r, idx) => {
                    const alertText = r.Alert || 'unverified';
                    const { icon: Icon, color, bg } = getAlertDisplay(alertText);
                    const displayName = r.name || r.trail_name || r.park || r['Park Name'] || r.Park || '-';
                    return (
                      <tr key={idx} className="hover:bg-gray-50">
                        <td className="px-4 py-3 text-sm text-gray-900">{displayName}</td>
                        <td className="px-4 py-3 text-sm text-gray-600">{r.state || r.State || '-'}</td>
                        <td className="px-4 py-3 text-sm text-gray-600">{r.agency || r.managing_agency || '-'}</td>
                        <td className="px-4 py-3 text-sm text-gray-900 font-medium">{r['Fee Info'] || 'Not verified'}</td>
                        <td className="px-4 py-3 text-sm">
                          {r['Fee Source'] ? (
                            <a href={r['Fee Source']} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
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

            {results.length > 1500 && (
              <p className="text-sm text-gray-600 mt-4 text-center">
                Showing first 1500 results. Download CSV for the complete data.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default App;
