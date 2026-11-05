/* =====================================================================
   BAS Payment Report — script.js
   Plain JavaScript version of the React app (App.jsx + zohoapi.jsx).
   Same data, filters, table, Grand Summary, Export CSV and Export PDF.
   No build step: upload index.html, styles.css and script.js as the widget.
   ===================================================================== */

/* =====================================================================
   1) ZOHO API  (Practice Portal: My_Practice, Doctor_Hospital_Subform, Practice_Payments)
   ===================================================================== */

// ── Config — update report names if required ─────────────────────────────────
var ZOHO_CONFIG = {
  APP_NAME: "claims-management",
  PRACTICE_REPORT: "My_Practice",                      // Logged-in practice report (Practice_Name)
  MAPPING_REPORT: "Doctor_Hospital_Subform_Report",    // Subform report: Doctor, Hospital, Add_Practice
  PAYMENTS_REPORT: "Practice_Payments",                // Practice payments report
};

function zohoReady() {
  return typeof ZOHO !== "undefined" && ZOHO && ZOHO.CREATOR;
}

function formatError(err) {
  if (!err) return "Unknown error";
  if (typeof err === "string") return err;
  if (err.message) return err.message;
  try {
    return JSON.stringify(err);
  } catch (e) {
    return String(err);
  }
}

function initZoho() {
  return new Promise(function (resolve, reject) {
    // SDK not loaded guard
    if (!zohoReady() || !ZOHO.CREATOR.UTIL || !ZOHO.CREATOR.UTIL.getInitParams) {
      // In local dev (outside Zoho iframe), resolve with mock so UI still loads
      console.warn("[ZohoAPI] SDK not found — running in local dev mode with mock data.");
      resolve({ origin: "local-dev" });
      return;
    }

    ZOHO.CREATOR.UTIL.getInitParams()
      .then(function (response) {
        console.log("[ZohoAPI] Init params:", response);
        resolve(response);
      })
      .catch(function (err) {
        console.error("[ZohoAPI] getInitParams failed:", err);
        reject(new Error("Zoho init failed: " + formatError(err)));
      });
  });
}

/* ── initParams — cached so it only ever fires ONE real SDK call ──────────── */
var _initParamsPromise = null;

function getInitParams() {
  if (_initParamsPromise) return _initParamsPromise;
  _initParamsPromise = initZoho().catch(function (err) {
    console.warn("[ZohoAPI] getInitParams failed (non-fatal):", err);
    return {};
  });
  return _initParamsPromise;
}

/* ── Logged-in user detection ─────────────────────────────────────────────── */
var _loggedInEmail = null;
var _loggedInEmailPromise = null;

function getLoggedInUserEmail() {
  if (_loggedInEmail !== null) return Promise.resolve(_loggedInEmail);
  if (_loggedInEmailPromise) return _loggedInEmailPromise;

  _loggedInEmailPromise = (async function () {
    var params = await getInitParams();
    console.info("[ZohoAPI] Raw init params:", params);

    var p = params || {};
    var candidates = [
      p.loginUser,
      p.data && p.data.loginUser,
      p.LoginUser,
      p.user && p.user.email,
      p.userEmail,
      p.zc_ownername,
    ].filter(Boolean);

    var email = String(candidates[0] || "").trim().toLowerCase();

    if (email) {
      console.info("[ZohoAPI] Logged-in user detected: " + email);
    }

    _loggedInEmail = email;
    return email;
  })();

  return _loggedInEmailPromise;
}

/* ── 1) Practice details — fetched from #Report:My_Practice ─────────────────
   The practice is login-based. In customer portals, My_Practice returns the
   logged-in practice record. We read Practice_Name.
------------------------------------------------------------------------------ */
async function getPracticeDetails() {
  if (!zohoReady() || !ZOHO.CREATOR.DATA || !ZOHO.CREATOR.DATA.getRecords) {
    console.warn("[ZohoAPI] Using mock practice (SDK unavailable).");
    return getMockPractice();
  }

  var config = {
    app_name: ZOHO_CONFIG.APP_NAME,
    report_name: ZOHO_CONFIG.PRACTICE_REPORT,
    page: 1,
    pageSize: 10,
    page_size: 10,
  };

  try {
    var response = await ZOHO.CREATOR.DATA.getRecords(config);
    console.log("[ZohoAPI] My_Practice response:", response);

    if (response && (response.code === 3000 || response.code === "3000") && Array.isArray(response.data) && response.data.length > 0) {
      var rows = response.data;
      var loggedInEmail = await getLoggedInUserEmail();
      var match = null;

      if (loggedInEmail && rows.length > 1) {
        match = rows.find(function (r) {
          var em = String(r.Contact_Email || r["Contact_Email"] || "").trim().toLowerCase();
          return em === loggedInEmail;
        });
      }

      var row = match || rows[0];
      var name = row.Practice_Name != null ? String(row.Practice_Name)
               : row["Practice_Name"] != null ? String(row["Practice_Name"])
               : resolveLookup(row["Practice"]) || "";
      var id = row.ID != null ? String(row.ID) : "";

      console.info("[ZohoAPI] Practice loaded: " + name + " (ID: " + id + ")");
      return { id: id, name: name, raw: row };
    }
  } catch (err) {
    console.error("[ZohoAPI] getPracticeDetails failed:", err);
  }

  return { id: "", name: "" };
}

/* ── 2) Doctor & Hospital mappings — fetched from #Report:Doctor_Hospital_Subform_Report
   Contains mapping rows with fields: Doctor, Hospital, Add_Practice
------------------------------------------------------------------------------ */
async function getDoctorHospitalMappings(practiceId, practiceName) {
  if (!zohoReady() || !ZOHO.CREATOR.DATA || !ZOHO.CREATOR.DATA.getRecords) {
    console.warn("[ZohoAPI] Using mock mappings (SDK unavailable).");
    return getMockMappings();
  }

  var allMappings = [];
  var page = 1;
  var MAX_PAGES = 10;

  while (page <= MAX_PAGES) {
    var config = {
      app_name: ZOHO_CONFIG.APP_NAME,
      report_name: ZOHO_CONFIG.MAPPING_REPORT,
      page: page,
      pageSize: 200,
      page_size: 200,
    };

    var response;
    try {
      response = await ZOHO.CREATOR.DATA.getRecords(config);
      console.log("[ZohoAPI] Doctor_Hospital_Subform_Report page " + page + " response:", response);
    } catch (err) {
      console.error("[ZohoAPI] getRecords (Doctor_Hospital_Subform_Report) failed:", err);
      break;
    }

    if (response && (response.code === 3100 || response.code === "3100")) break;
    if (!response || (response.code !== 3000 && response.code !== "3000")) break;

    var rows = Array.isArray(response.data) ? response.data : [];
    if (rows.length === 0) break;

    rows.forEach(function (r) {
      allMappings.push({
        doctorId: resolveLookupId(r["Doctor"]),
        doctorName: resolveLookup(r["Doctor"]),
        hospitalId: resolveLookupId(r["Hospital"]),
        hospitalName: resolveLookup(r["Hospital"]),
        practiceId: resolveLookupId(r["Add_Practice"]),
        practiceName: resolveLookup(r["Add_Practice"]),
      });
    });

    if (rows.length < 200) break;
    page++;
  }

  // Filter mappings for this practice if Add_Practice is provided on rows
  var filtered = allMappings;
  if (practiceId || practiceName) {
    var matched = allMappings.filter(function (m) {
      if (!m.practiceId && !m.practiceName) return true; // Report already scoped by portal
      var idMatch = practiceId && m.practiceId && String(m.practiceId) === String(practiceId);
      var nameMatch = practiceName && m.practiceName && m.practiceName.toLowerCase() === practiceName.toLowerCase();
      return idMatch || nameMatch;
    });
    if (matched.length > 0) {
      filtered = matched;
    }
  }

  console.info("[ZohoAPI] Loaded " + filtered.length + " practice doctor/hospital mapping(s).");
  return filtered;
}

/* ── 3) Payments — fetched from #Report:Practice_Payments ────────────────────
   Contains payment records: Payment_ID, payment_date, Payment_Method, Hospital,
   Doctor, Amount, Payer_Name, etc.
------------------------------------------------------------------------------ */
async function getAllPaymentRecords() {
  if (!zohoReady() || !ZOHO.CREATOR.DATA || !ZOHO.CREATOR.DATA.getRecords) {
    console.warn("[ZohoAPI] Using mock payments (SDK unavailable).");
    return getMockRecords();
  }

  var all = [];
  var page = 1;
  var cursor = null;
  var MAX_PAGES = 100;

  while (page <= MAX_PAGES) {
    var config = {
      app_name: ZOHO_CONFIG.APP_NAME,
      report_name: ZOHO_CONFIG.PAYMENTS_REPORT,
      page: page,
      pageSize: 200,
      page_size: 200,
    };
    if (cursor) config.record_cursor = cursor;

    var response;
    try {
      response = await ZOHO.CREATOR.DATA.getRecords(config);
    } catch (err) {
      throw new Error("getRecords call failed: " + formatError(err));
    }

    if (response && (response.code === 3100 || response.code === "3100")) {
      break; // 3100 = No records found
    }

    if (!response || (response.code !== 3000 && response.code !== "3000")) {
      var code = response ? response.code : "unknown";
      var msg = response ? response.message : "No message";
      throw new Error("Zoho API error (code " + code + "): " + msg);
    }

    var rawRecords = Array.isArray(response.data) ? response.data : [];
    if (rawRecords.length === 0) break;

    var norm = rawRecords.map(normaliseRecord);
    all = all.concat(norm);

    var nextCursor = response.record_cursor;
    if (nextCursor && nextCursor !== cursor) {
      cursor = nextCursor;
    } else {
      page++;
    }

    if (rawRecords.length < 200 && !nextCursor) break;
  }

  console.info("[ZohoAPI] Total practice payments: " + all.length);
  return all;
}

/* ── 4) Relational Matching ──────────────────────────────────────────────────
   User rule:
   if (#Report:Doctor_Hospital_Subform_Report doctor and hospital == #Report:Practice_Payments Doctor and Hospital) {
     show doctor and hospital data related to practice
   }
   and payment method data comes from
   if (#Report:Doctor_Hospital_Subform_Report doctor and hospital == #Report:Practice_Payments Doctor and Hospital) {
     Payment method = #Report:Practice_Payments Payment Method
   }
------------------------------------------------------------------------------ */
function filterPaymentsByPracticeMappings(payments, mappings) {
  if (!mappings || mappings.length === 0) {
    console.warn("[ZohoAPI] No practice mappings found — displaying all available payments.");
    return payments;
  }

  return payments.filter(function (payment) {
    return mappings.some(function (mapping) {
      // Match Doctor: by ID if available, else by name
      var docMatch = false;
      if (mapping.doctorId && payment.doctorId) {
        docMatch = String(mapping.doctorId) === String(payment.doctorId);
      } else if (mapping.doctorName && payment.doctor) {
        docMatch = mapping.doctorName.trim().toLowerCase() === payment.doctor.trim().toLowerCase();
      }

      // Match Hospital: by ID if available, else by name
      var hospMatch = false;
      if (mapping.hospitalId && payment.hospitalId) {
        hospMatch = String(mapping.hospitalId) === String(payment.hospitalId);
      } else if (mapping.hospitalName && payment.hospital) {
        hospMatch = mapping.hospitalName.trim().toLowerCase() === payment.hospital.trim().toLowerCase();
      }

      return docMatch && hospMatch;
    });
  });
}

