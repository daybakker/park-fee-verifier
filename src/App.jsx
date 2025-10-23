import React, { useState } from 'react';
import { Upload, Download, Search, AlertCircle, CheckCircle, XCircle } from 'lucide-react';
import Papa from 'papaparse';

const ParkFeeVerifier = () => {
  const [inputMode, setInputMode] = useState('single');
  const [singleInput, setSingleInput] = useState('');
  const [results, setResults] = useState([]);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });

  // ---------- helpers ----------
  const normalizeName = (name) => {
    if (!name) return '';
    return name.toLowerCase()
      .replace(/[^\w\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  };

  const identifyAgency = (name) => {
    const n = (name || '').toLowerCase();
    if (n.includes('national park') || n.includes(' np')) return 'NPS';
    if (n.includes('national forest') || n.includes(' nf')) return 'USDA';
    if (n.includes('blm') || n.includes('bureau of land')) return 'BLM';
    if (n.includes('state park') || n.includes(' sp')) return 'State';
    if (n.includes('county')) return 'County';
    if (n.includes('city') || n.includes('municipal')) return 'City';
    return 'Unknown';
  };

  // ---------- REAL WEB LOOKUP (calls your Netlify Function) ----------
  const verifyFee = async (parkNameOrUrl, state, managingAgency, urlFromRow) => {
    // Derive a pretty name if an AllTrails URL was provided
    let nameForMatch = parkNameOrUrl || '';
    try {
      if (parkNameOrUrl && parkNameOrUrl.includes('alltrails.com')) {
        const parts = parkNameOrUrl.split('/').filter(Boolean);
        nameForMatch = decodeURIComponent(parts[parts.length - 1].replace(/-/g, ' '));
      }
    } catch {}
    if (!parkNameOrUrl && urlFromRow && urlFromRow.includes('alltrails.com')) {
      const parts = urlFromRow.split('/').filter(Boolean);
      nameForMatch = decodeURIComponent(parts[parts.length - 1].replace(/-/g, ' '));
    }

    const res = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: parkNameOrUrl || urlFromRow || '',
        state: (state || '').trim() || null,
        nameForMatch
      })
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error('Search function error:', res.status, text);
      return { feeInfo: 'Not verified', feeSource: '', alert: 'unverified' };
    }

    let data = {};
    try { data = await res.json(); } catch {
      console.error('Search function JSON parse error');
      data = {};
    }

    const feeInfo = data.feeInfo || 'Not verified';
    const kind = data.kind || 'not-verified';        // expected: "general" | "parking" | "no-fee" | "not-verified"
    const source = data.url || '';

    const baseName = parkNameOrUrl || nameForMatch || 'The park';

    // ---- EXACT alert rules (only 2 templates + lowercase cases) ----
    let alert;
    if (feeInfo === 'No fee') {
      alert = 'no fee';
    } else if (feeInfo === 'Not verified' || !source) {
      alert = 'unverified';
    } else if (kind === 'parking') {
      // Parking/lot fee template
      alert = `There is a fee to park at ${baseName}. For more information, please visit ${source}.`;
    } else {
      // Generic entrance/day-use fee template
      alert = `${baseName} charges a fee to enter. For more information, please visit ${source}.`;
    }

    // Validation: "no fee"/"unverified" are exact lowercase; others must end with one plain URL and a period
    if (alert !== 'no fee' && alert !== 'unverified') {
      const urlCount = (alert.match(/https?:\/\/\S+/g) || []).length;
      if (!alert.endsWith('.') || urlCount !== 1) {
        console.warn('Alert formatting adjusted to meet validation rules.');
        alert = `${baseName} charges a fee to enter. For more information, please visit ${source}.`;
      }
    }

    return { feeInfo, feeSource: source, alert };
  };

  // ---------- single flow ----------
  const processSingle = async () => {
    if (!singleInput.trim()) return;
    setProcessing(true);
    setProgress({ current: 0, total: 1 });

    try {
      const isUrl = singleInput.includes('alltrails.com');
      const displayName = isUrl ? extractNameFromAllTrails(singleInput) : singleInput;

      const result = await verifyFee(singleInput, null, null, isUrl ? singleInput : null);

      setResults([{
        name: displayName,
        state: '',
        managingAgency: identifyAgency(displayName),
        ...result
      }]);

      setProgress({ current: 1, total: 1 });
    } catch (error) {
      console.error('Error processing:', error);
    } finally {
      setProcessing(false);
    }
  };

  const extractNameFromAllTrails = (url) => {
    const match = url.match(/alltrails\.com\/trail\/[^/]+\/([^/?]+)/);
    if (match) {
      return match[1].replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
    }
    return url;
  };

  // ---------- CSV flow (auto-run on upload) ----------
  const processCSV = async (file) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: async (parsed) => {
        const rows = parsed.data;
        setProgress({ current: 0, total: rows.length });
        setProcessing(true);

        const verifiedResults = [];
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          const parkName = row.name || row.trail_name || row.park || row['Park Name'] || '';
          const state = row.state || row.State || '';
          const agency = row.agency || row.managing_agency || '';
          const url = row.url || row.link || '';

          if (parkName || url) {
            const res = await verifyFee(parkName || url, state, agency, url);
            verifiedResults.push({
              ...row,
              'Fee Info': res.feeInfo,
              'Fee Source': res.feeSource,
              'Alert': res.alert
            });
            setProgress({ current: i + 1, total: rows.length });
          }
        }

        setResults(verifiedResults);
        setProcessing(false);
      },
      error: (err) => {
        console.error('CSV parsing error:', err);
        setProcessing(false);
      }
    });
  };

  const handleFileUpload = (e) => {
    const file = e.target.files[0];
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

  const getAlertDisplay = (alert) => {
    if (alert === 'no fee') {
      return { icon: CheckCircle, color: 'text-green-600', bg: 'bg-green-50' };
    }
    if (alert === 'unverified') {
      return { icon: XCircle, color: 'text-gray-600', bg: 'bg-gray-50' };
    }
    return { icon: AlertCircle, color: 'text-blue-600', bg: 'bg-blue-50' };
  };

  // ---------- UI ----------
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
                  <span className="text-lg font-medium text-gray-700">Upload CSV File</span>
                  <span className="text-sm text-gray-500 mt-2">Processing starts automatically upon upload</span>
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
                  style={{ width: `${(progress.current / progress.total) * 100}%` }}
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
                    const alertText = result.Alert || result.alert;
                    const alertDisplay = getAlertDisplay(alertText);
                    const AlertIcon = alertDisplay.icon;

                    return (
                      <tr key={idx} className="hover:bg-gray-50">
                        <td className="px-4 py-3 text-sm text-gray-900">
                          {result.name || result.trail_name || result.park || result['Park Name']}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-600">
                          {result.state || result.State || '-'}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-600">
                          {result.managingAgency || result.agency || '-'}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-900 font-medium">
                          {result['Fee Info'] || result.feeInfo}
                        </td>
                        <td className="px-4 py-3 text-sm">
                          {(result['Fee Source'] || result.feeSource) && (
                            <a
                              href={result['Fee Source'] || result.feeSource}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-blue-600 hover:underline"
                            >
                              View Source
                            </a>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <div className={`flex items-start gap-2 ${alertDisplay.bg} p-2 rounded`}>
                            <AlertIcon size={16} className={`${alertDisplay.color} flex-shrink-0 mt-0.5`} />
                            <span className="text-xs text-gray-800">
                              {alertText}
                            </span>
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
