// src/App.jsx
import React, { useState } from 'react';
import { Upload, Download, Search, AlertCircle, CheckCircle, XCircle } from 'lucide-react';
import Papa from 'papaparse';

const norm = (s) => (s||'').toLowerCase()
  .replace(/[\u2019']/g,'')
  .replace(/[^\p{L}\p{N}\s:/._-]/gu,' ')
  .replace(/\s+/g,' ')
  .trim();

const isAllTrailsUrl = (s) => {
  try { return new URL(s).hostname.includes('alltrails.com'); }
  catch { return false; }
};
const cleanAT = (u) => {
  try { const x=new URL(u); return `https://${x.hostname}${x.pathname.replace(/\/+$/,'')}`; }
  catch { return u; }
};

const getBadge = (alert) => {
  if (alert === 'no fee') return { Icon: CheckCircle, color: 'text-green-600', bg: 'bg-green-50' };
  if (alert === 'unverified') return { Icon: XCircle, color: 'text-gray-600', bg: 'bg-gray-50' };
  return { Icon: AlertCircle, color: 'text-blue-600', bg: 'bg-blue-50' };
};

async function callSearch({ query, state, nameForMatch, lenient }) {
  try {
    const r = await fetch('/api/search', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ query, state, nameForMatch, lenient: !!lenient, wantHomepage: true })
    });
    return await r.json();
  } catch {
    return { url:null, homepage:null, feeInfo:'Not verified', kind:'not-verified' };
  }
}
async function lookupAggressive(query, state, nameForMatch) {
  // strict
  let res = await callSearch({ query, state, nameForMatch, lenient:false });
  if (res && res.kind !== 'not-verified') return res;
  // lenient
  const q2 = isAllTrailsUrl(query) ? query : `${query} (admission OR tickets OR fees OR "day-use" OR pass OR parking)`;
  res = await callSearch({ query: q2, state, nameForMatch, lenient:true });
  return res;
}
function toAugment(displayName, api) {
  const kind = api?.kind || 'not-verified';
  const url = api?.url || api?.homepage || '';
  const feeInfo = api?.feeInfo || (kind === 'no-fee' ? 'No fee' : 'Not verified');

  let alert = 'unverified';
  if (kind === 'no-fee') {
    alert = 'no fee';
  } else if (kind === 'general') {
    alert = `${displayName} charges a fee to enter. For more information, please visit ${url}.`;
  } else if (kind === 'parking') {
    alert = `There is a fee to park at ${displayName}. For more information, please visit ${url}.`;
  }
  return { feeInfo, feeSource: url, alert, kind };
}