// ── Normaliser ────────────────────────────────────────────────────────────────
function normaliseRecord(raw) {
  return {
    paymentId: raw["Payment_ID"] != null ? raw["Payment_ID"] : "",
    paymentDate: parseZohoDate(raw["payment_date"]),
    paymentMethod: raw["Payment_Method"] != null ? raw["Payment_Method"] : "",
    payer: resolveLookup(raw["Payer_Name"]) || resolveLookup(raw["Payer"]) || "",
    hospital: resolveLookup(raw["Hospital"]),
    hospitalId: resolveLookupId(raw["Hospital"]),
    doctor: resolveLookup(raw["Doctor"]),
    doctorId: resolveLookupId(raw["Doctor"]),
    amount: parseCurrency(raw["Amount"]),
    _zohoId: raw["ID"] != null ? raw["ID"] : null,
  };
}

// ── Utilities ─────────────────────────────────────────────────────────────────

/** Lookup fields in Zoho can be { ID, display_value }, { ID }, or a plain string/number */
function resolveLookup(val) {
  if (!val) return "";
  if (typeof val === "object") {
    var v = val.display_value != null ? val.display_value
          : val.zc_display_value != null ? val.zc_display_value
          : val.name != null ? val.name
          : val.Doctor_Name != null ? val.Doctor_Name
          : val.Hospital_Name != null ? val.Hospital_Name
          : val.Practice_Name != null ? val.Practice_Name
          : val.ID != null ? val.ID : "";
    return String(v);
  }
  return String(val);
}

/** Extract numeric/record ID from a Zoho lookup field or string */
function resolveLookupId(val) {
  if (!val) return "";
  if (typeof val === "object") {
    return val.ID != null ? String(val.ID) : (val.id != null ? String(val.id) : "");
  }
  return /^\d{15,20}$/.test(String(val).trim()) ? String(val).trim() : "";
}

/** Zoho dates arrive as "15-Jun-2025" or "2025-06-15" — convert to ISO YYYY-MM-DD */
function parseZohoDate(str) {
  if (!str) return "";
  var d = new Date(str);
  return isNaN(d.getTime()) ? str : d.toISOString().split("T")[0];
}

/** Currency fields arrive as strings like "1,234.56" or numbers — return a float */
function parseCurrency(val) {
  if (val === null || val === undefined || val === "") return 0;
  var n = parseFloat(String(val).replace(/[,$\s]/g, ""));
  return isNaN(n) ? 0 : n;
}

/** Format a number as AUD currency string */
function formatAUD(amount) {
  return Number(amount).toLocaleString("en-AU", {
    style: "currency",
    currency: "AUD",
    minimumFractionDigits: 2,
  });
}

/** "2025-06-15" → "15/06/2025" */
function formatDisplayDate(iso) {
  if (!iso) return "—";
  var parts = String(iso).split("-");
  var y = parts[0], m = parts[1], d = parts[2];
  if (!y || !m || !d) return iso;
  return d + "/" + m + "/" + y;
}

// ── Mock data (local dev only) ────────────────────────────────────────────────
function getMockPractice() {
  return { id: "31559000000010001", name: "Medi Elves Medical Practice" };
}

function getMockMappings() {
  return [
    { doctorId: "1", doctorName: "Dr. Arun Prakash", hospitalId: "101", hospitalName: "Royal Melbourne Hospital" },
    { doctorId: "1", doctorName: "Dr. Arun Prakash", hospitalId: "102", hospitalName: "St Vincent's Hospital Sydney" },
    { doctorId: "2", doctorName: "Dr. Meena Devi",   hospitalId: "103", hospitalName: "Princess Alexandra Hospital" },
    { doctorId: "3", doctorName: "Dr. Rajesh Kumar", hospitalId: "104", hospitalName: "Flinders Medical Centre" },
  ];
}

function getMockRecords() {
  var mappings = getMockMappings();
  var payers = ["Medibank", "Bupa", "HCF", "NIB", "Self-Funded"];
  var methods = ["Bank Transfer", "Credit Card", "EFTPOS", "Cheque"];

  var records = [];
  for (var i = 1; i <= 20; i++) {
    var m = mappings[(i - 1) % mappings.length];
    var amount = 750 + i * 320;
    records.push({
      paymentId: "PMT-" + (1000 + i),
      paymentDate: "2026-0" + ((i % 9) + 1) + "-" + String((i % 28) + 1).padStart(2, "0"),
      paymentMethod: methods[i % methods.length],
      payer: payers[i % payers.length],
      hospital: m.hospitalName,
      hospitalId: m.hospitalId,
      doctor: m.doctorName,
      doctorId: m.doctorId,
      amount: amount,
      _zohoId: "Z" + (1000 + i),
    });
  }
  return records;
}


/* =====================================================================
   2) REPORT CONSTANTS + HELPERS  (was the top of App.jsx)
   ===================================================================== */

var P = {
  surface: "#fff",
  border:  "#dde1ea",
  text:    "#111827",
};

// ── Australian FY + Quarter constants ─────────────────────────────────────────
var BAS_QUARTERS = [
  { id: "Q1", label: "Q1  Jul – Sep", start: [7,  1], end: [9,  30] },
  { id: "Q2", label: "Q2  Oct – Dec", start: [10, 1], end: [12, 31] },
  { id: "Q3", label: "Q3  Jan – Mar", start: [1,  1], end: [3,  31] },
  { id: "Q4", label: "Q4  Apr – Jun", start: [4,  1], end: [6,  30] },
];

function generateFinancialYears() {
  var now = new Date();
  var m   = now.getMonth() + 1;
  var y   = now.getFullYear();
  var fyStart = m >= 7 ? y : y - 1;
  var list = [];
  for (var i = fyStart; i >= fyStart - 6; i--)
    list.push({ id: String(i), label: "FY " + i + "/" + String(i + 1).slice(2) });
  return list;
}
var FINANCIAL_YEARS = generateFinancialYears();

function pad2(n) { return String(n).padStart(2, "0"); }

function getQuarterBounds(fyStartYear, quarterId) {
  var fy = parseInt(fyStartYear, 10);
  var q  = BAS_QUARTERS.find(function (b) { return b.id === quarterId; });
  if (!q) return null;
  var calYear = (quarterId === "Q1" || quarterId === "Q2") ? fy : fy + 1;
  return {
    start: new Date(calYear + "-" + pad2(q.start[0]) + "-" + pad2(q.start[1])),
    end:   new Date(calYear + "-" + pad2(q.end[0])   + "-" + pad2(q.end[1]) + "T23:59:59"),
  };
}

function getPeriodLabel(fyStartYear, quarterId) {
  var b = getQuarterBounds(fyStartYear, quarterId);
  if (!b) return "";
  var f = function (d) { return d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }); };
  return f(b.start) + " – " + f(b.end);
}

var sum = function (arr, key) { return arr.reduce(function (a, r) { return a + r[key]; }, 0); };

