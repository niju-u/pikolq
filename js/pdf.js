/**
 * pdf.js: builds the PDFs (match history, player statistics) with jsPDF.
 * They look the same on every device and have no browser header/footer.
 * The library only loads when Export is pressed. If it fails, the caller handles it.
 */

const PdfExport = (() => {
  const LIBS = [
    'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js',
  ];

  const PLUM = [111, 82, 127];
  const TEXT = [51, 40, 59];
  const MUTED = [110, 100, 117];
  const LINE = [222, 215, 226];
  const AMBER = [133, 90, 0];

  let loading = null;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.crossOrigin = 'anonymous';
      s.referrerPolicy = 'no-referrer';
      s.onload = resolve;
      s.onerror = () => reject(new Error(`Could not load ${src}`));
      document.head.appendChild(s);
    });
  }

  function loadLibs() {
    if (window.jspdf && window.jspdf.jsPDF && window.jspdf.jsPDF.API.autoTable) return Promise.resolve();
    if (!loading) {
      loading = LIBS.reduce((p, src) => p.then(() => loadScript(src)), Promise.resolve())
        .catch(err => { loading = null; throw err; });
    }
    return loading;
  }

  /** Load an image and convert it to PNG (jsPDF can't use WebP). */
  function loadImageAsPng(url, maxSide) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const scale = maxSide ? Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight)) : 1;
        const w = Math.round(img.naturalWidth * scale);
        const h = Math.round(img.naturalHeight * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve({ data: canvas.toDataURL('image/png'), w, h });
      };
      img.onerror = () => reject(new Error(`Could not load image ${url}`));
      img.src = url;
    });
  }

  function playerColumns(n) {
    return n <= 6 ? 2 : n <= 18 ? 3 : n <= 36 ? 4 : n <= 60 ? 5 : 6;
  }

  /**
   * Start a PDF: faint sponsor badge behind every page, title, subtitle, sponsor logo and a rule.
   * data needs { sessionName, dateLabel, courts, matchType, sponsorUrl, logoUrl, watermarkUrl }.
   * Returns { doc, W, H, M, y, docTitle, drawWatermark } where y is where content can begin.
   */
  async function startDocument(data, title) {
    await loadLibs();
    const [watermark, logo] = await Promise.all([
      loadImageAsPng(data.watermarkUrl, 700),
      loadImageAsPng(data.logoUrl),
    ]);

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
    const W = doc.internal.pageSize.getWidth();
    const H = doc.internal.pageSize.getHeight();
    const M = 15;

    // Session name with characters that aren't allowed in file names removed
    const safeName = (data.sessionName || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
    const docTitle = [title, safeName, data.dateLabel].filter(Boolean).join(' - ');
    doc.setProperties({ title: docTitle, subject: 'Pickleball open play results', creator: 'Pickleball Open Play' });

    // ---- faint sponsor badge behind every page (drawn first) ----
    const pagesWithWatermark = new Set();
    function drawWatermark() {
      const page = doc.internal.getCurrentPageInfo().pageNumber;
      if (pagesWithWatermark.has(page)) return;
      pagesWithWatermark.add(page);
      const size = Math.min(W - 2 * M, 170);
      doc.saveGraphicsState();
      doc.setGState(new doc.GState({ opacity: 0.1 }));
      doc.addImage(watermark.data, 'PNG', (W - size) / 2, (H - size) / 2, size, size, 'watermark', 'FAST');
      doc.restoreGraphicsState();
    }
    drawWatermark();

    // ---- title + sponsor ----
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(19);
    doc.setTextColor(...TEXT);
    doc.text(title, M, M + 7);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(...MUTED);
    const courtsLabel = `${data.courts} court${data.courts === 1 ? '' : 's'}`;
    const subtitle = [data.sessionName, data.dateLabel, courtsLabel, data.matchType].filter(Boolean);
    doc.text(subtitle.join('  ·  '), M, M + 13);

    const logoH = 15;
    const logoW = logoH * (logo.w / logo.h);
    const logoX = W - M - logoW;
    const logoY = M - 2;
    doc.addImage(logo.data, 'PNG', logoX, logoY, logoW, logoH, 'sponsor', 'FAST');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(6.5);
    doc.setTextColor(...MUTED);
    doc.text('SPONSORED BY', logoX - 2.5, logoY + logoH / 2 + 1, { align: 'right' });
    if (data.sponsorUrl) {
      doc.link(logoX - 24, logoY, logoW + 24, logoH, { url: data.sponsorUrl });
    }

    let y = M + 19;
    doc.setDrawColor(...TEXT);
    doc.setLineWidth(0.5);
    doc.line(M, y, W - M, y);
    y += 8;

    return { doc, W, H, M, y, docTitle, drawWatermark };
  }

  function saveDocument(doc, docTitle, options) {
    if (options.save === false) return;
    try {
      doc.save(`${docTitle}.pdf`);
    } catch (err) {
      // Some in-app browsers block downloads, so show the PDF instead
      window.open(doc.output('bloburl'), '_blank');
    }
  }

  /**
   * Match history PDF.
   * data = {
   *   sessionName, dateLabel, courts, matchType, players,
   *   history: [{ number, time, court, team1, team2, winner, score, manual }],  // oldest first
   *   sponsorUrl, logoUrl, watermarkUrl
   * }
   * options.save (default true): download the file. If false, just return the doc.
   */
  async function generate(data, options = {}) {
    const { doc, W, H, M, y: startY, docTitle, drawWatermark } = await startDocument(data, 'Pickleball Match History');
    let y = startY;

    // ---- players: numbered, more columns for more players ----
    // players: [{ name, note, left }] or plain names
    const roster = data.players.map(p => (typeof p === 'string' ? { name: p, note: '', left: false } : p));
    const n = roster.length;
    const leftCount = roster.filter(p => p.left).length;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11.5);
    doc.setTextColor(...TEXT);
    doc.text(`Players (${n}${leftCount ? ` · ${leftCount} left` : ''})`, M, y);

    // Two side-by-side groups of: number, name, and when they started / joined / left
    const groups = 2;
    const rows = Math.ceil(n / groups);
    const groupWidth = (W - 2 * M) / groups;
    const nameWidth = groupWidth * 0.42;
    const playerBody = Array.from({ length: rows }, (_, r) => {
      const row = [];
      for (let g = 0; g < groups; g++) {
        const i = g * rows + r; // fill each group top to bottom
        const p = roster[i];
        row.push(p ? String(i + 1) : '', p ? p.name : '', p ? (p.note || '') : '');
      }
      return row;
    });
    const playerColumnStyles = {};
    for (let g = 0; g < groups; g++) {
      playerColumnStyles[g * 3] = { cellWidth: 8, halign: 'right', fontStyle: 'bold', fontSize: 7.5, textColor: PLUM };
      playerColumnStyles[g * 3 + 1] = { cellWidth: nameWidth };
      playerColumnStyles[g * 3 + 2] = { cellWidth: groupWidth - 8 - nameWidth, fontSize: 7.5, textColor: MUTED };
    }
    doc.autoTable({
      startY: y + 2.5,
      body: playerBody,
      theme: 'plain',
      margin: { left: M, right: M, top: M },
      styles: {
        font: 'helvetica', fontSize: 9.5, textColor: TEXT, valign: 'middle',
        cellPadding: { top: 1.4, bottom: 1.4, left: 1.2, right: 2 },
        lineColor: LINE, lineWidth: { bottom: 0.15 },
      },
      columnStyles: playerColumnStyles,
      didParseCell: cell => {
        const group = Math.floor(cell.column.index / 3);
        const p = roster[group * rows + cell.row.index];
        if (!p) { cell.cell.styles.lineWidth = 0; return; } // empty slot in the last row
        if (p.left && cell.column.index % 3 === 1) {
          cell.cell.styles.textColor = MUTED;
          cell.cell.styles.fontStyle = 'italic';
        }
      },
      willDrawPage: drawWatermark,
    });

    // ---- match history ----
    y = doc.lastAutoTable.finalY + 10;
    if (y > H - M - 25) {
      doc.addPage();
      drawWatermark();
      y = M + 6;
    }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11.5);
    doc.setTextColor(...TEXT);
    doc.text(`Match History (${data.history.length})`, M, y);

    const historyBody = data.history.length
      ? data.history.map(h => [
        String(h.number),
        h.manual ? `${h.time}\nAdjusted` : h.time,
        String(h.court),
        h.team1,
        h.team2,
        h.winner === 'team1' ? h.team1 : h.team2,
        h.score || 'Not recorded',
      ])
      : [[{ content: 'No matches completed yet.', colSpan: 7, styles: { halign: 'center', fontStyle: 'italic', textColor: MUTED } }]];

    doc.autoTable({
      startY: y + 2.5,
      head: [['#', 'Time', 'Court', 'Team 1', 'Team 2', 'Winner', 'Score']],
      body: historyBody,
      theme: 'plain',
      showHead: 'everyPage',
      margin: { left: M, right: M, top: M },
      styles: {
        font: 'helvetica', fontSize: 9, textColor: TEXT, valign: 'middle',
        cellPadding: { top: 2, bottom: 2, left: 1.5, right: 1.5 },
        lineColor: LINE, lineWidth: { bottom: 0.15 },
      },
      headStyles: {
        fontStyle: 'bold', fontSize: 7.5, textColor: MUTED,
        lineColor: TEXT, lineWidth: { bottom: 0.4 },
      },
      columnStyles: {
        0: { cellWidth: 9, fontStyle: 'bold', textColor: PLUM },
        1: { cellWidth: 20, textColor: MUTED },
        2: { cellWidth: 13, halign: 'center' },
        6: { cellWidth: 22, halign: 'right', fontStyle: 'bold' },
      },
      didParseCell: cell => {
        if (cell.section === 'head') {
          if (cell.column.index === 2) cell.cell.styles.halign = 'center';
          if (cell.column.index === 6) cell.cell.styles.halign = 'right';
          return;
        }
        const h = data.history[cell.row.index];
        if (!h) return;
        const col = cell.column.index;
        if (col === 3 || col === 4) {
          const won = (col === 3) === (h.winner === 'team1');
          cell.cell.styles.fontStyle = won ? 'bold' : 'normal';
          cell.cell.styles.textColor = won ? TEXT : MUTED;
        } else if (col === 5) {
          cell.cell.styles.fontStyle = 'bold';
          cell.cell.styles.textColor = PLUM;
        } else if (col === 6 && !h.score) {
          cell.cell.styles.fontStyle = 'normal';
          cell.cell.styles.fontSize = 7.5;
          cell.cell.styles.textColor = MUTED;
        } else if (col === 1 && h.manual) {
          cell.cell.styles.textColor = AMBER;
        }
      },
      willDrawPage: drawWatermark,
    });

    saveDocument(doc, docTitle, options);
    return doc;
  }

  /**
   * Player statistics PDF.
   * data = {
   *   sessionName, dateLabel, courts, matchType, matches, hasScores,
   *   stats: [{ name, games, wins, losses, winRate, winRatePct, ptsFor, ptsAgainst, left, note }],
   *   sponsorUrl, logoUrl, watermarkUrl
   * }
   * Rows come in the order they should be printed. winRatePct is a number, or null if no games.
   */
  async function generateStats(data, options = {}) {
    const { doc, W, M, y, docTitle, drawWatermark } = await startDocument(data, 'Pickleball Player Statistics');

    const n = data.stats.length;
    const leftCount = data.stats.filter(s => s.left).length;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11.5);
    doc.setTextColor(...TEXT);
    doc.text(`Players (${n}${leftCount ? ` · ${leftCount} left` : ''})`, M, y);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(...MUTED);
    doc.text(`${data.matches} match${data.matches === 1 ? '' : 'es'} played`, W - M, y, { align: 'right' });

    const head = ['#', 'Player', 'Games', 'Wins', 'Losses', 'Win Rate'];
    if (data.hasScores) head.push('Pts For', 'Pts Against');
    // The player cell is drawn by hand below (name, with when they started/joined/left underneath)
    const body = data.stats.map((s, i) => {
      const row = [String(i + 1), { content: '', styles: { minCellHeight: s.note ? 10 : 7.5 } }, String(s.games), String(s.wins), String(s.losses), s.winRate];
      if (data.hasScores) row.push(String(s.ptsFor), String(s.ptsAgainst));
      return row;
    });

    const numeric = {};
    for (let c = 2; c < head.length; c++) numeric[c] = { halign: 'right', cellWidth: c >= 6 ? 24 : 18 };
    doc.autoTable({
      startY: y + 2.5,
      head: [head],
      body,
      theme: 'plain',
      showHead: 'everyPage',
      margin: { left: M, right: M, top: M },
      styles: {
        font: 'helvetica', fontSize: 9.5, textColor: TEXT, valign: 'middle', overflow: 'ellipsize',
        cellPadding: { top: 2, bottom: 2, left: 1.5, right: 1.5 },
        lineColor: LINE, lineWidth: { bottom: 0.15 },
      },
      headStyles: {
        fontStyle: 'bold', fontSize: 7.5, textColor: MUTED,
        lineColor: TEXT, lineWidth: { bottom: 0.4 },
      },
      columnStyles: Object.assign({ 0: { cellWidth: 9, fontStyle: 'bold', textColor: PLUM }, 1: { fontStyle: 'bold' } }, numeric),
      didParseCell: cell => {
        if (cell.section === 'head') {
          if (cell.column.index >= 2) cell.cell.styles.halign = 'right';
          return;
        }
        const s = data.stats[cell.row.index];
        if (!s) return;
        const col = cell.column.index;
        if (col === 5) {
          cell.cell.styles.fontStyle = 'bold';
          cell.cell.styles.textColor = s.winRatePct == null ? MUTED : (s.winRatePct >= 50 ? PLUM : TEXT);
        } else if (col >= 6 && String(cell.cell.raw) === '—') {
          cell.cell.styles.textColor = MUTED;
        }
      },
      didDrawCell: cell => {
        if (cell.section !== 'body' || cell.column.index !== 1) return;
        const s = data.stats[cell.row.index];
        if (!s) return;
        const x = cell.cell.x + 1.5;
        const maxWidth = cell.cell.width - 3;
        const fit = (text) => {
          let t = String(text);
          while (t.length > 1 && doc.getTextWidth(t) > maxWidth) t = t.slice(0, -2) + '…';
          return t;
        };
        doc.setFont('helvetica', s.left ? 'italic' : 'bold');
        doc.setFontSize(9.5);
        doc.setTextColor(...(s.left ? MUTED : TEXT));
        doc.text(fit(s.name), x, s.note ? cell.cell.y + 4.6 : cell.cell.y + cell.cell.height / 2 + 1.2);
        if (s.note) {
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(7);
          doc.setTextColor(...MUTED);
          doc.text(fit(s.note), x, cell.cell.y + 8);
        }
      },
      willDrawPage: drawWatermark,
    });

    saveDocument(doc, docTitle, options);
    return doc;
  }

  return { generate, generateStats, loadLibs, playerColumns };
})();