export default function App() {
  const [inputMode, setInputMode] = useState('single');
  const [singleInput, setSingleInput] = useState('');
  const [results, setResults] = useState([]);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });

  const processSingle = async () => {
    const raw = (singleInput||'').trim();
    if (!raw) return;
    setProcessing(true); setProgress({current:0,total:1});
    try {
      const res = await lookupAggressive(raw, undefined, isAllTrailsUrl(raw)? undefined : raw);
      const aug = toAugment(raw, res);
      setResults([{
        name: raw, state: '-', agency: '-',
        'Fee Info': aug.feeInfo, 'Fee Source': aug.feeSource, 'Alert': aug.alert
      }]);
      setProgress({current:1,total:1});
    } finally { setProcessing(false); }
  };

  const processCSV = async (file) => {
    Papa.parse(file, {
      header:true, skipEmptyLines:true,
      complete: async (parsed) => {
        const rows = parsed.data || [];
        if (!rows.length) { setResults([]); return; }

        setProcessing(true);
        // exact de-dupe key: same AT-URL or same normalized name
        const groups = new Map(); // key -> { display, state, query, idxs:[] }
        rows.forEach((r, i) => {
          const name = r.name || r.trail_name || r.park || r['Park Name'] || r.Park || '';
          const url  = r.url || r.link || '';
          const query = (url && isAllTrailsUrl(url)) ? cleanAT(url) : (name || url);
          if (!query) return;
          const key = norm(query);
          if (!groups.has(key)) {
            groups.set(key, { display: name || query, state: r.state || r.State || undefined, query, idxs: [] });
          }
          groups.get(key).idxs.push(i);
        });

        const keys = Array.from(groups.keys());
        const out = rows.map(r => ({ ...r }));
        const totalRows = rows.length;
        setProgress({ current: 0, total: totalRows });

        // Low concurrency to respect Brave/API limits
        const CONCURRENCY = 2;
        let ptr = 0, done = 0;

        const run = async () => {
          while (true) {
            const k = keys[ptr++]; if (k === undefined) break;
            const g = groups.get(k);

            const api = await lookupAggressive(g.query, g.state, isAllTrailsUrl(g.query)? undefined : g.display);
            const aug = toAugment(g.display, api);

            // copy to all rows in this group
            for (const idx of g.idxs) {
              out[idx]['Fee Info'] = aug.feeInfo;
              out[idx]['Fee Source'] = aug.feeSource;
              out[idx]['Alert'] = aug.alert;
            }
            done += g.idxs.length;
            setProgress({ current: Math.min(done, totalRows), total: totalRows });
          }
        };
        await Promise.all(new Array(Math.min(CONCURRENCY, keys.length)).fill(0).map(run));

        setResults(out);
        setProcessing(false);
      },
      error: (e)=>{ console.error('CSV parse error', e); setProcessing(false); }
    });
  };

  const handleFileUpload = (e) => {
    const f = e.target.files?.[0];
    if (f) { setInputMode('batch'); processCSV(f); }
  };

  const downloadResults = () => {
    const csv = Papa.unparse(results);
    const blob = new Blob([csv], { type:'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `verified_fees_${Date.now()}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

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
                inputMode==='single' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}>
              <Search className="inline mr-2" size={20}/> Single Search
            </button>

            <label className={`flex-1 py-3 px-4 rounded-lg font-medium transition text-center cursor-pointer ${
              inputMode==='batch' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}>
              <input type="file" accept=".csv" className="hidden" onChange={handleFileUpload}/>
              <Upload className="inline mr-2" size={20}/> CSV Batch Upload
            </label>
          </div>

          {inputMode==='single' && (
            <div className="space-y-4">
              <input
                type="text" value={singleInput} onChange={(e)=>setSingleInput(e.target.value)}
                placeholder="Enter park name or paste an AllTrails trail URL…"
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                onKeyDown={(e)=>e.key==='Enter' && processSingle()}
              />
              <button
                onClick={processSingle}
                disabled={processing || !singleInput.trim()}
                className="w-full bg-blue-600 text-white py-3 rounded-lg font-medium hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition">
                {processing ? 'Verifying…' : 'Verify Fees'}
              </button>
            </div>
          )}

          {processing && (
            <div className="mt-6">
              <div className="flex justify-between text-sm text-gray-600 mb-2">
                <span>Processing…</span><span>{progress.current} / {progress.total}</span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-3">
                <div className="bg-blue-600 h-3 rounded-full transition-all duration-300"
                  style={{ width: `${progress.total ? (progress.current/progress.total)*100 : 0}%` }}/>
              </div>
            </div>
          )}
        </div>

        {results.length>0 && (
          <div className="bg-white rounded-lg shadow-lg p-6">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-2xl font-bold text-gray-800">Verification Results ({results.length})</h2>
              <button onClick={downloadResults} className="flex items-center gap-2 bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700 transition">
                <Download size={20}/> Download CSV
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
                  {results.map((r, idx) => {
                    const alertText = r.Alert || 'unverified';
                    const { Icon, color, bg } = getBadge(alertText);
                    const displayName = r.name || r.trail_name || r.park || r['Park Name'] || r.Park || '-';
                    return (
                      <tr key={idx} className="hover:bg-gray-50">
                        <td className="px-4 py-3 text-sm text-gray-900">{displayName}</td>
                        <td className="px-4 py-3 text-sm text-gray-600">{r.state || r.State || '-'}</td>
                        <td className="px-4 py-3 text-sm text-gray-600">{r.agency || r.managing_agency || '-'}</td>
                        <td className="px-4 py-3 text-sm text-gray-900 font-medium">{r['Fee Info'] || 'Not verified'}</td>
                        <td className="px-4 py-3 text-sm">
                          {r['Fee Source'] ? <a href={r['Fee Source']} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">View Source</a> : null}
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

          </div>
        )}
      </div>
    </div>
  );
}