/* HTML escaping for text placed into the page */
function h(v) {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/* Turns a React-style style object into a CSS string (numbers get "px", like React does) */
var UNITLESS = { opacity: 1, zIndex: 1, fontWeight: 1, flex: 1, flexGrow: 1, flexShrink: 1, lineHeight: 1, order: 1 };
function st() {
  var o = Object.assign.apply(null, [{}].concat(Array.prototype.slice.call(arguments)));
  return Object.keys(o).filter(function (k) {
    return o[k] !== undefined && o[k] !== null && o[k] !== "";
  }).map(function (k) {
    var v = o[k];
    var css = k.replace(/[A-Z]/g, function (c) { return "-" + c.toLowerCase(); });
    if (typeof v === "number" && !UNITLESS[k]) v = v + "px";
    return css + ":" + v;
  }).join(";");
}


/* =====================================================================
   3) EXPORT CSV (Excel .xls)  — same as App.jsx exportCSV()
   ===================================================================== */
function exportCSV(rows, meta, filename) {
  filename = filename || "Payment_Report";
  var esc = function (v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  };

  var TEAL_HEADER = "#3E6E7E";
  var WHITE = "#FFFFFF";

  var td = function (val, opts) {
    opts = opts || {};
    var bold = opts.bold || false, align = opts.align || "left", bg = opts.bg || "", color = opts.color || "",
        fontSize = opts.fontSize || 11, italic = opts.italic || false, height = opts.height || 20, colspan = opts.colspan;
    var style = [
      "text-align:" + align,
      "vertical-align:middle",
      bold ? "font-weight:bold" : "",
      bg ? "background:" + bg : "",
      color ? "color:" + color : "",
      "font-size:" + fontSize + "pt",
      italic ? "font-style:italic" : "",
      "border:1px solid #d9d9d9",
      "padding:6px 10px",
      "height:" + height + "pt",
      "white-space:nowrap",
      "font-family:Arial",
    ].filter(Boolean).join(";");
    var colspanAttr = colspan ? ' colspan="' + colspan + '"' : "";
    return '<td style="' + style + '"' + colspanAttr + ">" + esc(val) + "</td>";
  };
  var tdPlain = function (rawHtml, extra) {
    return '<td style="border:none;padding:2px 6px;font-family:Arial;font-size:11pt;' + (extra || "") + '">' + rawHtml + "</td>";
  };

  // Number of real columns in the table, for consistent colspans in the filter/title rows
  var COLS = 7;
  var HEAD = { bold: true, align: "center", bg: TEAL_HEADER, color: WHITE, height: 26 };

  var html =
    '<table border="0" cellspacing="0" cellpadding="0">' +
      "<tr>" + tdPlain('<b style="font-size:16pt">BAS Payment Report</b>' + (meta.practice ? ' <span style="font-size:12pt;color:#6b7280;margin-left:8px">(' + esc(meta.practice) + ')</span>' : ''), "height:26pt") + "</tr>" +
      "<tr><td></td></tr>" +
      "<tr>" +
        '<td style="font-weight:bold;font-family:Arial;padding:2px 6px" colspan="2">DOCTOR</td>' +
        '<td style="font-weight:bold;font-family:Arial;padding:2px 6px" colspan="2">HOSPITAL</td>' +
        '<td style="font-weight:bold;font-family:Arial;padding:2px 6px" colspan="2">BAS QUARTER</td>' +
        '<td style="font-weight:bold;font-family:Arial;padding:2px 6px">FINANCIAL YEAR</td>' +
      "</tr>" +
      "<tr>" +
        '<td colspan="2" style="font-family:Arial;padding:2px 6px">' + esc(meta.doctor || "All Doctors") + "</td>" +
        '<td colspan="2" style="font-family:Arial;padding:2px 6px">' + esc(meta.hospital || "All Hospitals") + "</td>" +
        '<td colspan="2" style="font-family:Arial;padding:2px 6px">' + esc(meta.quarter || "—") + "</td>" +
        '<td style="font-family:Arial;padding:2px 6px">' + esc(meta.fy || "—") + "</td>" +
      "</tr>" +
      "<tr><td></td></tr>" +
      "<tr>" + tdPlain('<b style="font-size:13pt">Payment Detail</b>', "text-align:center") +
        '<td colspan="' + (COLS - 1) + '" style="border:none;padding:2px 6px"></td>' +
      "</tr>" +
      "<tr>" +
        td("Payment ID", HEAD) + td("Payment Date", HEAD) + td("Payment Method", HEAD) +
        td("Payer Name", HEAD) + td("Hospital", HEAD) + td("Doctor", HEAD) + td("Amount", HEAD) +
      "</tr>";

  rows.forEach(function (r) {
    html += "<tr>" +
      td(r.paymentId, { align: "left" }) +
      td(formatDisplayDate(r.paymentDate), { align: "center" }) +
      td(r.paymentMethod || "—", { align: "left" }) +
      td(r.payer || "—", { align: "left" }) +
      td(r.hospital || "—", { align: "left" }) +
      td(r.doctor || "—", { align: "left" }) +
      td(formatAUD(r.amount), { align: "right" }) +
    "</tr>";
  });

  // Grand Summary card — matches the on-screen design
  var SUMMARY_BG = "#EEF2FB";
  var NAVY_HEX   = "#1A2744";
  var totalAmount     = rows.reduce(function (s, r) { return s + (Number(r.amount) || 0); }, 0);
  var uniquePayers    = new Set(rows.map(function (r) { return r.payer; }).filter(Boolean)).size;
  var uniqueHospitals = new Set(rows.map(function (r) { return r.hospital; }).filter(Boolean)).size;

  html += '<tr><td style="border:none;height:8pt" colspan="' + COLS + '"></td></tr>';

  html += '<tr><td colspan="' + COLS + '" style="border:2px solid ' + NAVY_HEX + ";border-top:4px solid " + NAVY_HEX +
    ";border-bottom:none;background:" + SUMMARY_BG + ";text-align:center;font-family:Arial;font-weight:bold;font-size:11pt;color:" +
    NAVY_HEX + ';padding:12px 6px 8px;letter-spacing:1px">GRAND SUMMARY</td></tr>';

  var summaryLabel = function (label, colspan, isFirst, isLast) {
    return '<td colspan="' + colspan + '" style="' +
      (isFirst ? "border-left:2px solid " + NAVY_HEX + ";" : "") +
      (isLast ? "border-right:2px solid " + NAVY_HEX + ";" : "") +
      "background:" + SUMMARY_BG + ';text-align:center;font-family:Arial;font-size:8pt;color:#6b7280;font-weight:bold;padding:8px 10px 2px;letter-spacing:0.5px">' +
      esc(label) + "</td>";
  };
  var summaryValue = function (value, colspan, big, isFirst, isLast) {
    return '<td colspan="' + colspan + '" style="' +
      (isFirst ? "border-left:2px solid " + NAVY_HEX + ";" : "") +
      (isLast ? "border-right:2px solid " + NAVY_HEX + ";" : "") +
      "border-bottom:2px solid " + NAVY_HEX + ";background:" + SUMMARY_BG + ";text-align:center;font-family:Arial;font-size:" +
      (big ? 14 : 12) + "pt;color:" + NAVY_HEX + ';font-weight:bold;padding:2px 10px 14px">' + esc(value) + "</td>";
  };

  html += "<tr>" +
    summaryLabel("PAYMENTS", 2, true, false) +
    summaryLabel("PAYER", 2, false, false) +
    summaryLabel("HOSPITAL", 1, false, false) +
    summaryLabel("AMOUNT", 2, false, true) +
  "</tr>";
  html += "<tr>" +
    summaryValue(rows.length, 2, false, true, false) +
    summaryValue(uniquePayers, 2, false, false, false) +
    summaryValue(uniqueHospitals, 1, false, false, false) +
    summaryValue(formatAUD(totalAmount), 2, true, false, true) +
  "</tr>";

  html += "</table>";

  var blob = new Blob(
    [
      '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">',
      "<head><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet>" +
        "<x:Name>Payment Report</x:Name>" +
        "<x:WorksheetOptions><x:Selected/><x:DisplayGridlines/></x:WorksheetOptions>" +
      "</x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml></head>",
      html,
      "</html>",
    ],
    { type: "application/vnd.ms-excel" }
  );
  deliverFile(blob, filename + ".xls", "application/vnd.ms-excel", function () {
    var a = Object.assign(document.createElement("a"), {
      href: URL.createObjectURL(blob),
      download: filename + ".xls",
    });
    a.click();
    URL.revokeObjectURL(a.href);
  });
}


/* =====================================================================
   4) EXPORT PDF  — same as App.jsx exportPDF()
   ===================================================================== */
var NAVY  = [26, 39, 68];
var GREEN = [26, 94, 55];
var GRAY  = [110, 118, 128];
var LGRAY = [246, 247, 249];

// Medi Elves logo, base64-encoded PNG, for use in jsPDF (doc.addImage)
var MEDI_ELVES_LOGO_BASE64 = "data:image/png;base64,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";

function drawMetaIcon(doc, type, x, y, color) {
  // y is the vertical midpoint between the label line (y-6) and value line (y+6)
  doc.setDrawColor.apply(doc, color);
  doc.setLineWidth(1);
  switch (type) {
    case "person": {
      doc.circle(x + 5, y - 6.5, 2.5, "S");
      doc.lines(
        [
          [0, -1.25],
          [0, -1.381, -1.119, -2.5, -2.5, -2.5],
          [-5, 0],
          [-1.381, 0, -2.5, 1.119, -2.5, 2.5],
          [0, 1.25],
        ],
        x + 10, y + 2.25,
        [1, 1],
        "S",
        false
      );
      break;
    }
    case "building":
      doc.rect(x - 1, y - 9, 10, 12, "S");
      doc.line(x + 4, y - 6.5, x + 4, y - 1.5);
      doc.line(x + 1.5, y - 4, x + 6.5, y - 4);
      break;
    case "calendar":
      doc.rect(x - 2, y - 8, 12, 11, "S");
      doc.line(x - 2, y - 4, x + 10, y - 4);
      break;
    case "quarter":
      doc.rect(x - 2, y - 8, 12, 11, "S");
      doc.line(x - 2, y - 2, x + 10, y - 2);
      doc.line(x + 4, y - 8, x + 4, y - 2);
      break;
  }
}

function drawFooterIcon(doc, type, x, y, color) {
  doc.setDrawColor.apply(doc, color);
  doc.setLineWidth(0.9);
  switch (type) {
    case "lock": {
      var cx = x + 4, shackleCy = y - 4.5, r = 2.6;
      doc.circle(cx, shackleCy, r, "S");
      doc.setFillColor(255, 255, 255);
      doc.rect(cx - r - 1, shackleCy, (r + 1) * 2, r + 1.2, "F");
      doc.setDrawColor.apply(doc, color);
      doc.roundedRect(cx - 3.2, y - 4.8, 6.4, 5.4, 1, 1, "S");
      break;
    }
    case "phone":
      doc.roundedRect(x, y - 7.5, 6, 8, 1.1, 1.1, "S");
      doc.line(x + 1.2, y - 1.8, x + 4.8, y - 1.8);
      break;
    case "mail":
      doc.rect(x, y - 6.5, 9, 6.5, "S");
      doc.line(x, y - 6.5, x + 4.5, y - 2.75);
      doc.line(x + 9, y - 6.5, x + 4.5, y - 2.75);
      break;
    case "globe":
      doc.circle(x + 3.5, y - 3.75, 3.6, "S");
      doc.line(x - 0.1, y - 3.75, x + 7.1, y - 3.75);
      doc.ellipse(x + 3.5, y - 3.75, 1.5, 3.6, "S");
      break;
  }
}

function drawFooter(doc, pageWidth, marginX, pageHeight) {
  var contentWidth = pageWidth - marginX * 2;
  var fy = pageHeight - 72;

  doc.setDrawColor(225, 228, 233);
  doc.setLineWidth(0.75);
  doc.line(marginX, fy, pageWidth - marginX, fy);

  // Lock icon + "CONFIDENTIAL" label, vertically centered on the same baseline
  drawFooterIcon(doc, "lock", marginX, fy + 16, GRAY);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.setTextColor.apply(doc, NAVY);
  doc.text("CONFIDENTIAL – CONTAINS SENSITIVE HEALTH INFORMATION", marginX + 16, fy + 14);

  doc.setFont("helvetica", "normal");
  doc.setTextColor.apply(doc, GRAY);
  doc.text("Page " + doc.internal.getNumberOfPages(), pageWidth - marginX, fy + 14, { align: "right" });

  // Disclaimer — full content width, starts flush with the confidential label
  var disclaimer =
    "This document contains confidential patient and claims information and is intended only for the named recipient and authorised personnel. " +
    "Unauthorised access, use, copying, forwarding or disclosure is prohibited. If you received this document in error, please notify Medi Elves " +
    "immediately, delete all electronic copies and securely destroy any printed copies.";
  doc.setFontSize(6.8);
  var discLines = doc.splitTextToSize(disclaimer, contentWidth - 16);
  doc.text(discLines, marginX + 16, fy + 24);

  // Contact row — three equal columns spanning the full content width
  var cy2 = fy + 24 + discLines.length * 7.2 + 12;
  var colWidth = contentWidth / 3;
  var ICON_TEXT_GAP = 15;

  var contacts = [
    { icon: "phone", text: "1800 956 692" },
    { icon: "mail",  text: "admin@medielves.com.au" },
    { icon: "globe", text: "www.medielves.com.au" },
  ];

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor.apply(doc, NAVY);

  contacts.forEach(function (c, i) {
    var cx = marginX + i * colWidth;
    drawFooterIcon(doc, c.icon, cx, cy2 + 2.5, GREEN);
    doc.text(c.text, cx + ICON_TEXT_GAP, cy2, { baseline: "alphabetic" });
  });
}

function drawGrandSummary(doc, rows, x, y, width) {
  var uniquePayers    = new Set(rows.map(function (r) { return r.payer; }).filter(Boolean)).size;
  var uniqueHospitals = new Set(rows.map(function (r) { return r.hospital; }).filter(Boolean)).size;
  var totalAmount     = rows.reduce(function (s, r) { return s + (Number(r.amount) || 0); }, 0);

  var stats = [
    { label: "PAYMENTS", value: String(rows.length) },
    { label: "PAYER",    value: String(uniquePayers) },
    { label: "HOSPITAL", value: String(uniqueHospitals) },
    { label: "AMOUNT",   value: formatAUD(totalAmount), big: true },
  ];

  var boxHeight = 76;
  var SUMMARY_BG = [238, 242, 251];

  doc.setFillColor.apply(doc, SUMMARY_BG);
  doc.roundedRect(x, y, width, boxHeight, 6, 6, "F");

  doc.setDrawColor(221, 225, 234);
  doc.setLineWidth(0.75);
  doc.roundedRect(x, y, width, boxHeight, 6, 6, "S");

  doc.setDrawColor.apply(doc, NAVY);
  doc.setLineWidth(2.4);
  doc.line(x + 6, y + 1, x + width - 6, y + 1);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.setTextColor.apply(doc, NAVY);
  doc.text("GRAND SUMMARY", x + width / 2, y + 22, { align: "center" });

  var colW = width / stats.length;
  stats.forEach(function (s, i) {
    var cx = x + i * colW + colW / 2;

    doc.setFont("helvetica", "bold");
    doc.setFontSize(7.5);
    doc.setTextColor.apply(doc, GRAY);
    doc.text(s.label, cx, y + 42, { align: "center" });

    doc.setFont("helvetica", "bold");
    doc.setFontSize(s.big ? 15 : 13);
    doc.setTextColor.apply(doc, NAVY);
    doc.text(s.value, cx, y + 62, { align: "center" });
  });

  return y + boxHeight;
}

/* PDF page header: logo, title, divider and the Doctor / Hospital / BAS Quarter / Financial Year row.
   Drawn on every page of the PDF. Returns the y position just below the header. */
function drawPdfHeader(doc, meta, marginX, pageWidth, contentWidth) {
  var y = 20;

  // Logo (top-left)
  var logoW = 150, logoH = logoW * (248 / 488);
  doc.addImage(MEDI_ELVES_LOGO_BASE64, "PNG", marginX, y, logoW, logoH);

  // Title (top-right), vertically centered against the logo block
  doc.setFont("helvetica", "bold");
  doc.setFontSize(20);
  doc.setTextColor.apply(doc, NAVY);
  var titleBaseline = y + logoH / 2 + (meta.practice ? 1 : 7);
  doc.text("BAS Payment Report", pageWidth - marginX, titleBaseline, { align: "right" });
  if (meta.practice) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor.apply(doc, GRAY);
    doc.text(meta.practice, pageWidth - marginX, titleBaseline + 14, { align: "right" });
  }

  y += logoH + 8;
  doc.setDrawColor(225, 228, 233);
  doc.setLineWidth(1);
  doc.line(marginX, y, pageWidth - marginX, y);

  // Meta row: Doctor / Hospital / BAS Quarter / Financial Year — evenly spaced
  y += 30;
  var metaCols = [
    { icon: "person",   label: "DOCTOR",         value: meta.doctor || "—" },
    { icon: "building", label: "HOSPITAL",       value: meta.hospital || "All Hospitals" },
    { icon: "calendar", label: "BAS QUARTER",    value: meta.quarter || "—" },
    { icon: "quarter",  label: "FINANCIAL YEAR", value: meta.fy || "—" },
  ];
  var colW = contentWidth / metaCols.length;
  var maxValueLines = 1;

  metaCols.forEach(function (m, i) {
    var cx = marginX + i * colW;
    drawMetaIcon(doc, m.icon, cx, y, GREEN);

    doc.setFont("helvetica", "bold");
    doc.setFontSize(7.2);
    doc.setTextColor.apply(doc, GRAY);
    doc.text(m.label, cx + 20, y - 6);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(9.5);
    doc.setTextColor(30, 35, 45);
    var valueLines = doc.splitTextToSize(m.value, colW - 26);
    doc.text(valueLines, cx + 20, y + 6);
    maxValueLines = Math.max(maxValueLines, valueLines.length);
  });

  // Extra vertical room if any meta value wrapped to more than one line
  y += 20 + (maxValueLines - 1) * 10;

  return y;
}

