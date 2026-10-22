// ESO Save: the facesheet reader, shared by the extension (a global, ESOSAVE_FACESHEET) and the
// ESO Save app (a module). The text arrives one recognised row per line, the cells of a row
// separated by " | ". Nothing is guessed: a value is taken only from a label read as printed.
(function (root) {
  // Facesheets come in two shapes around here: "Patient Information / Guarantor Information /
  // Primary Insurance / Secondary Insurance" blocks with "Label: value" pairs in two columns, and
  // "PATIENT / GUARANTOR / COVERAGE" blocks with the label right-aligned before its value. The
  // text arrives one recognised row per line, the cells of a row separated by " | ". Every value
  // is taken from a label; an unlabelled row right after an address is the city line, and an
  // unlabelled row naming a race is the race.
  const RACES = [[/white|caucasian/i, 'White'], [/black|african/i, 'Black or African American'], [/asian/i, 'Asian'], [/indian|alaska|native american/i, 'American Indian or Alaska Native'], [/hispanic|latino/i, 'Hispanic or Latino'], [/middle eastern|north african/i, 'Middle Eastern or North African'], [/hawaiian|pacific/i, 'Native Hawaiian or Other Pacific Islander']];
  const RELS = [[/^self|patient$/i, 'Self'], [/spouse|husband|wife/i, 'Spouse'], [/child|son|daughter|dependent/i, 'Child/Dependent'], [/parent|mother|father/i, 'Parent'], [/partner/i, 'Life/Domestic Partner'], [/employee/i, 'Employee']];
  // every label the parser reads, plus the ones it knows to leave alone (so a value is never
  // mistaken for part of the next label)
  const KNOWN = new Set(['pcp', 'primarycareprovider', 'primarycarephysician', 'primaryphysician', 'pcpname', 'familyphysician', 'primarydoctor',
    'patientname', 'name', 'patient', 'legalname', 'homeaddress', 'address', 'address1', 'streetaddress', 'street', 'patientaddress', 'mailingaddress', 'city', 'citystatezip', 'citystzip', 'citystate',
    'sex', 'birthsex', 'sexatbirth', 'legalsex', 'sexgender', 'gendersex', 'gender', 'genderidentity', 'dob', 'dobage', 'birthdateage', 'dateofbirth', 'birthdate', 'born', 'birthday', 'ssn', 'socialsecurity', 'socialsecuritynumber', 'ss', 'ssno',
    'race', 'raceethnicity', 'patientrace', 'ethnicity', 'ethnicgroup', 'ethnic', 'homephone', 'primaryphone', 'phone', 'phonenumber', 'homephonenumber', 'patientphone', 'telephone',
    'mobilephone', 'cellphone', 'cell', 'mobile', 'cellular', 'workphone', 'businessphone', 'guarantorname', 'guarantor', 'patientsreltn', 'relationtopatient', 'relationship', 'reltn',
    'relationshiptopatient', 'relationtothepatient', 'patientrelationship', 'relation', 'reltopatient', 'billingaddress', 'guarantoraddress', 'subscribername', 'subscriber', 'insuredname', 'insured',
    'policyholder', 'patreltosubscriber', 'relationtosubscriber', 'relationshiptosubscriber', 'relationtoinsured', 'relationshiptoinsured', 'insurancename', 'payor', 'payer', 'insurance', 'carrier',
    'company', 'insurancecompany', 'planname', 'payorname', 'payername',
    // read past, never used
    'altphone', 'religion', 'age', 'contactname', 'claimaddress', 'insurancetype', 'guarantorid', 'mrn', 'fin', 'encounterdate', 'hospitalaccount', 'contactserial', 'roombed', 'unit', 'patientclass',
    'hospitalservice', 'admittingprovider', 'attendingprovider', 'referringphysician', 'admdiagnosis', 'employer', 'status', 'plan', 'groupnumber', 'subscriberid', 'subscriberdob', 'policynumber',
    'insurancephone', 'authorizationnumber', 'authorizationphone', 'authorizationcontact', 'employername', 'employerphone', 'financialclass', 'regdttm', 'estdtofarrival', 'inptadmdttm', 'dischdttm',
    'observationdttm', 'vipindicator', 'admitreason', 'patienttype', 'medicalservice', 'location', 'isolation', 'diseasealert', 'admittype', 'admitsource', 'advancedirective', 'regclerk',
    'admitphysician', 'attendphysician', 'legalguardian', 'inptadmdate', 'inptadmtime', 'chartid', 'maritalstatus', 'language', 'email', 'occupation', 'accountnumber', 'visitnumber', 'nextofkin',
    'emergencycontact', 'preferredname', 'nickname', 'suffix', 'middlename', 'firstname', 'lastname']);
  function parseFacesheet(text) {
    const out = { patient: {}, guarantor: {}, primary: {}, secondary: {}, contact: {}, encounter: {}, head: {}, other: {} };
    const key = (t) => String(t || '').toLowerCase().replace(/[^a-z]/g, '');
    let section = 'head', lastAddressRow = -1, lastAddressSection = null, carry = null;
    const rows = String(text).split(/\r?\n/);
    const set = (sec, k, v) => { if (v && out[sec] && !(k in out[sec])) out[sec][k] = v; };
    const header = (k) => /^(patientinformation|patient|patientdemographics|demographics)$/.test(k) ? 'patient'
      : /^(guarantorinformation|guarantor)$/.test(k) ? 'guarantor'
      : /^(guarantoremployer|coverage|tertiaryinsurance|employer|employerinformation)$/.test(k) ? 'other'
      : /^(contactinformation|emergencycontact|emergencycontacts|nextofkin)$/.test(k) ? 'contact'
      : /^(primaryinsurance|insuranceprimary)$/.test(k) ? 'primary'
      : /^(secondaryinsurance|insurancesecondary)$/.test(k) ? 'secondary'
      : /^(encounterinformation|encounter|visitinformation|visit)$/.test(k) ? 'encounter' : null;
    // "Label: value Label2: value2" as one recognised cell (two columns read as one line), or a
    // label with its value in the next cell, or in the next row: every "Label:" starts a pair.
    // The label is the longest run of words before the colon that is one this parser knows
    // (so "ROE, LOUISE M DOB:" splits at "DOB"); an unknown label is the one word before it.
    const LABEL_WORD = /^[A-Za-z][A-Za-z.'\/()-]*$/;
    const labelsIn = (cell) => {
      const found = [];
      for (let i = cell.indexOf(':'); i !== -1; i = cell.indexOf(':', i + 1)) {
        if (cell[i + 1] && !/\s/.test(cell[i + 1])) continue; // 17:17, not a label
        const words = [];
        let j = i;
        while (words.length < 4) {
          let e = j; while (e > 0 && cell[e - 1] === ' ') e--;
          let b = e; while (b > 0 && cell[b - 1] !== ' ') b--;
          if (e === b) break;
          const w = cell.slice(b, e);
          if (!LABEL_WORD.test(w)) break;
          words.unshift({ w, b });
          j = b;
          if (b === 0) break;
        }
        if (!words.length) continue;
        let pick = words[words.length - 1];
        for (let n = words.length; n >= 1; n--) { const cand = words.slice(words.length - n); if (KNOWN.has(key(cand.map(x => x.w).join('')))) { pick = cand[0]; break; } }
        found.push({ label: key(cell.slice(pick.b, i)), start: pick.b, end: i + 1 });
      }
      return found;
    };
    const unlabelled = (sec, cell, r) => {
      const city = cityLine(cell);
      if (city && lastAddressSection === sec && r - lastAddressRow <= 2) { take(sec, 'city', cell, r); return; }
      if (sec !== 'patient' && sec !== 'head') return;
      if (RACES.some(([re]) => re.test(cell)) && cell.length < 45) set('patient', 'race', cell);
      // the label went missing: a date with an age after it can only be the birth date; a bare
      // Female / Male the sex
      if (/^\d{1,2}\/\d{1,2}\/\d{4}\s*\(?\s*\d{1,3}\s*(yrs?|years?|y\.?o\.?)\b/i.test(cell)) set('patient', 'dobLoose', cell);
      if (/^(female|male|f|m)$/i.test(cell.trim())) set('patient', 'sexLoose', cell.trim());
    };
    rows.forEach((row, r) => {
      const cells = row.split(/\s\|\s|\t/).map(c => c.trim()).filter(Boolean);
      let pending = null;
      cells.forEach((cell, ci) => {
        const k = key(cell);
        if (!/:/.test(cell)) { const h = header(k); if (h) { section = h; carry = null; pending = null; return; } }
        const pairs = labelsIn(cell);
        pairs.forEach((p, i) => { p.value = cell.slice(p.end, i + 1 < pairs.length ? pairs[i + 1].start : undefined).trim(); });
        const lead = pairs.length ? cell.slice(0, pairs[0].start).trim() : cell;
        if (lead) {
          const p = pending || (ci === 0 ? carry : null);
          if (p) { take(section, p, lead, r); pending = null; carry = null; }
          else unlabelled(section, lead, r);
        }
        pending = null;
        for (const p of pairs) { if (!p.label) continue; if (p.value) take(section, p.label, p.value, r); else pending = p.label; }
      });
      carry = pending; // a label at the end of a row may find its value at the start of the next
    });
    function take(sec, label, value, r) {
      const is = (...names) => names.includes(label);
      if (is('pcp', 'primarycareprovider', 'primarycarephysician', 'primaryphysician', 'pcpname', 'familyphysician', 'primarydoctor')) { set('patient', 'pcp', value); return; }
      if (sec === 'patient' || sec === 'head') {
        if (is('patientname', 'name', 'patient', 'legalname')) set('patient', 'name', value);
        else if (is('lastname')) set('patient', 'last', value);
        else if (is('firstname')) set('patient', 'first', value);
        else if (is('middlename')) set('patient', 'middle', value);
        else if (is('homeaddress', 'address', 'address1', 'streetaddress', 'street', 'patientaddress', 'mailingaddress')) { set('patient', 'address', value); lastAddressRow = r; lastAddressSection = sec; }
        else if (is('city', 'citystatezip', 'citystzip', 'citystate')) set('patient', 'city', value);
        else if (is('sex', 'birthsex', 'sexatbirth', 'legalsex', 'sexgender', 'gendersex')) { const w = value.split(/\s+/); set('patient', 'sex', w[0]); if (w.length > 1) unlabelled(sec, w.slice(1).join(' '), r); }
        else if (is('gender', 'genderidentity')) set('patient', 'gender', value);
        else if (is('dob', 'dateofbirth', 'birthdate', 'born', 'birthday', 'dobage', 'birthdateage')) set('patient', 'dob', value);
        else if (is('ssn', 'socialsecurity', 'socialsecuritynumber', 'ss', 'ssno')) set('patient', 'ssn', value);
        else if (is('race', 'raceethnicity', 'patientrace')) set('patient', 'race', value);
        else if (is('ethnicity', 'ethnicgroup', 'ethnic')) set('patient', 'ethnicity', value);
        else if (is('homephone', 'primaryphone', 'phone', 'phonenumber', 'homephonenumber', 'patientphone', 'telephone')) set('patient', 'phoneHome', value);
        else if (is('mobilephone', 'cellphone', 'cell', 'mobile', 'cellular')) set('patient', 'phoneMobile', value);
        else if (is('workphone', 'businessphone')) set('patient', 'phoneWork', value);
      } else if (sec === 'guarantor') {
        if (is('guarantorname', 'guarantor', 'name')) set('guarantor', 'name', value);
        else if (is('patientsreltn', 'relationtopatient', 'relationship', 'reltn', 'relationshiptopatient', 'relationtothepatient', 'patientrelationship', 'relation', 'reltopatient')) set('guarantor', 'rel', value);
        else if (is('billingaddress', 'address', 'homeaddress', 'address1', 'guarantoraddress')) { set('guarantor', 'address', value); lastAddressRow = r; lastAddressSection = sec; }
        else if (is('city', 'citystatezip', 'citystate')) set('guarantor', 'city', value);
        else if (is('dob', 'dateofbirth', 'birthdate', 'birthday')) set('guarantor', 'dob', value);
        else if (is('ssn', 'socialsecurity', 'socialsecuritynumber')) set('guarantor', 'ssn', value);
      } else if (sec === 'primary' || sec === 'secondary') {
        if (is('subscribername', 'subscriber', 'insuredname', 'insured', 'policyholder')) set(sec, 'subscriber', value);
        else if (is('patientsreltn', 'patreltosubscriber', 'relationship', 'relationtosubscriber', 'reltn', 'relationshiptosubscriber', 'patientrelationship', 'relationtoinsured', 'relationshiptoinsured')) set(sec, 'rel', value);
        else if (is('insurancename', 'payor', 'payer', 'insurance', 'carrier', 'company', 'insurancecompany', 'planname', 'payorname', 'payername')) set(sec, 'company', value);
      }
    }
    return out;
  }
  function cityLine(t) {
    const m = /^([A-Za-z .'-]{2,}?),?\s+([A-Za-z]{2})\.?\s+(\d{5})(?:\s*-?\s*(\d{1,4}))?\s*$/.exec(String(t || '').trim());
    return m ? { city: m[1].trim(), state: m[2].toUpperCase(), zip: m[3] } : null;
  }
  const splitName = (t) => {
    const clean = String(t || '').replace(/[*"]/g, '').replace(/\s+/g, ' ').trim();
    if (!clean) return null;
    let last, rest;
    if (clean.includes(',')) { [last, rest] = clean.split(',').map(x => x.trim()); }
    else { const w = clean.split(' '); last = w.pop(); rest = w.join(' '); }
    const parts = (rest || '').split(' ').filter(Boolean);
    return { last, first: parts.shift() || '', middle: parts.join(' ') };
  };
  const dateOf = (t) => { const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(t || '')); return m ? `${m[1].padStart(2, '0')}/${m[2].padStart(2, '0')}/${m[3]}` : null; };
  const phoneOf = (t) => { const d = String(t || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : null; };
  const fmtPhone = (d) => `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  // What goes where: the ops for the Patient page and the Billing page, the place lookups, a line
  // per item for the question, and what was left blank and why.
  // ESO's own lists (the system ones are the same for every agency; the bundle's copy wins when seen)
  const ESO_LISTS = {
    states: [['AL', 247], ['AK', 248], ['AZ', 249], ['AR', 250], ['CA', 251], ['CO', 252], ['CT', 253], ['DE', 254], ['FL', 256], ['GA', 257], ['HI', 258], ['ID', 259], ['IL', 260], ['IN', 261], ['IA', 262], ['KS', 263], ['KY', 264], ['LA', 265], ['ME', 266], ['MD', 267], ['MA', 268], ['MI', 269], ['MN', 270], ['MS', 271], ['MO', 272], ['MT', 273], ['NE', 274], ['NV', 275], ['NH', 276], ['NJ', 277], ['NM', 278], ['NY', 279], ['NC', 280], ['ND', 281], ['OH', 282], ['OK', 283], ['OR', 284], ['PA', 285], ['RI', 286], ['SC', 287], ['SD', 288], ['TN', 289], ['TX', 290], ['UT', 291], ['VT', 292], ['VA', 293], ['WA', 294], ['WV', 295], ['WI', 296], ['WY', 297]].map(([abbr, id]) => ({ id, abbr, name: abbr })),
    phoneTypes: [{ id: 12830, name: 'Home' }, { id: 12831, name: 'Home Mobile' }, { id: 12827, name: 'Work' }, { id: 12828, name: 'Work Mobile' }, { id: 12833, name: 'Daytime' }, { id: 12834, name: 'Evening' }],
    sex: [{ id: 15359, name: 'Female' }, { id: 15360, name: 'Male' }, { id: 15361, name: 'Unknown' }],
    gender: [{ id: 314, name: 'Female' }, { id: 313, name: 'Male' }, { id: 14760, name: 'Female-to-Male, Transgender Male' }, { id: 14761, name: 'Male-to-Female, Transgender Female' }, { id: 14762, name: 'Other, neither exclusively male or female' }, { id: 10316, name: 'Unknown (Unable to Determine)' }],
    race: [{ id: 315, name: 'American Indian or Alaska Native' }, { id: 316, name: 'Asian' }, { id: 317, name: 'Black or African American' }, { id: 10317, name: 'Hispanic or Latino' }, { id: 1338789, name: 'Middle Eastern or North African' }, { id: 318, name: 'Native Hawaiian or Other Pacific Islander' }, { id: 319, name: 'White' }],
    ethnicity: [{ id: 321, name: 'Hispanic or Latino' }, { id: 322, name: 'Not Hispanic or Latino' }],
    relationship: [{ id: 5780, name: 'Self' }, { id: 5781, name: 'Spouse' }, { id: 5782, name: 'Child/Dependent' }, { id: 5783, name: 'Parent' }, { id: 11792, name: 'Life/Domestic Partner' }, { id: 11791, name: 'Employee' }, { id: 5784, name: 'Other Relationship' }],
  };
  // What goes where: the ops for the Patient page and the Billing page (the insured: the patient
  // again, or the guarantor named on the sheet; never the insurance itself, that is the billing
  // office's), the place lookups, a line per item for the question, and what was left blank and why.
  function facesheetPlan(f, lists) {
    const L = {}; for (const k of Object.keys(ESO_LISTS)) L[k] = (lists && Array.isArray(lists[k]) && lists[k].length) ? lists[k] : ESO_LISTS[k];
    const byName = (list, re) => { const x = (list || []).find(i => re.test(i.name || '')); return x ? x.id : null; };
    const exact = (list, name) => byName(list, new RegExp('^' + String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i'));
    const patient = [], billing = [], places = [], lines = [], skipped = [];
    const ed = (arr, address, fieldRef, value, dataType) => { if (value !== null && value !== undefined && value !== '') arr.push({ verb: 'EDIT', address, fieldRef, value, dataType: dataType || 'string' }); };
    const phoneOps = (arr, base, refs, typeId, number) => {
      const k = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
      arr.push({ verb: 'ADD', address: `${base}.items.['${k}']`, fieldRef: refs[0], value: {}, dataType: 'collection', isComplexType: true });
      if (typeId) arr.push({ verb: 'EDIT', address: `${base}.items.['${k}'].phoneTypeId`, fieldRef: refs[1], value: typeId, dataType: 'singleselect' });
      arr.push({ verb: 'EDIT', address: `${base}.items.['${k}'].phoneNumber`, fieldRef: refs[2], value: number, dataType: 'phone' });
    };
    const P = f.patient, G = f.guarantor;
    // ---- Patient page
    const name = splitName(P.name) || (P.last ? { last: P.last.trim(), first: (P.first || '').trim(), middle: (P.middle || '').trim() } : null);
    if (name && name.last) {
      ed(patient, 'patient.demographics.lastName', 'PATIENTLASTNAME', name.last); ed(patient, 'patient.demographics.firstName', 'PATIENTFIRSTNAME', name.first); ed(patient, 'patient.demographics.middleName', 'PATIENTMIDDLENAME', name.middle);
      lines.push(`Name: ${name.last}, ${name.first}${name.middle ? ' ' + name.middle : ''}`);
    }
    const sexOf = (t) => /^f/i.test(t || '') ? 'Female' : /^m/i.test(t || '') ? 'Male' : null;
    const sex = sexOf(P.sex) || sexOf(P.gender) || sexOf(P.sexLoose);
    if (sex) { ed(patient, 'patient.demographics.sexId', 'PATIENTSEXID', exact(L.sex, sex), 'singleselect'); lines.push(`Sex: ${sex}`); }
    // gender: the sex, unless the sheet names a gender of its own
    const gender = P.gender ? (exact(L.gender, P.gender) ? P.gender : sexOf(P.gender)) : sex;
    if (gender) { const gid = exact(L.gender, gender); if (gid) ed(patient, 'patient.demographics.genderId', 'PATIENTGENDERID', gid, 'singleselect'); if (gid && gender !== sex) lines.push(`Gender: ${gender}`); }
    else if (P.gender) skipped.push(`gender "${P.gender}" (not one of ESO's)`);
    const dob = dateOf(P.dob) || dateOf(P.dobLoose);
    if (dob) { ed(patient, 'patient.demographics.dob', 'PATIENTDOB', dob + ' 00:00:00', 'date'); lines.push(`DOB: ${dob}`); }
    if (P.ssn) { const d = P.ssn.replace(/\D/g, ''); if (/x|\*/i.test(P.ssn) || d.length !== 9) skipped.push('SSN (masked on the facesheet)'); else { ed(patient, 'patient.demographics.ssn', 'PATIENTSSN', d, 'ssn'); lines.push('SSN: ***-**-' + d.slice(-4)); } }
    if (P.race) {
      const hit = RACES.find(([re]) => re.test(P.race));
      const rid = hit ? exact(L.race, hit[1]) : null;
      if (rid) { patient.push({ verb: 'ADD', address: `patient.demographics.raceIds.['${rid}']`, fieldRef: 'PATIENTRACEIDS', value: rid, dataType: 'multiselect' }); lines.push(`Race: ${hit[1]}`); }
      else skipped.push(`race "${P.race}" (not one of ESO's)`);
    }
    if (P.ethnicity) {
      const eth = /hispanic|latino/i.test(P.ethnicity) ? (/\b(not|non)\b/i.test(P.ethnicity) ? 'Not Hispanic or Latino' : 'Hispanic or Latino') : null;
      const eid = eth ? exact(L.ethnicity, eth) : null;
      if (eid) { ed(patient, 'patient.demographics.ethnicityId', 'PATIENTETHNICITYID', eid, 'singleselect'); lines.push(`Ethnicity: ${eth}`); }
      else if (!/unknown|declined|refused|unable/i.test(P.ethnicity)) skipped.push(`ethnicity "${P.ethnicity}" (not one of ESO's)`);
    }
    const addr = (src) => { const c = src.city ? cityLine(src.city) : null; const st = c ? (L.states || []).find(s => s.abbr === c.state) : null; return { line1: src.address || null, city: c ? c.city : null, stateId: st ? st.id : null, state: c ? c.state : null, zip: c ? c.zip : null }; };
    const pa = addr(P);
    if (pa.line1 || pa.city) {
      ed(patient, 'patient.contact.address.address1', 'PATIENTADDRESS1', pa.line1); ed(patient, 'patient.contact.address.city', 'PATIENTCITY', pa.city);
      if (pa.stateId) ed(patient, 'patient.contact.address.stateId', 'PATIENTSTATE', pa.stateId, 'singleselect'); else if (pa.state) skipped.push(`state ${pa.state} (not in ESO's list)`);
      ed(patient, 'patient.contact.address.zip', 'PATIENTZIP', pa.zip);
      if (pa.city && pa.stateId && pa.zip) places.push({ scope: 'patient', city: pa.city, stateId: pa.stateId, zip: pa.zip });
      lines.push(`Address: ${[pa.line1, pa.city, pa.state, pa.zip].filter(Boolean).join(', ')}`);
    }
    const ptype = (re) => byName(L.phoneTypes, re);
    for (const [k, re, what] of [['phoneHome', /^home$/i, 'Home'], ['phoneMobile', /^home mobile$/i, 'Mobile'], ['phoneWork', /^work$/i, 'Work']]) {
      const n = phoneOf(P[k]); if (!n) continue;
      phoneOps(patient, 'patient.contact.patientPhoneNumbers', ['PATIENTPHONENUMBERS', 'PATIENTPHONETYPEID', 'PATIENTPHONENUMBER'], ptype(re), n);
      lines.push(`${what} phone: ${fmtPhone(n)}`);
    }
    if (f.primary.company || f.secondary.company || G.name) skipped.push('insurance and the insured (the billing office\'s)');
    return { patient, billing, places, lines, skipped };
  }
  root.ESOSAVE_FACESHEET = { RACES, RELS, KNOWN, parseFacesheet, splitName, dateOf, ESO_LISTS, facesheetPlan };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.ESOSAVE_FACESHEET;
})(typeof globalThis !== 'undefined' ? globalThis : this);
