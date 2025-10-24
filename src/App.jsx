import React, { useState, useRef } from 'react';
import { Upload, Download, Search, AlertCircle, CheckCircle, XCircle } from 'lucide-react';
import Papa from 'papaparse';

const ParkFeeVerifier = () => {
  const [inputMode, setInputMode] = useState('single');
  const [singleInput, setSingleInput] = useState('');
  const [results, setResults] = useState([]);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });

  // ====== NEW: in-memory cache so duplicates reuse the same result ======
  // Keyed by "<normalized name>|<normalized state>"
  const resultsCache = useRef(new Map());

  // Normalize a park/row name for consistent keys
  const normalizeKeyPart = (s) =>
    (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  const keyFor = (name, state) =>
    `${normalizeKeyPart(name)}|${normalizeKeyPart(state)}`;

  // UI helpers (unchanged)
  const getAlertDisplay = (alert) => {
    if (alert === 'no fee') {
      return { icon: CheckCircle, color: 'text-green-600', bg: 'bg-green-50' };
    }
    if (alert === 'unverified') {
      return { icon: XCircle, color: 'text-gray-600', bg: 'bg-gray-50' };
    }
    return { icon: AlertCircle, color: 'text-blue-600', bg: 'bg-blue-50' };
  };

  // Build the alert text EXACTLY to spec (only 2 fee templates + 2 lower-case statuses)
  const buildAlert = (kind, displayName, url) => {
    if (kind === 'no-fee') return 'no fee';
    if (kind === 'unverified' || !url) return 'unverified';
    if (kind === 'parking') {
      return `There is a fee to park at ${displayName}. For more information, please visit ${url}.`;
    }
    // default: general fee
    return `${displayName} charges a fee to enter. For more information, please visit ${url}.`;
  };

  // Hit your Netlify function and shape the response into our three columns
  const fetchAndShape = async ({ query, state, nameForMatch }) => {
    try {
      const res = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, state: state || null, nameForMatch }),
      });
      const data = await res.json();

      // If the function returned an error, fall back to unverified
      if (!data || data.error) {
        return { feeInfo: 'Not verified', feeSource: '', alert: 'unverified' };
      }

      // If we got a URL, translate kind to our columns
      if (data.url) {
        const kind = data.kind || 'general';
        if (kind === 'no-fee') {
          return { feeInfo: 'No fee', feeSource: data.url, alert: 'no fee' };
        }
        if (kind === 'parking') {
          const feeInfo = data.feeInfo || 'Parking fee';
          return {
            feeInfo,
            feeSource: data.url,
            alert: buildAlert('parking', nameForMatch, data.url),
          };
        }
        // general fee
        const feeInfo = data.feeInfo || 'Fee charged';
        return {
          feeInfo,
          feeSource: data.url,
          alert: buildAlert('general', nameForMatch, data.url),
        };
      }

      // data.url is null → truly unverified
      return { feeInfo: 'Not verified', feeSource: '', alert: 'unverified' };
    } catch {
      return { feeInfo: 'Not verified', feeSource: '', alert: 'unverified' };
    }
  };

  // Extract a readable name from an AllTrails URL (client-side hint; server also handles this)
  const extractNameFromAllTrails = (input) => {
    try {
      const u = new URL(input);
      if (!u.hostname.includes('alltrails.com')) return null;
      // Try park in path first (/park/...), else last slug from trail path
      const parts = u.pathname.split('/').filter(Boolean);
      const last = parts.at(-1);
      if (!last) return null;
      return last.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    } catch {
      return null;
    }
  };

  // ====== SINGLE SEARCH ======
  const processSingle = async () => {
    const raw = (singleInput || '').trim();
    if (!raw) return;

    setProcessing(true);
    setProgress({ current: 0, total: 1 });

    try {
      // If it’s an AllTrails URL, we still use server logic,
      // but create a display name for alert/cache keys.
      const isAllTrails = raw.includes('alltrails.com');
      const displayName = isAllTrails ? (extractNameFromAllTrails(raw) || raw) : raw;
      const key = keyFor(displayName, '');

      // 1) Use cache if we’ve already resolved this park (same state)
      let shaped = resultsCache.current.get(key);

      // 2) Else call the server
      if (!shaped) {
        shaped = await fetchAndShape({
          query: raw,            // AllTrails URL or park name
          state: null,           // user didn’t provide state in single input
          nameForMatch: displayName,
        });
        // 3) Cache it for duplicates later
        resultsCache.current.set(key, shaped);
      }

      // 4) Show result
      setResults([{
        name: displayName,
        state: '',
        agency: '', // unknown at UI level
        'Fee Info': shaped.feeInfo,
        'Fee Source': shaped.feeSource,
        'Alert': shaped.alert,
      }]);
      setProgress({ current: 1, total: 1 });
    } finally {
      setProcessing(false);
    }
  };

  // ====== CSV BATCH ======
  const processCSV = async (file) => {
    setProcessing(true);
    setResults([]);
    setProgress({ current: 0, total: 0 });

    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: async (parsed) => {
        const rows = parsed.data || [];
        const total = rows.length;
        setProgress({ current: 0, total });

        const out = [];
        let done = 0;

        // Process rows serially to respect Netlify free plan timeouts and avoid request bursts
        for (const row of rows) {
          const parkName =
            row.name || row.trail_name || row.park || row['Park Name'] || '';
          const state = row.state || row.State || '';
          const url = row.url || row.link || '';

          if (!parkName && !url) {
            // nothing to look up; pass through
            out.push({
              ...row,
              'Fee Info': 'Not verified',
              'Fee Source': '',
              'Alert': 'unverified',
            });
            done += 1;
            setProgress({ current: done, total });
            continue;
          }

          // Build display name for alert text & cache key
          const displayName =
            parkName || extractNameFromAllTrails(url) || url || 'Unknown';

          const cacheKey = keyFor(displayName, state);

          // 1) Check cache first (duplicate rows reuse the first answer)
          let shaped = resultsCache.current.get(cacheKey);

          // 2) If not cached, call your Netlify function
          if (!shaped) {
            shaped = await fetchAndShape({
              query: url || parkName,   // prefer URL if provided
              state: state || null,
              nameForMatch: displayName,
            });
            // 3) Store in cache so all subsequent duplicates get filled identically
            resultsCache.current.set(cacheKey, shaped);
          }

          // 4) Append shaped result
          out.push({
            ...row,
            'Fee Info': shaped.feeInfo,
            'Fee Source': shaped.feeSource,
            'Alert': shaped.alert,
          });

          done += 1;
          setProgress({ current: done, total });
        }

        setResults(out);
        setProcessing(false);
      },
      error: () => {
        setProcessing(false);
      },
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

  return (
    <div className="min-h-screen bg-gradient-to-br from-green-50 to-blue-50 p-6">
      <div className="max-w-7xl mx-auto">
        <div className="bg-white rounded-lg shadow-lg p-6 mb-6">
          <h1 className="text-3xl font-bold text-gray-800 mb-2">Park &amp; Trail Fee Verifier</h1>
          <p className="text-gray-600 mb-6">Verify entrance, parking, and permit fees using official sources</p>

          <div className="flex gap-4 mb-6">
            <button
              onClick={() => setInputMode('single')}
              className={`flex-1 py-3 px-4 rounded-lg font-medium transition ${
                inputMode === 'single'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              <Search className="inline mr-2" size={20} />
              Single Search
            </button>
            <button
              onClick={() => setInputMode('batch')}
              className={`flex-1 py-3 px-4 rounded-lg font-medium transition ${
                inputMode === 'batch'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              <Upload className="inline mr-2" size={20} />
              CSV Batch Upload
            </button>
          </div>

          {inputMode === 'single' && (
            <div className="space-y-4">
              <input
                type="text"
                value={singleInput}
                onChange={(e) => setSingleInput(e.target.value)}
                placeholder="Enter park name or AllTrails URL..."
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                onKeyDown={(e) => e.key === 'Enter' && processSingle()}
              />
              <button
                onClick={processSingle}
                disabled={processing || !singleInput.trim()}
                className="w-full bg-blue-600 text-white py-3 rounded-lg font-medium hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition"
              >
                {processing ? 'Verifying...' : 'Verify Fees'}
              </button>
            </div>
          )}

          {inputMode === 'batch' && (
            <div className="space-y-4">
              <div className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center hover:border-blue-400 transition">
                <input
                  type="file"
                  accept=".csv"
                  onChange={handleFileUpload}
                  className="hidden"
                  id="csv-upload"
                  disabled={processing}
                />
                <label htmlFor="csv-upload" className="cursor-pointer flex flex-col items-center">
                  <Upload size={48} className="text-gray-400 mb-4" />
                  <span className="text-lg font-medium text-gray-700">
                    Upload CSV File
                  </span>
                  <span className="text-sm text-gray-500 mt-2">
                    Processing starts automatically upon upload
                  </span>
                </label>
              </div>

              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                <h3 className="font-semibold text-blue-900 mb-2">Expected CSV Columns:</h3>
                <p className="text-sm text-blue-800">
                  Required: name/trail_name/park (at least one)<br />
                  Optional: state, agency/managing_agency, url/link
                </p>
              </div>
            </div>
          )}

          {processing && (
            <div className="mt-6">
              <div className="flex justify-between text-sm text-gray-600 mb-2">
                <span>Processing...</span>
                <span>{progress.current} / {progress.total}</span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-3">
                <div
                  className="bg-blue-600 h-3 rounded-full transition-all duration-300"
                  style={{ width: progress.total ? `${(progress.current / progress.total) * 100}%` : '0%' }}
                />
              </div>
            </div>
          )}
        </div>

        {results.length > 0 && (
          <div className="bg-white rounded-lg shadow-lg p-6">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-2xl font-bold text-gray-800">Verification Results ({results.length})</h2>
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
                  {results.slice(0, 25).map((result, idx) => {
                    const alertValue = result.Alert || result.alert || '';
                    const alertDisplay = getAlertDisplay(alertValue);
                    const AlertIcon = alertDisplay.icon;

                    return (
                      <tr key={idx} className="hover:bg-gray-50">
                        <td className="px-4 py-3 text-sm text-gray-900">
                          {result.name || result.trail_name || result.park || result['Park Name'] || '-'}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-600">
                          {result.state || result.State || '-'}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-600">
                          {result.agency || result.managing_agency || '-'}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-900 font-medium">
                          {result['Fee Info'] || result.feeInfo || '-'}
                        </td>
                        <td className="px-4 py-3 text-sm">
                          {(result['Fee Source'] || result.feeSource) ? (
                            <a
                              href={result['Fee Source'] || result.feeSource}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-blue-600 hover:underline"
                            >
                              View Source
                            </a>
                          ) : (
                            <span className="text-gray-400">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <div className={`flex items-start gap-2 ${alertDisplay.bg} p-2 rounded`}>
                            <AlertIcon size={16} className={`${alertDisplay.color} flex-shrink-0 mt-0.5`} />
                            <span className="text-xs text-gray-800">{alertValue}</span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {results.length > 25 && (
              <p className="text-sm text-gray-600 mt-4 text-center">
                Showing first 25 of {results.length} results. Download CSV for complete data.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default ParkFeeVerifier;