function exportPDF(rows, meta, filename) {
  filename = filename || "Payment_Report";
  if (!window.jspdf || !window.jspdf.jsPDF) {
    alert("PDF library failed to load. Please refresh the page and try again.");
    return;
  }
  var doc = new window.jspdf.jsPDF({ unit: "pt", format: "a4" });
  var marginX = 38;
  var pageWidth = doc.internal.pageSize.getWidth();
  var pageHeight = doc.internal.pageSize.getHeight();
  var contentWidth = pageWidth - marginX * 2;
  var y = 20;

  // Header on page 1 (and on every following page through didDrawPage below)
  y = drawPdfHeader(doc, meta, marginX, pageWidth, contentWidth);

  var head = [["Payment ID", "Payment Date", "Payment Method", "Payer Name", "Hospital", "Doctor", "Amount"]];
  var body = rows.map(function (r) {
    return [
      r.paymentId,
      formatDisplayDate(r.paymentDate),
      r.paymentMethod || "—",
      r.payer || "—",
      r.hospital || "—",
      r.doctor || "—",
      formatAUD(r.amount),
    ];
  });

  doc.autoTable({
    startY: y,
    head: head, body: body,
    margin: { top: y, left: marginX, right: marginX, bottom: 80 },   // top: continued pages start below the header
    styles: { font: "helvetica", fontSize: 8.5, cellPadding: 6, textColor: [55, 65, 81] },
    headStyles: { fillColor: NAVY, textColor: [255, 255, 255], fontStyle: "bold" },
    alternateRowStyles: { fillColor: LGRAY },
    columnStyles: { 6: { halign: "right" } },
    didDrawPage: function (data) {
      // same header on every page after the first (page 1 already has it)
      if (data.pageNumber > 1) drawPdfHeader(doc, meta, marginX, pageWidth, contentWidth);
      drawFooter(doc, pageWidth, marginX, pageHeight);
    },
  });

  // Grand Summary card — placed right after the table, page-break safe
  var summaryHeight = 76;
  var footerLimit = pageHeight - 72 - 24;
  var summaryY = doc.lastAutoTable.finalY + 20;

  if (summaryY + summaryHeight > footerLimit) {
    doc.addPage();
    drawPdfHeader(doc, meta, marginX, pageWidth, contentWidth);   // header on the summary page too
    drawFooter(doc, pageWidth, marginX, pageHeight);
    summaryY = y;
  }

  drawGrandSummary(doc, rows, marginX, summaryY, contentWidth);

  deliverFile(doc.output("blob"), filename + ".pdf", "application/pdf", function () { doc.save(filename + ".pdf"); });
}


/* =====================================================================
   5) STATIC STYLES  (the S object from App.jsx)
   ===================================================================== */
var S = {
  page:         { background:"#f4f6fb", color:"#1c2136" },
  pageTitle:    { fontSize:26, fontWeight:700, color:"#111827", margin:0, letterSpacing:"-0.4px" },
  recordCount:  { fontSize:12.5, color:"#9ca3af", fontWeight:500, whiteSpace:"nowrap" },
  quarterChip:  { padding:"6px 14px", borderRadius:20, fontSize:12.5, fontWeight:500, border:"1px solid", display:"inline-flex", alignItems:"center", gap:5 },

  filterBar:    { background:"#fff", border:"1px solid #dde1ea", borderRadius:10, padding:"14px 18px", marginBottom:16, boxShadow:"0 1px 4px rgba(0,0,0,0.05)", marginLeft:20, marginRight:20 },
  filterGroup:  { display:"flex", flexDirection:"column", gap:4 },
  label:        { fontSize:10, fontWeight:600, color:"#374151", textTransform:"uppercase", letterSpacing:"0.04em" },
  select:       { border:"1px solid #d1d5db", borderRadius:6, padding:"6px 10px", fontSize:13, color:"#111827", background:"#fff", outline:"none", width:"100%" },
  btn:          { padding:"7px 18px", borderRadius:6, fontSize:12.5, fontWeight:600, border:"1px solid transparent", cursor:"pointer", whiteSpace:"nowrap" },
  btnPrimary:   { background:"#1a5eb8", color:"#fff", borderColor:"#1a5eb8" },
  btnOutline:   { background:"#fff", color:"#1a5eb8", borderColor:"#c5d3ee" },
  btnGhost:     { background:"transparent", color:"#6b7280", borderColor:"#e5e7eb" },
  hintText:     { fontSize:11.5, color:"#9ca3af", marginTop:8 },

  searchIcon:   { position:"absolute", left:11, fontSize:13, pointerEvents:"none", color:"#9ca3af" },
  searchInput:  { width:"100%", border:"1.5px solid #c5d3ee", borderRadius:8, padding:"9px 36px 9px 34px", fontSize:13.5, color:"#111827", background:"#f8faff", outline:"none", fontFamily:"inherit" },
  searchClear:  { position:"absolute", right:10, background:"none", border:"none", cursor:"pointer", color:"#9ca3af", fontSize:13, padding:2, lineHeight:1 },

  tableSection: { background:"#fff", border:"1px solid #dde1ea", borderRadius:10, overflow:"hidden", boxShadow:"0 1px 4px rgba(0,0,0,0.04)" },
  tableTitleRow:{ padding:"14px 20px 10px", borderBottom:"1px solid #eef0f5" },
  tableTitle:   { fontSize:15, fontWeight:700, margin:0, color:"#111827" },
  tableWrap:    { overflowX:"auto", overflowY:"auto", maxHeight:660 },
  table:        { width:"100%", borderCollapse:"collapse", fontSize:13 },
  th:           { background:"#f8f9fc", borderBottom:"2px solid #e5e7eb", padding:"10px 14px", fontWeight:600, fontSize:12, color:"#374151", whiteSpace:"nowrap", position:"sticky", top:0, zIndex:2 },
  td:           { padding:"10px 14px", color:"#374151", borderBottom:"1px solid #f0f1f5", whiteSpace:"nowrap", fontSize:13 },

  centered:     { display:"flex", alignItems:"center", justifyContent:"center", padding:"72px 0" },
  spinner:      { width:22, height:22, border:"2px solid #dde1ea", borderTop:"2px solid #1a5eb8", borderRadius:"50%", animation:"spin 0.8s linear infinite" },

  errorBox:     { display:"flex", alignItems:"flex-start", gap:14, background:"#fef2f2", border:"1px solid #fecaca", borderRadius:10, padding:"18px 20px", marginTop:20, color:"#991b1b" },
  errorIcon:    { fontSize:22, flexShrink:0, lineHeight:1, marginTop:1 },

  emptyState:   { textAlign:"center", padding:"100px 24px", color:"#6b7280" },
  emptyIcon:    { fontSize:40, marginBottom:14 },
  emptyTitle:   { fontSize:17, fontWeight:600, color:"#374151", marginBottom:8 },
  emptyBody:    { fontSize:13.5, lineHeight:1.7, maxWidth:440, margin:"0 auto" },

  summaryCard:  { background:"#eef2fb", borderTop:"3px solid #1a2744", padding:"16px 20px 20px" },
  summaryTitle: { fontSize:12.5, fontWeight:700, color:"#1a2744", letterSpacing:"0.05em", textAlign:"center", marginBottom:16 },
  summaryCol:   { display:"flex", flexDirection:"column", alignItems:"flex-start", gap:4, minWidth:0 },
  summaryLabel: { fontSize:11, fontWeight:600, color:"#6b7280", textTransform:"uppercase", letterSpacing:"0.03em", whiteSpace:"nowrap" },
  summaryValue: { fontSize:18, fontWeight:700, color:"#1a2744" },
  summaryValueBig: { fontSize:20 },
};


/* =====================================================================
   6) PAGE STATE  (was the useState hooks in App())
   ===================================================================== */
var state = {
  practiceId:   "",
  practiceName: "",
  mappings:     [],
  allPayments:  [],
  allRecords:   [], // matched records satisfying mapping == payments

  loadingData:  true,
  dataError:    null,

  selDoctor:    "",
  selQuarter:   "",
  selFY:        FINANCIAL_YEARS[0].id,
  selHospital:  "all",
  selMethod:    "all",
  search:       "",

  applied:      null,
  running:      false,

  // PaymentsTable sort (resets each time the results table is shown again)
  sortCol:      "paymentDate",
  sortDir:      "desc",
};

/* ── derived values (were useMemo) ── */
function getDoctors() {
  return Array.from(new Set(state.allRecords.map(function (r) { return r.doctor; }).filter(Boolean))).sort();
}
function getHospitals() {
  // Hospitals scoped to the selected doctor — falls back to all hospitals when no doctor is chosen yet.
  var pool = state.selDoctor
    ? state.allRecords.filter(function (r) { return r.doctor === state.selDoctor; })
    : state.allRecords;
  return Array.from(new Set(pool.map(function (r) { return r.hospital; }).filter(Boolean))).sort();
}
function getMethods() {
  return Array.from(new Set(state.allRecords.map(function (r) { return r.paymentMethod; }).filter(Boolean))).sort();
}
function canRun() {
  // Doctor is mandatory alongside quarter + FY
  return state.selDoctor !== "" && state.selQuarter !== "" && state.selFY !== "";
}
function isDoctorLocked() {
  return getDoctors().length === 1;
}

