// icolms.js: SIMULATION of the DVLA iCOLMS-GH rider lookup.
//
// Reads data/icolms-riders.json and answers one question: "is the person behind
// this ID a licensed, road-legal rider right now?" Expiry checks use today's
// date, so a record that was valid last year can fail today, like the real thing.
//
// When real iCOLMS-GH access is approved, replace the body of `verifyRider` with
// an HTTP call and keep the SAME return shape. Nothing else in SafePay changes.
import fs from 'fs';

const db = JSON.parse(fs.readFileSync(new URL('./data/icolms-riders.json', import.meta.url), 'utf8'));
const clean = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const dayMs = 86400000;
const NEEDS = { motorcycle: ['A'], tricycle: ['A'], car: ['B'], van: ['B', 'C'] };

const maskPhone = (p) => (p ? `${p.slice(0, 3)} *** ${p.slice(-4)}` : '');
const maskCard = (c) => (c ? `${c.slice(0, 8)}****-${c.slice(-1)}` : '');
const fmtDate = (iso) => iso;

export const SOURCE = db.source;
export const LICENCE_PREFIX = 'GH-DL-';

export function verifyRider(query, now = new Date()) {
  const q = clean(query);
  const checkedAt = now.toISOString();
  if (q.length < 6) {
    return { found: false, verified: false, query: String(query || '').trim(), checkedAt, source: SOURCE, message: 'Enter a full licence number or Ghana Card number.' };
  }
  const r = db.riders.find((x) => clean(x.licenceNo) === q || clean(x.ghanaCard) === q);
  if (!r) {
    return { found: false, verified: false, query: String(query).trim(), checkedAt, source: SOURCE, message: 'No rider with this ID was found in iCOLMS-GH. Do not hand over a parcel.' };
  }

  const exp = new Date(r.expires);
  const daysLeft = Math.ceil((exp - now) / dayMs);
  const valid = (iso) => new Date(iso) >= now;
  const needs = NEEDS[r.vehicle.type] || ['A'];
  const checks = [
    { key: 'status', label: 'Licence status', pass: r.status === 'ACTIVE', detail: r.status === 'ACTIVE' ? 'Active' : r.status[0] + r.status.slice(1).toLowerCase() },
    { key: 'expiry', label: 'Licence validity', pass: daysLeft >= 0, detail: daysLeft >= 0 ? `Valid until ${fmtDate(r.expires)}` : `Expired on ${fmtDate(r.expires)}` },
    { key: 'class', label: 'Class fits vehicle', pass: needs.some((c) => r.licenceClass.includes(c)), detail: `Class ${r.licenceClass.join('/')} · ${r.vehicle.type} needs ${needs.join(' or ')}` },
    { key: 'roadworthy', label: 'Roadworthy certificate', pass: valid(r.roadworthyUntil), detail: valid(r.roadworthyUntil) ? `Valid until ${r.roadworthyUntil}` : `Expired on ${r.roadworthyUntil}` },
    { key: 'insurance', label: 'Vehicle insurance', pass: valid(r.insuranceUntil), detail: valid(r.insuranceUntil) ? `Valid until ${r.insuranceUntil}` : `Expired on ${r.insuranceUntil}` },
  ];
  const failed = checks.filter((c) => !c.pass);
  return {
    found: true,
    verified: failed.length === 0,
    query: String(query).trim(),
    checkedAt,
    source: SOURCE,
    message: failed.length === 0
      ? 'Verified and licensed. This rider is cleared to deliver.'
      : `Not cleared: ${failed.map((c) => c.label.toLowerCase()).join(', ')}.`,
    checks,
    rider: {
      licenceNo: r.licenceNo,
      ghanaCard: maskCard(r.ghanaCard),
      fullName: r.fullName,
      phone: maskPhone(r.phone),
      licenceClass: r.licenceClass,
      issued: r.issued,
      expires: r.expires,
      status: r.status,
      company: r.company,
      offences: r.offences,
      vehicle: r.vehicle,
    },
  };
}

// IDs to try in the demo: the first is clean, the rest each fail for a different reason.
export function samples(now = new Date()) {
  return db.riders.map((r) => {
    const v = verifyRider(r.licenceNo, now);
    return { id: r.licenceNo, name: r.fullName, verified: v.verified };
  });
}
