import React, { useState } from 'react';
import { Upload, Download, Search, AlertCircle, CheckCircle, XCircle } from 'lucide-react';
import Papa from 'papaparse';

const ParkFeeVerifier = () => {
  const [inputMode, setInputMode] = useState('single');
  const [singleInput, setSingleInput] = useState('');
  const [csvData, setCsvData] = useState(null);
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

  const expandAbbreviations = (name) => {
    if (!name) return name;
    const expansions = {
      'sp': 'state park',
      'np': 'national park',
      'sna': 'state natural area',
      'nhp': 'national historical park',
      'nf': 'national forest',
      'nra': 'national recreation area',
      'nwr': 'national wildlife refuge',
      'shs': 'state historic site',
      'shp': 'state historic park',
      'mt': 'mount',
      'mtn': 'mountain'
    };
    let expanded = name;
    Object.entries(expansions).forEach(([abbr, full]) => {
      const regex = new RegExp(`\\b${abbr}\\b`, 'gi');
      expanded = expanded.replace(regex, full);
    });
    return expanded;
  };

  const calculateSimilarity = (str1, str2) => {
    const tokens1 = new Set(normalizeName(str1).split(' '));
    const tokens2 = new Set(normalizeName(str2).split(' '));
    const intersection = new Set([...tokens1].filter(x => tokens2.has(x)));
    const union = new Set([...tokens1, ...tokens2]);
    return intersection.size / union.size;
  };

  const identifyAgency = (name, state) => {
    const normalized = (name || '').toLowerCase();
    if (normalized.includes('national park') || normalized.includes(' np')) return 'NPS';
    if (normalized.includes('national forest') || normalized.includes(' nf')) return 'USDA';
    if (normalized.includes('blm') || normalized.includes('bureau of land')) return 'BLM';
    if (normalized.includes('state park') || normalized.includes(' sp')) return 'State';
    if (normalized.includes('county')) return 'County';
    if (normalized.includes('city') || normalized.includes('municipal')) return 'City';
    return 'Unknown';
  };

  const getSearchDomains = (agency, state) => {
    const domains = [];
    switch (agency) {
      case 'NPS':
        domains.push('site:nps.gov');
        break;
      case 'USDA':
        domains.push('site:fs.usda.gov', 'site:usda.gov');
        break;
      case 'BLM':
        domains.push('site:blm.gov');
        break;
      case 'State':
        if (state) {
          domains.push(`site:${state.toLowerCase()}.gov`, `site:stateparks.${state.toLowerCase()}.gov`);
        }
        domains.push('site:.gov stateparks');
        break;
      case 'County':
      case 'City':
        if (state) {
          domains.push(`site:${state.toLowerCase()}.gov`);
        }
        domains.push('site:.gov');
        break;
      default:
        domains.push('site:.gov');
    }
    return domains;
  };

  // ---------- REAL WEB LOOKUP (calls your Netlify Function) ----------
  // Make sure you created netlify/functions/search.js and set BRAVE_API_KEY in Netlify.
  const verifyFee = async (parkName, state, managingAgency, urlFromRow) => {
    // Build a matchable name if an AllTrails URL is used
    let nameForMatch = parkName || '';
    try {
      if (parkName && parkName.includes('alltrails.com')) {
        const parts = parkName.split('/').filter(Boolean);
        nameForMatch = decodeURIComponent(parts[parts.length - 1].replace(/-/g, ' '));
      }
    } catch {}
    if (!parkName && urlFromRow && urlFromRow.includes('alltrails.com')) {
      const parts = urlFromRow.split('/').filter(Boolean);
      nameForMatch = decodeURIComponent(parts[parts.length - 1].replace(/-/g, ' '));
    }

    const res = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: parkName || urlFromRow || '',
        state: (state || '').trim() || null,
        nameForMatch
      })
    });

    let data = {};
    try { data = await res.json(); } catch { data = {}; }

    const feeInfo = data.feeInfo || 'Not verified';
    const kind = data.kind || 'not-verified';
    const source = data.url || '';

    const baseName = parkName || nameForMatch || 'The park';

    let alert;
    if (feeInfo === 'No fee') {
      alert = 'no fee';
    } else if (feeInfo === 'Not verified' || !source) {
      alert = 'unverified';
    } else if (kind === 'parking') {
      alert = `There is a fee to park at ${baseName}. For more information, please visit ${source}.`;
    } else if (kind === 'vehicle') {
      alert = `${baseName} charges a fee to enter. The fee varies depending on the vehicle used to enter the park (car, motorcycle, bike, on foot, or on horseback). For more information, please visit ${source}.`;
    } else {
      alert = `${baseName} charges a fee to enter. For more information, please visit ${source}.`;
    }

    // Validation: must end with period & have exactly one URL, except "no fee"/"unverified"
    const urlCount = (alert.match(/https?:\/\/\S+/g) || []).length;
    const valid = alert === 'no fee' || alert === 'unverified' || (alert.endsWith('.') && urlCount === 1);
    if (!valid) alert = 'unverified';

    return {
      feeInfo,
      feeSource: source,
      alert
    };
  };

  // ---------- single flow ----------
  const processSingle = async () => {
    if (!singleInput.trim()) return;
    setProcessing(true);
    setProgress({ current: 0, total: 1 });

    try {
      const isUrl = singleInput.includes('alltrails.com');
      const parkName = isUrl ? extractParkFromUrl(singleInput) : singleInput;

      const result = await verifyFee(parkName, null, null, isUrl ? singleInput : null);

      setResults([{
        name: parkName,
        state: '',
        managingAgency: identifyAgency(parkName, null),
        ...result
      }]);

      setProgress({ current: 1, total: 1 });
    } catch (error) {
      console.error('Error processing:', error);
    } finally {
      setProcessing(false);
    }
  };

  const extractParkFromUrl = (url) => {
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
      complete: async (results) => {
        const rows = results.data;
        setCsvData(rows);
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
            const verification = await verifyFee(parkName, state, agency, url);
            verifiedResults.push({
              ...row,
              'Fee Info': verification.feeInfo,
              'Fee Source': verification.feeSource,
              'Alert': verification.alert
            });
            setProgress({ current: i + 1, total: rows.length });
          }
        }

        setResults(verifiedResults);
        setProcessing(false);
      },
      error: (error) => {
        console.error('CSV parsing error:', error);
        setProcessing(false);
      }
    });
  };

  const handleFileUpload = (event) => {
    const file = event.target.files[0];
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
                onKeyPress={(e) => e.key === 'Enter' && processSingle()}
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
                <label
                  htmlFor="csv-upload"
                  className="cursor-pointer flex flex-col items-center"
                >
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
                  style={{ width: `${(progress.current / progress.total) * 100}%` }}
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
                  {results.slice(0, 25).map((result, idx) => {
                    const alertDisplay = getAlertDisplay(result.Alert || result.alert);
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
                              {result.Alert || result.alert}
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