function getFiltered() {
  var applied = state.applied;
  if (!applied) return [];
  var bounds = getQuarterBounds(applied.fy, applied.quarter);
  var q = state.search.toLowerCase();
  return state.allRecords.filter(function (r) {
    if (applied.doctor && r.doctor !== applied.doctor) return false;
    if (bounds && r.paymentDate) {
      var d = new Date(r.paymentDate);
      if (d < bounds.start || d > bounds.end) return false;
    }
    if (applied.hospital !== "all" && r.hospital !== applied.hospital) return false;
    if (applied.method   !== "all" && r.paymentMethod !== applied.method) return false;
    if (q) {
      var hit = String(r.paymentId || "").toLowerCase().includes(q) ||
                String(r.payer || "").toLowerCase().includes(q) ||
                String(r.doctor || "").toLowerCase().includes(q) ||
                String(r.hospital || "").toLowerCase().includes(q) ||
                formatDisplayDate(r.paymentDate).includes(q);
      if (!hit) return false;
    }
    return true;
  });
}

function getAppliedInfo() {
  var applied = state.applied;
  var fyLabel = applied ? (FINANCIAL_YEARS.find(function (f) { return f.id === applied.fy; }) || {}).label || "" : "";
  var qLabel  = applied ? (BAS_QUARTERS.find(function (q) { return q.id === applied.quarter; }) || {}).label || "" : "";
  var practice = state.practiceName || (applied ? applied.practice : "") || "";
  return {
    practice: practice,
    fyLabel:  fyLabel,
    qLabel:   qLabel,
    period:   applied ? getPeriodLabel(applied.fy, applied.quarter) : "",
    doctor:   applied ? applied.doctor : "",
    hospital: applied && applied.hospital !== "all" ? applied.hospital : "All Hospitals",
    method:   applied && applied.method   !== "all" ? applied.method   : "All Methods",
    filename: applied
      ? (practice ? String(practice).replace(/\s+/g, "_") + "_" : "") +
        String(applied.doctor).replace(/\s+/g, "_") + "_" + applied.quarter + "_" + fyLabel.replace("/", "-")
      : "Payment_Report",
  };
}

/* ── actions (were the handlers in App()) ── */
function handleDoctorChange(value) {
  state.selDoctor = value;
  // Reset hospital and payment method choices when doctor changes
  state.selHospital = "all";
  state.selMethod = "all";
}

function syncDoctorLock() {
  // If only one doctor is available (portal user), select it automatically
  var doctors = getDoctors();
  if (doctors.length === 1 && state.selDoctor !== doctors[0]) handleDoctorChange(doctors[0]);
}

function handleRun() {
  if (!canRun()) return;
  state.running = true;
  render();
  setTimeout(function () {
    state.applied = {
      practice: state.practiceName, doctor: state.selDoctor, quarter: state.selQuarter, fy: state.selFY,
      hospital: state.selHospital, method: state.selMethod,
    };
    state.search = "";
    state.running = false;
    state.sortCol = "paymentDate";
    state.sortDir = "desc";
    render();
  }, 400);
}

function handleClear() {
  var doctors = getDoctors();
  state.selDoctor   = isDoctorLocked() ? doctors[0] : "";
  state.selQuarter  = "";
  state.selFY       = FINANCIAL_YEARS[0].id;
  state.selHospital = "all";
  state.selMethod   = "all";
  state.search      = "";
  state.applied     = null;
  render();
}


/* =====================================================================
   7) RENDERING  (was the JSX)
   ===================================================================== */
var LOGO_URL = "https://creatorapp.zohopublic.com.au/file//medielves/claims-management//All_Images/31559000000025010/Logo/image-download/PFxHZm68ZwuMKfkZz7yNOH7BZEes8UQN5ETOHD0bVY8Njqf0b9Zw5ZTe2XUK0CONRVfdmbQ9wteQdDnbWNCN4kVaeRZQhFrE6Tp5?filepath=/1774517256590556_Logo_design_with_green_leaf_accent.png";

var TABLE_COLS = [
  { key: "paymentId",     label: "Payment ID",     align: "left"  },
  { key: "hospital",      label: "Hospital",       align: "left",  render: function (r) { return r.hospital || "—"; } },
  { key: "amount",        label: "Amount",         align: "right", render: function (r) { return formatAUD(r.amount); } },
  { key: "payer",         label: "Payer Name",     align: "left",  render: function (r) { return r.payer || "—"; } },
  { key: "paymentDate",   label: "Payment Date",   align: "left",  render: function (r) { return formatDisplayDate(r.paymentDate); } },
  { key: "paymentMethod", label: "Payment Method", align: "left",  render: function (r) { return r.paymentMethod || "—"; } },
];

function renderHeader() {
  return (
    '<div style="' + st({
      display: "flex", alignItems: "center", justifyContent: "space-between", boxSizing: "border-box",
      background: P.surface, border: "1px solid " + P.border, padding: "0px 20px", marginBottom: 10, gap: 10, flexWrap: "wrap",
    }) + '">' +
      '<img class="header-logo" src="' + h(LOGO_URL) + '" alt="Medi Elves" style="' + st({ height: 69, objectFit: "contain" }) + '">' +
      '<h1 class="header-title" style="' + st({
        margin: 0, fontSize: 17, fontWeight: 800, color: P.text, fontFamily: "'Inter',sans-serif", letterSpacing: "0.01em",
      }) + '">BAS Payment Report</h1>' +
      /* BACK BUTTON (goes to portal_home_page) */
      '<button type="button" class="back-btn" onclick="goBackHome()" aria-label="Back to Home">' +
        '<span class="back-btn-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M14.5 6.5 9 12l5.5 5.5"/></svg></span>' +
        '<span class="back-btn-text">BACK</span>' +
      '</button>' +
    "</div>"
  );
}

function renderExportRow(filtered) {
  if (!(state.applied && filtered.length > 0)) return "";
  return (
    '<div class="apr-export-row">' +
      '<button type="button" data-act="export-csv" style="' + st(S.btn, S.btnOutline) + '">↓ Export CSV</button>' +
      '<button type="button" data-act="export-pdf" style="' + st(S.btn, S.btnOutline) + '">↓ Export PDF</button>' +
    "</div>"
  );
}

function renderQuarterChips() {
  return (
    '<div class="apr-quarter-ref" style="margin-left:20px">' +
      BAS_QUARTERS.map(function (q) {
        var on = state.selQuarter === q.id;
        return '<div class="apr-q-chip q-chip" data-act="chip" data-q="' + q.id + '" style="' + st(S.quarterChip, {
          background:  on ? "#1a5eb8" : "#eef2fb",
          color:       on ? "#fff"    : "#1a5eb8",
          borderColor: on ? "#1a5eb8" : "#c5d3ee",
        }) + '"><strong>' + q.id + '</strong><span style="font-weight:400">' + h(q.label.replace(q.id + "  ", "")) + "</span></div>";
      }).join("") +
    "</div>"
  );
}

function options(list, selected) {
  return list.map(function (o) {
    return '<option value="' + h(o.value) + '"' + (String(o.value) === String(selected) ? " selected" : "") + ">" + h(o.label) + "</option>";
  }).join("");
}

function renderFilterBar() {
  var doctors = getDoctors();
  var locked = doctors.length === 1;
  var run = canRun();
  var off = !run || state.loadingData;

  var doctorCtl = locked
    ? '<div style="' + st(S.select, { display: "flex", alignItems: "center", gap: 8, background: "#f3f6fb", color: "#111827", fontWeight: 600, cursor: "not-allowed" }) + '">' +
        "<span>👨‍⚕️</span>" +
        '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + h(doctors[0]) + "</span>" +
      "</div>"
    : '<select data-act="doctor" style="' + st(S.select) + '">' +
        options([{ value: "", label: "Select doctor…" }].concat(doctors.map(function (d) { return { value: d, label: d }; })), state.selDoctor) +
      "</select>";

  return (
    '<div style="' + st(S.filterBar) + '">' +
      '<div class="apr-filter-grid">' +
        // Row 1, Col 1: Practice (Login-based, disabled)
        '<div style="' + st(S.filterGroup) + '">' +
          '<label style="' + st(S.label) + '">Practice</label>' +
          '<input type="text" data-act="practice" value="' + h(state.practiceName || (state.loadingData ? "Loading practice…" : "—")) + '" disabled style="' + st(S.select, { background: "#f3f6fb", color: "#374151", cursor: "not-allowed", fontWeight: 600, border: "1px solid #d1d5db" }) + '" title="' + h(state.practiceName || "") + '">' +
        "</div>" +
        // Row 1, Col 2: Doctor (mandatory)
        '<div style="' + st(S.filterGroup) + '">' +
          '<label style="' + st(S.label) + '">Doctor<span class="apr-required-mark">*</span></label>' + doctorCtl +
        "</div>" +
        // Row 1, Col 3: Hospital — scoped to selected doctor
        '<div style="' + st(S.filterGroup) + '">' +
          '<label style="' + st(S.label) + '">Hospital</label>' +
          '<select data-act="hospital" style="' + st(S.select) + '"' + (state.selDoctor ? "" : " disabled") + ">" +
            options([{ value: "all", label: "All Hospitals" }].concat(getHospitals().map(function (x) { return { value: x, label: x }; })), state.selHospital) +
          "</select>" +
        "</div>" +
        // Row 2, Col 1: BAS Quarter
        '<div style="' + st(S.filterGroup) + '">' +
          '<label style="' + st(S.label) + '">BAS Quarter</label>' +
          '<select data-act="quarter" style="' + st(S.select) + '">' +
            options([{ value: "", label: "Select quarter…" }].concat(BAS_QUARTERS.map(function (q) { return { value: q.id, label: q.label }; })), state.selQuarter) +
          "</select>" +
        "</div>" +
        // Row 2, Col 2: Financial Year
        '<div style="' + st(S.filterGroup) + '">' +
          '<label style="' + st(S.label) + '">Financial Year</label>' +
          '<select data-act="fy" style="' + st(S.select) + '">' +
            options(FINANCIAL_YEARS.map(function (f) { return { value: f.id, label: f.label }; }), state.selFY) +
          "</select>" +
        "</div>" +
        // Row 2, Col 3: Payment Method
        '<div style="' + st(S.filterGroup) + '">' +
          '<label style="' + st(S.label) + '">Payment Method</label>' +
          '<select data-act="method" style="' + st(S.select) + '">' +
            options([{ value: "all", label: "All Methods" }].concat(getMethods().map(function (m) { return { value: m, label: m }; })), state.selMethod) +
          "</select>" +
        "</div>" +
      "</div>" +

      // Action buttons — own row below the grid, left-aligned
      '<div class="apr-action-row">' +
        '<button type="button" data-act="run" style="' + st(S.btn, S.btnPrimary, { opacity: off ? 0.5 : 1, cursor: off ? "not-allowed" : "pointer" }) + '"' + (off ? " disabled" : "") + ">" +
          (state.running ? "Running…" : "▶  Run Report") +
        "</button>" +
        (state.applied ? '<button type="button" data-act="clear" style="' + st(S.btn, S.btnGhost) + '">✕ Clear</button>' : "") +
      "</div>" +

      (!locked && !state.selDoctor
        ? '<div style="' + st(S.hintText) + '">Select a doctor to run the report. Hospitals will narrow to that doctor\'s locations.</div>'
        : "") +
    "</div>"
  );
}

function sortRows(rows) {
  var col = state.sortCol, dir = state.sortDir;
  return rows.slice().sort(function (a, b) {
    var av = a[col], bv = b[col];
    var cmp = typeof av === "number" ? av - bv : String(av).localeCompare(String(bv));
    return dir === "asc" ? cmp : -cmp;
  });
}

function arrow(col) {
  return state.sortCol !== col
    ? '<span style="color:#d1d5db;margin-left:3px;font-size:11px">↕</span>'
    : '<span style="color:#1a5eb8;margin-left:3px;font-size:11px">' + (state.sortDir === "asc" ? "↑" : "↓") + "</span>";
}

function renderPaymentsTable(rows) {
  var sorted = sortRows(rows);
  return (
    '<div class="pmt-table-scroll" style="' + st(S.tableWrap) + '">' +
      '<div class="apr-mobile-sort">' +
        '<label style="font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase">Sort</label>' +
        '<select data-act="msort-col">' +
          options(TABLE_COLS.map(function (c) { return { value: c.key, label: c.label }; }), state.sortCol) +
        "</select>" +
        '<button type="button" data-act="msort-dir">' + (state.sortDir === "asc" ? "↑" : "↓") + "</button>" +
      "</div>" +

      '<table class="pmt-table" style="' + st(S.table) + '">' +
        "<thead><tr>" +
          TABLE_COLS.map(function (c) {
            return '<th class="sort-th" data-act="sort" data-col="' + c.key + '" style="' + st(S.th, { textAlign: c.align }) + '">' + h(c.label) + arrow(c.key) + "</th>";
          }).join("") +
        "</tr></thead>" +
        "<tbody>" +
          sorted.map(function (row, i) {
            return '<tr class="pmt-row" style="background:' + (i % 2 === 0 ? "#fff" : "#f7f8fa") + '">' +
              TABLE_COLS.map(function (c) {
                var v = c.render ? c.render(row) : (row[c.key] || "—");
                return '<td data-label="' + h(c.label) + '" style="' + st(S.td, { textAlign: c.align }) + '">' + h(v) + "</td>";
              }).join("") +
            "</tr>";
          }).join("") +
        "</tbody>" +
      "</table>" +
    "</div>"
  );
}

function renderGrandSummary(rows) {
  var uniquePayers    = new Set(rows.map(function (r) { return r.payer; }).filter(Boolean)).size;
  var uniqueHospitals = new Set(rows.map(function (r) { return r.hospital; }).filter(Boolean)).size;
  var totalAmount     = sum(rows, "amount");

  var stats = [
    { label: "PAYMENTS", value: rows.length },
    { label: "PAYER",    value: uniquePayers },
    { label: "HOSPITAL", value: uniqueHospitals },
    { label: "AMOUNT",   value: formatAUD(totalAmount), big: true },
  ];

  return (
    '<div style="' + st(S.summaryCard) + '">' +
      '<div class="apr-summary-title" style="' + st(S.summaryTitle) + '">GRAND SUMMARY</div>' +
      '<div class="apr-summary-row">' +
        stats.map(function (s) {
          return '<div class="apr-summary-col" style="' + st(S.summaryCol) + '">' +
            '<div class="apr-summary-label" style="' + st(S.summaryLabel) + '">' + h(s.label) + "</div>" +
            '<div class="apr-summary-value" style="' + st(S.summaryValue, s.big ? S.summaryValueBig : {}) + '">' + h(s.value) + "</div>" +
          "</div>";
        }).join("") +
      "</div>" +
    "</div>"
  );
}

function renderTableBody(filtered) {
  if (filtered.length === 0) {
    return '<div style="padding:40px 24px;text-align:center;color:#9ca3af;font-size:14px">' +
      "No payments found for this doctor and period. Try a different quarter, hospital or method.</div>";
  }
  return renderPaymentsTable(filtered) + renderGrandSummary(filtered);
}

function renderSearchClear() {
  return state.search ? '<button type="button" data-act="search-clear" style="' + st(S.searchClear) + '">✕</button>' : "";
}

function renderCount(filtered) {
  return filtered.length + " record" + (filtered.length !== 1 ? "s" : "");
}

function renderContent(filtered) {
  var html = "";

  // Loading data
  if (state.loadingData) {
    html += '<div style="' + st(S.centered) + '"><div style="' + st(S.spinner) + '"></div>' +
      '<span style="color:#6b7280;margin-left:12px">Loading payments from Zoho Creator…</span></div>';
  }

  // Error
  if (state.dataError) {
    html += '<div style="' + st(S.errorBox) + '">' +
      '<div style="' + st(S.errorIcon) + '">⚠</div>' +
      "<div>" +
        '<div style="font-weight:600;margin-bottom:4px">Failed to load records</div>' +
        '<div style="font-size:13px;color:#b91c1c">' + h(state.dataError) + "</div>" +
        '<div style="font-size:12px;color:#9ca3af;margin-top:6px">Check reports: <code>' + h(ZOHO_CONFIG.PRACTICE_REPORT) + '</code>, <code>' + h(ZOHO_CONFIG.MAPPING_REPORT) + '</code>, <code>' + h(ZOHO_CONFIG.PAYMENTS_REPORT) + '</code>.</div>' +
      "</div>" +
    "</div>";
  }

  // Not yet run
  if (!state.loadingData && !state.dataError && !state.applied && !state.running) {
    html += '<div style="' + st(S.emptyState) + '">' +
      '<div style="' + st(S.emptyIcon) + '">📊</div>' +
      '<div style="' + st(S.emptyTitle) + '">Select a doctor and run the report</div>' +
      '<div style="' + st(S.emptyBody) + '">Choose a <strong>Doctor</strong>, <strong>BAS Quarter</strong> and <strong>Financial Year</strong>, ' +
        "optionally a hospital or payment method, then click <strong>▶ Run Report</strong>.</div>" +
    "</div>";
  }

  // Running spinner
  if (state.running) {
    html += '<div style="' + st(S.centered) + '"><div style="' + st(S.spinner) + '"></div>' +
      '<span style="color:#6b7280;margin-left:12px">Applying filters…</span></div>';
  }

  // Results
  if (!state.running && state.applied) {
    html += '<div class="fade-in">' +
      // Search + record count
      '<div class="apr-search-row">' +
        '<div class="apr-search-wrap">' +
          '<span style="' + st(S.searchIcon) + '">🔍</span>' +
          '<input id="apr-search" data-act="search" style="' + st(S.searchInput) + '" placeholder="Search payment ID, payer, doctor, hospital or date…" value="' + h(state.search) + '">' +
          '<span id="apr-search-clear-slot" style="display:contents">' + renderSearchClear() + "</span>" +
        "</div>" +
        '<span id="apr-count" style="' + st(S.recordCount) + '">' + renderCount(filtered) + "</span>" +
      "</div>" +
      // Table
      '<div style="' + st(S.tableSection) + '">' +
        '<div style="' + st(S.tableTitleRow) + '"><h2 style="' + st(S.tableTitle) + '">Payment Detail</h2></div>' +
        '<div id="apr-table-slot" style="display:contents">' + renderTableBody(filtered) + "</div>" +
      "</div>" +
    "</div>";
  }

  return '<div style="margin-left:20px;margin-right:20px">' + html + "</div>";
}

/* Full page render */
function render() {
  syncDoctorLock();
  var filtered = getFiltered();
  var root = document.getElementById("root");
  root.innerHTML =
    '<div class="apr-page" style="' + st(S.page) + '">' +
      renderHeader() +
      '<div class="apr-page-header">' +
        '<div><h1 class="apr-page-title" style="' + st(S.pageTitle) + '"></h1></div>' +
        '<div id="apr-export-slot" style="display:contents">' + renderExportRow(filtered) + "</div>" +
      "</div>" +
      renderQuarterChips() +
      renderFilterBar() +
      renderContent(filtered) +
    "</div>";
}

/* Re-draw only the results (search / sort) so the search box keeps focus while typing */
function renderResultsOnly() {
  var filtered = getFiltered();
  var slot = document.getElementById("apr-table-slot");
  if (!slot) { render(); return; }
  slot.innerHTML = renderTableBody(filtered);
  document.getElementById("apr-count").textContent = renderCount(filtered);
  document.getElementById("apr-search-clear-slot").innerHTML = renderSearchClear();
  document.getElementById("apr-export-slot").innerHTML = renderExportRow(filtered);
}


/* =====================================================================
   8) EVENTS
   ===================================================================== */
function onRootClick(e) {
  var el = e.target.closest("[data-act]");
  if (!el || el.disabled) return;
  var act = el.getAttribute("data-act");

  if (act === "chip") {
    state.selQuarter = el.getAttribute("data-q");
    render();
  } else if (act === "run") {
    handleRun();
  } else if (act === "clear") {
    handleClear();
  } else if (act === "export-csv") {
    var a = getAppliedInfo();
    exportCSV(getFiltered(), { doctor: a.doctor, hospital: a.hospital, quarter: a.qLabel, fy: a.fyLabel, practice: a.practice }, a.filename);
  } else if (act === "export-pdf") {
    var b = getAppliedInfo();
    exportPDF(getFiltered(), {
      doctor: b.doctor, quarter: b.qLabel, period: b.period,
      fy: b.fyLabel, hospital: b.hospital, method: b.method,
      practice: b.practice,
    }, b.filename);
  } else if (act === "sort") {
    var col = el.getAttribute("data-col");
    if (state.sortCol === col) state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
    else { state.sortCol = col; state.sortDir = "asc"; }
    renderResultsOnly();
  } else if (act === "msort-dir") {
    state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
    renderResultsOnly();
  } else if (act === "search-clear") {
    state.search = "";
    var input = document.getElementById("apr-search");
    if (input) input.value = "";
    renderResultsOnly();
  }
}

function onRootChange(e) {
  var el = e.target;
  var act = el.getAttribute && el.getAttribute("data-act");
  if (!act) return;

  if (act === "doctor")        { handleDoctorChange(el.value); render(); }
  else if (act === "quarter")  { state.selQuarter = el.value; render(); }
  else if (act === "fy")       { state.selFY = el.value; render(); }
  else if (act === "hospital") { state.selHospital = el.value; render(); }
  else if (act === "method")   { state.selMethod = el.value; render(); }
  else if (act === "msort-col"){ state.sortCol = el.value; renderResultsOnly(); }
}

function onRootInput(e) {
  var el = e.target;
  if (el.getAttribute && el.getAttribute("data-act") === "search") {
    state.search = el.value;
    renderResultsOnly();
  }
}


/* =====================================================================
   9) START  (was the "Load from Zoho" useEffect)
   ===================================================================== */
(function start() {
  var root = document.getElementById("root");
  root.addEventListener("click", onRootClick);
  root.addEventListener("change", onRootChange);
  root.addEventListener("input", onRootInput);

  render(); // shows "Loading payments from Zoho Creator…"

  (async function () {
    try {
      await initZoho();
      await getInitParams();

      // 1. Fetch practice details (from #Report:My_Practice)
      var practice = await getPracticeDetails();
      state.practiceId = practice.id || "";
      state.practiceName = practice.name || "";

      // 2. Fetch doctor-hospital mappings (from #Report:Doctor_Hospital_Subform_Report)
      var mappings = await getDoctorHospitalMappings(state.practiceId, state.practiceName);
      state.mappings = mappings;

      // 3. Fetch practice payments (from #Report:Practice_Payments)
      var payments = await getAllPaymentRecords();
      state.allPayments = payments;

      // 4. Relational matching:
      // if (#Report:Doctor_Hospital_Subform_Report doctor and hospital == #Report:Practice_Payments Doctor and Hospital)
      state.allRecords = filterPaymentsByPracticeMappings(payments, mappings);

      syncDoctorLock();
    } catch (err) {
      console.error("[start] Failed to load records:", err);
      state.dataError = formatError(err);
    } finally {
      state.loadingData = false;
      render();
    }
  })();
})();

/* =====================================================================
   10) MOBILE PDF / EXCEL DOWNLOAD  (same method as the reference code)
     - Laptop / desktop : normal download (unchanged)
     - Phone browser    : share sheet ("Save to Files" on iPhone), else a download panel
     - Zoho Creator app : downloads are blocked inside the app, so the file is stored in
                          the Export_PDF / Export_Excel field of ONE fixed payment record,
                          then a "Download PDF/Excel file" button opens it.
   ===================================================================== */

/* Styles for the download panel (injected here so style.css does not need changes) */
(function () {
  if (document.getElementById("dl-panel-style")) return;
  const st = document.createElement("style");
  st.id = "dl-panel-style";
  st.textContent = "/* ===== DOWNLOAD FALLBACK (shown only if the device cannot save the file directly) ===== */ .dl-overlay { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 16px; background: rgba(0,0,0,0.45); } .dl-box { background: #fff; border-radius: 12px; padding: 20px; width: 100%; max-width: 360px; text-align: center; box-shadow: 0 20px 50px rgba(0,0,0,0.25); } .dl-title { font-size: 15px; font-weight: 700; color: #1a1a1a; margin-bottom: 6px; } .dl-name { font-size: 12px; color: #6b7280; word-break: break-all; margin-bottom: 16px; } .dl-link { display: block; padding: 11px 14px; border-radius: 8px; background: #12694f; color: #fff; font-size: 14px; font-weight: 600; text-decoration: none; margin-bottom: 10px; } .dl-close { display: block; width: 100%; padding: 10px 14px; border: 1px solid #d1d5db; border-radius: 8px; background: #fff; color: #374151; font-size: 13px; cursor: pointer; } button.dl-share { width: 100%; border: none; cursor: pointer; font-family: inherit; }";
  (document.head || document.documentElement).appendChild(st);
})();

function safeAlert(msg) { try { alert(msg); } catch (e) { console.error(msg); } }

/* ===================================================
   FILE DELIVERY (PDF / Excel) — same method as the reference code
     - Laptop / desktop : normal download (doc.save / XLSX.writeFile)
     - Zoho Creator app : browser downloads are blocked, so the file is uploaded into
                          Export_PDF / Export_Excel of ONE fixed record per doctor, then a
                          "Download" button opens the stored file outside the widget.
     - Phone browser    : share sheet, else tap-to-download panel
   =================================================== */
function isMobileDevice() {
  const ua = navigator.userAgent || "";
  return /Android|iPhone|iPad|iPod|Mobile/i.test(ua) ||
         (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);   // iPadOS
}

function triggerAnchorDownload(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(function () {
    if (a.parentNode) a.parentNode.removeChild(a);
    URL.revokeObjectURL(url);
  }, 4000);
}

function showDownloadFallback(blob, fileName, mimeType) {
  const old = document.getElementById("dl-overlay");
  if (old) old.remove();

  const url = URL.createObjectURL(blob);
  const wrap = document.createElement("div");
  wrap.id = "dl-overlay";
  wrap.className = "dl-overlay";

  const box = document.createElement("div");
  box.className = "dl-box";

  const title = document.createElement("div");
  title.className = "dl-title";
  title.textContent = "Your file is ready";

  const name = document.createElement("div");
  name.className = "dl-name";
  name.textContent = fileName;

  // Fresh tap = fresh permission, so the share sheet works here even if it did not earlier
  let shareBtn = null;
  try {
    const f = new File([blob], fileName, { type: mimeType || blob.type });
    if (navigator.share && navigator.canShare && navigator.canShare({ files: [f] })) {
      shareBtn = document.createElement("button");
      shareBtn.type = "button";
      shareBtn.className = "dl-link dl-share";
      shareBtn.textContent = "Save / Share file";
      shareBtn.addEventListener("click", async function () {
        try {
          await navigator.share({ files: [f], title: fileName });
          dismiss();
        } catch (e) {
          if (!e || e.name !== "AbortError") console.warn("Share failed:", e);
        }
      });
    }
  } catch (e) { /* share not supported */ }

  const link = document.createElement("a");
  link.className = "dl-link";
  link.href = url;
  link.download = fileName;
  const onIOS = isIOSDevice();
  if (!onIOS) {                       // iPhone/iPad: a new tab opens empty, so open the file in this tab
    link.target = "_blank";
    link.rel = "noopener";
  }
  link.textContent = onIOS ? "Download file" : "Open in browser";

  const close = document.createElement("button");
  close.type = "button";
  close.className = "dl-close";
  close.textContent = "Close";

  function dismiss() {
    wrap.remove();
    // iPhone/iPad read the file after the tap, so keep it available for a minute
    setTimeout(function () { URL.revokeObjectURL(url); }, isIOSDevice() ? 60000 : 1000);
  }
  close.addEventListener("click", dismiss);
  link.addEventListener("click", function () { setTimeout(dismiss, 1500); });

  box.appendChild(title);
  box.appendChild(name);
  if (shareBtn) box.appendChild(shareBtn);
  box.appendChild(link);
  if (onIOS) {
    const hint = document.createElement("div");
    hint.className = "dl-name";
    hint.textContent = "iPhone: when the file opens, tap Share, then \u201cSave to Files\u201d \u2192 On My iPhone \u2192 Save.";
    box.appendChild(hint);
  }
  box.appendChild(close);
  wrap.appendChild(box);
  document.body.appendChild(wrap);
}

/* ---------------------------------------------------------------
   FILE STORE (same method as the reference code)
   In the Zoho Creator mobile app, browser downloads are blocked, so the file is
   uploaded into the Export_PDF / Export_Excel file field of the doctor's own record in
   the "Report Export" form (Report_Export). Each doctor has ONE export record that is
   reused every time: it is looked up in the form's report, and created only the very first
   time. The doctor then taps a button that opens the stored file outside the widget, and
   the phone downloads it.
   --------------------------------------------------------------- */
const FILE_STORE = {
  FORM:          "Report_Export",                     // ← link name of the "Report Export" form
  /* Report of the Report_Export form. Zoho names it automatically; the common names are tried
     in this order. Put your report's exact link name FIRST if it is different. */
  UPLOAD_REPORTS: ["Report_Export_Report", "All_Report_Exports", "Report_Exports", "Report_Export"],
  UPLOAD_REPORT: "Report_Export_Report",              // set to the report that worked (used for upload / read-back / open report)
  PDF_FIELD:     "Export_PDF",                        // ← link name of the "Export_PDF" file field
  EXCEL_FIELD:   "Export_Excel",                      // ← link name of the "Export Excel" file field
  BASE_URL:      "https://creatorapp.zoho.com.au"   // used only if the Creator origin cannot be detected
};

function withTimeout(p, ms, msg) {
  return Promise.race([p, new Promise(function (_, rej) { setTimeout(function () { rej(new Error(msg)); }, ms); })]);
}

/* true on iPhone / iPad (iPadOS reports a Mac with a touch screen) */
function isIOSDevice() {
  const ua = navigator.userAgent || "";
  return /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
}

/* true when running inside the Zoho Creator mobile app (Android WebView / iOS in-app view) */
function isCreatorApp() {
  const ua = navigator.userAgent || "";
  if (/; wv\)/.test(ua)) return true;                                   // Android WebView
  if (/ZohoCreator|ZCreator/i.test(ua)) return true;
  if (/iPhone|iPad|iPod/i.test(ua) && !/Safari/i.test(ua)) return true; // iOS in-app view
  if (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1 && !/Safari/i.test(ua)) return true; // iPadOS app
  return false;
}

/* The doctor's export record in Report_Export: found once, then reused (cached).
   - looks in the form's report (portal users normally see only their own records)
   - if the report is empty for this user, ONE record is added to the form
   Returns the record ID and remembers which report name worked. */
var EXPORT_RECORD_ID = "";
function smallestId(rows) {
  const ids = (rows || []).map(function (r) { return String(r && r.ID || ""); }).filter(function (id) { return /^\d+$/.test(id); });
  ids.sort(function (x, y) { return x.length - y.length || (x < y ? -1 : x > y ? 1 : 0); });
  return ids[0] || "";
}
function isNoRecordsResp(r) {
  return !!r && (r.code === 3100 || /no records/i.test(String(r.message || "")));
}
async function getExportRecordId(appName) {
  if (EXPORT_RECORD_ID) return EXPORT_RECORD_ID;
  if (!ZOHO.CREATOR.DATA || !ZOHO.CREATOR.DATA.getRecords) throw new Error("Data API is not available in this widget SDK.");

  const reports = FILE_STORE.UPLOAD_REPORTS.slice();
  const problems = [];
  let reportFound = "";

  for (let i = 0; i < reports.length && !reportFound; i++) {
    const cfg = { report_name: reports[i], max_records: 200 };
    if (appName) cfg.app_name = appName;
    let resp;
    try { resp = await withTimeout(ZOHO.CREATOR.DATA.getRecords(cfg), 20000, "Reading the export report timed out."); }
    catch (e) { resp = normalizeZohoError(e); }

    if (resp && resp.code === 3000) {
      reportFound = reports[i];
      const id = smallestId(resp.data);
      if (id) { FILE_STORE.UPLOAD_REPORT = reportFound; EXPORT_RECORD_ID = id; return id; }
    } else if (isNoRecordsResp(resp)) {
      reportFound = reports[i];                       // report exists, just no record for this user yet
    } else {
      problems.push(reports[i] + ": " + ((resp && resp.message) || "not available"));
    }
  }

  if (!reportFound) {
    throw new Error("Could not open the report of the '" + FILE_STORE.FORM + "' form. Tried: " + reports.join(", ") +
      ". Put the report's exact link name first in FILE_STORE.UPLOAD_REPORTS (script.js) and give the doctors " +
      "permission to view it.\n\n" + problems.join("\n"));
  }
  FILE_STORE.UPLOAD_REPORT = reportFound;

  // First export for this doctor: add ONE empty record to the Report_Export form
  if (!ZOHO.CREATOR.DATA.addRecords) throw new Error("Add-record API is not available in this widget SDK.");
  const addCfg = { form_name: FILE_STORE.FORM, payload: { data: {} } };
  if (appName) addCfg.app_name = appName;
  let added;
  try { added = await withTimeout(ZOHO.CREATOR.DATA.addRecords(addCfg), 20000, "Creating the export record timed out."); }
  catch (e) { added = normalizeZohoError(e); }
  const newId = added && added.data && (added.data.ID || (Array.isArray(added.data) && added.data[0] && added.data[0].data && added.data[0].data.ID));
  if (!added || added.code !== 3000 || !newId) {
    throw new Error("Could not create your record in the '" + FILE_STORE.FORM + "' form" +
      (added && added.code ? " (code " + added.code + ")" : "") + ": " + ((added && added.message) || "unknown error") +
      ". Give the doctors' permission set 'Add' access to the " + FILE_STORE.FORM + " form, or submit the form once.");
  }
  EXPORT_RECORD_ID = String(newId);
  return EXPORT_RECORD_ID;
}

/* Turns whatever the SDK rejects with (object, JSON text, Error, nested object) into { code, message } */
function normalizeZohoError(e) {
  if (!e) return { message: "Unknown error" };
  if (e instanceof Error) return { message: e.message };
  if (typeof e === "string") {
    try { return normalizeZohoError(JSON.parse(e)); } catch (x) { return { message: e }; }
  }
  if (typeof e === "object") {
    if (e.responseText) {
      try { return normalizeZohoError(JSON.parse(e.responseText)); } catch (x) { return { message: String(e.responseText) }; }
    }
    if (e.code !== undefined) return e;
    if (e.error) return normalizeZohoError(e.error);
    if (e.data && typeof e.data === "object") return normalizeZohoError(e.data);
    let txt = "";
    try { txt = JSON.stringify(e); } catch (x) { txt = String(e); }
    return { message: txt };
  }
  return { message: String(e) };
}

/* Readable explanation of an upload error */
function describeZohoError(r, fieldName, report) {
  r = r || {};
  const code = r.code;
  const msg  = String(r.message || r.description || "").replace("%s", fieldName);
  if (code === 3830) {
    return "No permission to upload into '" + fieldName + "' through this report (code 3830). " +
           "Add '" + fieldName + "' to the report '" + report + "' (column list + Detail View) and make it " +
           "editable for the doctor's permission set.";
  }
  if (code === 2945 || code === 2933 || /not found|does not exist|no such/i.test(msg)) {
    return "Report not found or not accessible for this user (" + (code || "") + "). " + msg;
  }
  if (code === 2930 || /permission|not authori[sz]ed|access/i.test(msg)) {
    return "No permission for this report (" + (code || "") + "). " + msg;
  }
  return (code ? "Code " + code + ": " : "") + (msg || "Upload failed");
}

/* Upload the file into Export_PDF / Export_Excel of the fixed record */
async function uploadToCreator(blob, fileName, mimeType) {
  if (typeof ZOHO === "undefined" || !ZOHO.CREATOR || !ZOHO.CREATOR.FILE || !ZOHO.CREATOR.FILE.uploadFile) {
    throw new Error("File upload API is not available in this widget SDK.");
  }
  let appName = ZOHO_CONFIG.APP_NAME || "";          // same app_name the report data is read with

  const recId = await getExportRecordId(appName);    // the doctor's own record in Report_Export

  const fieldName = /pdf/i.test(mimeType) ? FILE_STORE.PDF_FIELD : FILE_STORE.EXCEL_FIELD;
  const reports = [FILE_STORE.UPLOAD_REPORT];

  const errors = [];
  for (let i = 0; i < reports.length; i++) {
    const cfg = {
      report_name: reports[i],
      id:          String(recId),
      field_name:  fieldName,
      file:        new File([blob], fileName, { type: mimeType })
    };
    if (appName) cfg.app_name = appName;

    let resp;
    try {
      resp = await withTimeout(ZOHO.CREATOR.FILE.uploadFile(cfg), 60000, "File upload timed out.");
    } catch (e) {
      resp = normalizeZohoError(e);
    }

    if (resp && resp.code === 3000) {
      FILE_STORE.UPLOAD_REPORT = reports[i];          // remember the report that accepted the file
      return { recId: String(recId), recNo: "", fieldName: fieldName, appName: appName };
    }

    console.warn("Upload via " + reports[i] + " failed:", resp);
    let why = describeZohoError(resp, fieldName, reports[i]);
    if (resp && resp.code === 3830) {
      why = "Creator blocked the upload (code 3830). Check: (1) the file field '" + fieldName + "' is added to the report '" +
            reports[i] + "' of the " + FILE_STORE.FORM + " form; (2) in the doctor's permission set, " + FILE_STORE.FORM +
            " > Field Access, '" + fieldName + "' is visible and editable (and the report allows Edit).";
    }
    errors.push(reports[i] + ": " + why);
  }

  throw new Error(errors.join("\n\n"));
}

/* Read the record back and build the download URL of the uploaded file */
async function getStoredFileUrl(recId, fieldName, appName) {
  let resp;
  try {
    const cfg = { report_name: FILE_STORE.UPLOAD_REPORT, id: String(recId) };
    if (appName) cfg.app_name = appName;
    resp = await withTimeout(ZOHO.CREATOR.DATA.getRecordById(cfg), 20000, "timeout");
  } catch (e) { console.warn("getRecordById failed", e); return ""; }

  const rec = resp && resp.data;
  if (!rec) return "";
  let v = rec[fieldName];
  if (v && typeof v === "object") v = v.url || v.value || v.display_value || v.download_url || "";
  v = String(v || "").trim();
  if (!v) return "";
  v = toWebFileUrl(v);
  if (/^https?:\/\//i.test(v)) return v;

  let origin = "";
  try { origin = document.referrer ? new URL(document.referrer).origin : ""; } catch (e) {}
  if (!origin) origin = FILE_STORE.BASE_URL;
  return origin + (v.charAt(0) === "/" ? "" : "/") + v;
}

/* The record API returns the file as an API link
     /api/v2/<owner>/<app>/report/<report>/<id>/<field>/download?filepath=<name>
   Opened from the Zoho app on iPhone, that link has no sign-in and no file name, so iOS saves a
   blank file named with a random ID (black screen). Creator's normal file link uses the app's own
   sign-in and keeps the real name (.pdf / .xlsx):
     /file/<owner>/<app>/<report>/<id>/<field>/download?filepath=/<name> */
function toWebFileUrl(v) {
  const m = /^(https?:\/\/[^\/]+)?\/(?:api|creator)\/v2(?:\.1)?\/([^\/]+)\/([^\/]+)\/report\/([^\/]+)\/([^\/]+)\/([^\/]+)\/download\?(.*)$/i.exec(v);
  if (!m) return v;
  const q = m[7].replace(/(^|&)filepath=(?!%2F|\/)/i, "$1filepath=/");
  const host = (m[1] && !/zohoapis/i.test(m[1])) ? m[1] : "";   // API host -> use the Creator site instead
  return host + "/file/" + m[2] + "/" + m[3] + "/" + m[4] + "/" + m[5] + "/" + m[6] + "/download?" + q;
}

/* Open the stored file outside the widget -> phone download manager saves it */
function openFileUrl(url) {
  try {
    ZOHO.CREATOR.UTIL.navigateParentURL({ action: "open", url: url, window: "new" });
  } catch (e) { safeAlert("Could not open the file: " + (e && e.message ? e.message : e)); }
}

/* Fallback: open the report that holds the file */
function openFileReport() {
  try {
    ZOHO.CREATOR.UTIL.navigateParentURL({ action: "open", url: "#Report:" + FILE_STORE.UPLOAD_REPORT, window: "same" });
  } catch (e) { safeAlert("Could not open the report: " + (e && e.message ? e.message : e)); }
}

/* Status panel: progress, error and success states */
function openReadyPanel() {
  const old = document.getElementById("dl-overlay");
  if (old) old.remove();

  const wrap = document.createElement("div");
  wrap.id = "dl-overlay";
  wrap.className = "dl-overlay";
  const box = document.createElement("div");
  box.className = "dl-box";
  wrap.appendChild(box);
  document.body.appendChild(wrap);

  function mkText(cls, text) {
    const d = document.createElement("div");
    d.className = cls;
    d.textContent = text;
    return d;
  }
  function mkClose(label) {
    const c = document.createElement("button");
    c.type = "button";
    c.className = "dl-close";
    c.textContent = label || "Close";
    c.addEventListener("click", function () { wrap.remove(); });
    return c;
  }

  return {
    wrap: wrap,
    box: box,
    close: function () { wrap.remove(); },

    setBusy: function (msg) {
      box.innerHTML = "";
      box.appendChild(mkText("dl-title", msg));
      box.appendChild(mkText("dl-name", "Please wait, do not close this page."));
    },

    setError: function (msg) {
      box.innerHTML = "";
      box.appendChild(mkText("dl-title", "Could not prepare the file"));
      const em = mkText("dl-name", msg || "Please try again."); em.style.whiteSpace = "pre-line"; em.style.wordBreak = "break-word"; box.appendChild(em);
      box.appendChild(mkClose("Close"));
    },

    /* Creator mobile app: only when the doctor taps the button, the stored file opens and downloads */
    setCreatorFile: function (fileName, fileUrl, recNo, fieldName) {
      box.innerHTML = "";
      box.appendChild(mkText("dl-title", "Your file is ready"));
      box.appendChild(mkText("dl-name", fileName));

      if (fileUrl) {
        const dl = document.createElement("button");
        dl.type = "button";
        dl.className = "dl-link dl-share";
        dl.textContent = /pdf/i.test(fileName) ? "Download PDF file" : "Download Excel file";
        dl.addEventListener("click", function () { openFileUrl(fileUrl); });
        box.appendChild(dl);
      }

      const fieldLabel = String(fieldName || "").replace(/_/g, " ");
      const which = recNo ? "record " + recNo : "your Report Export record";
      const help = document.createElement("div");
      help.className = "dl-name";
      help.appendChild(document.createTextNode((fileUrl ? "If it does not download, " : "") + "open the report, open " +
        which + " and tap the " + fieldLabel + " file. "));
      const rep = document.createElement("a");
      rep.href = "#";
      rep.textContent = "Open the report";
      rep.style.fontWeight = "700";
      rep.addEventListener("click", function (e) { e.preventDefault(); openFileReport(); });
      help.appendChild(rep);
      box.appendChild(help);
      if (isIOSDevice()) {
        box.appendChild(mkText("dl-name", "iPhone: when the file opens, tap Share, then \u201cSave to Files\u201d \u2192 On My iPhone \u2192 Save."));
      }

      box.appendChild(mkClose("Close"));
    }
  };
}

/* Same flow as the reference saveFile():
   - Laptop / desktop: normal download (saveFn = doc.save / XLSX.writeFile)
   - Zoho Creator mobile app: upload to the fixed record -> "Download" button opens the stored file
   - Phone browser: share sheet, else tap-to-download panel */
function deliverFile(blob, fileName, mimeType, saveFn) {

  // 1) Desktop: normal browser download
  if (!isMobileDevice()) {
    try { saveFn(); }
    catch (e) {
      console.error("Direct save failed:", e);
      try { triggerAnchorDownload(blob, fileName); } catch (e2) { console.error(e2); }
    }
    return;
  }

  // 2) Zoho Creator mobile app: downloads are blocked, so store the file in Creator
  if (isCreatorApp()) {
    const panel = openReadyPanel();
    panel.setBusy("Preparing your file...");
    uploadToCreator(blob, fileName, mimeType)
      .then(function (info) {
        return getStoredFileUrl(info.recId, info.fieldName, info.appName).then(function (url) {
          console.log("Stored file URL:", url);
          panel.setCreatorFile(fileName, url, info.recNo, info.fieldName);
        });
      })
      .catch(function (e) {
        console.error("Upload failed:", e);
        panel.setError((e && e.message) ? e.message : String(e));
      })
      .finally(function () { /* no page loader here */ });
    return;
  }

  // 3) Phone browser (Chrome / Safari): share sheet, else tap-to-download panel
  try {
    const f = new File([blob], fileName, { type: mimeType || blob.type });
    if (navigator.share && navigator.canShare && navigator.canShare({ files: [f] })) {
      navigator.share({ files: [f], title: fileName }).catch(function (e) {
        if (e && e.name === "AbortError") return;
        showDownloadFallback(blob, fileName, mimeType);
      });
      return;
    }
  } catch (e) { /* share not supported */ }
  showDownloadFallback(blob, fileName, mimeType);
}